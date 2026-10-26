// Cover picker: a box-art game menu inside the GBC core.
//
// Reads a cover pack (covers.bin, data slot COVER_SLOT, deferload) through core-initiated data slot reads, shows one
// cover at a time at the GB's 160x144 resolution, and on A opens the chosen ROM into the cartridge slot with APF
// command 0x0192, pulls it into the cartridge bridge range with 0x0180 and resets the core.
//
// covers.bin (little-endian): 16-byte header "GBCV" ver u16, count u16, cover_w u16, cover_h u16, 4 pad;
// count x 128-byte entries: title char[44], size u32, path char[80]; then count x (cover_w*cover_h*2) RGB565 images.
// The header and entries are pulled into BRIDGE_PACK + 0x0000.., the current image into BRIDGE_PACK + 0x10000.
// Both arrive through a data_loader (16-bit words, low byte = lower address).
module cover_picker #(
    parameter COVER_W      = 96,
    parameter COVER_H      = 96,
    parameter MAX_ENTRIES  = 32,
    parameter COVER_SLOT   = 16'd100,
    parameter CART_SLOT    = 16'd1,
    parameter [31:0] BRIDGE_PACK = 32'h30000000,
    parameter [31:0] BRIDGE_CART = 32'h10000000,
    parameter [31:0] PARAM_ADDR  = 32'hF3000000
) (
    input  wire        clk_74a,
    input  wire        enable,           // menu feature on (setting)
    input  wire        core_ready,       // high once APF finished the initial loads and the core runs
    input  wire [31:0] cont1_key,        // APF controller word (clk_74a domain)

    // cover pack bytes from a data_loader on BRIDGE_PACK (clk_74a domain)
    input  wire        pack_wr,
    input  wire [27:0] pack_addr,
    input  wire [15:0] pack_data,

    // core-initiated APF commands (core_bridge_cmd)
    output reg         target_dataslot_read,
    output reg         target_dataslot_openfile,
    output reg  [15:0] target_dataslot_id,
    output reg  [31:0] target_dataslot_slotoffset,
    output reg  [31:0] target_dataslot_bridgeaddr,
    output reg  [31:0] target_dataslot_length,
    input  wire        target_dataslot_done,
    input  wire [2:0]  target_dataslot_err,

    // host reads of the 0x0192 parameter struct at PARAM_ADDR
    input  wire        bridge_rd,
    input  wire [31:0] bridge_addr,
    input  wire        bridge_endian_little,
    output reg  [31:0] param_rd_data,

    output reg         menu_active = 0,  // overlay the menu on the video output
    output reg         picker_download = 0, // route bridge writes in the cartridge range into SDRAM
    output reg         picker_reset = 0, // one-cycle pulse: reset the core after a ROM load

    // video (clk_vid domain): one pixel per clock while de is high
    input  wire        clk_vid,
    input  wire        de,
    input  wire        hs,
    input  wire        vs,
    output reg  [23:0] menu_rgb,
    output wire        menu_on
);

localparam PIX        = COVER_W * COVER_H;          // 8-bit palette indices per cover
localparam IDX_WORDS  = PIX / 2;                    // two indices per 16-bit word
localparam IMG_BYTES  = 512 + PIX;                  // 256 x RGB565 palette, then indices
localparam ENT_WORDS  = 8 + 64 * MAX_ENTRIES;       // header + entries, 16-bit words
localparam IMG_OFFSET = 28'h0010000;                // bridge byte offset of the image region

// ------------------------------------------------------------------ pack memories (written by the loader)
reg [15:0] ent_ram [0:ENT_WORDS-1];
reg [15:0] idx_ram [0:IDX_WORDS-1];
reg [15:0] pal_ram [0:255];

wire pack_is_img = pack_addr[27:16] != 0;
always @(posedge clk_74a) begin
    if (pack_wr) begin
        if (pack_is_img) begin
            if (pack_addr[15:9] == 0) pal_ram[pack_addr[8:1]] <= pack_data;
            else if (pack_addr[15:0] - 16'h200 < PIX) idx_ram[(pack_addr[15:0] - 16'h200) >> 1] <= pack_data;
        end else begin
            if (pack_addr[15:1] < ENT_WORDS) ent_ram[pack_addr[15:1]] <= pack_data;
        end
    end
end

// entries read port (clk_74a)
reg  [11:0] ent_raddr = 0;
reg  [15:0] ent_q;
always @(posedge clk_74a) ent_q <= ent_ram[ent_raddr];

// title buffer for the overlay (written here, read in clk_vid)
reg [15:0] title_ram [0:21];
reg  [4:0] title_waddr_w = 0;
reg        title_we = 0;
always @(posedge clk_74a) if (title_we) title_ram[title_waddr_w] <= ent_q;


// ------------------------------------------------------------------ parameter struct (0x108 bytes, host-readable)
// stored as 66 words in bridge byte order (big-endian unless bridge_endian_little)
reg [31:0] param_ram [0:65];
reg  [6:0] param_waddr = 0;
reg [31:0] param_wdata = 0;
reg        param_we = 0;
always @(posedge clk_74a) begin
    if (param_we) param_ram[param_waddr] <= param_wdata;
end
reg [6:0] param_raddr;
always @(posedge clk_74a) begin
    if (bridge_rd) param_raddr <= bridge_addr[8:2];
    param_rd_data <= param_ram[param_raddr];
end

// ------------------------------------------------------------------ buttons (edge detect + repeat)
wire btn_left   = cont1_key[2];
wire btn_right  = cont1_key[3];
wire btn_a      = cont1_key[4];
wire btn_b      = cont1_key[5];
wire btn_select = cont1_key[14];
wire btn_start  = cont1_key[15];

reg [31:0] key_1 = 0;
always @(posedge clk_74a) key_1 <= cont1_key;
wire press_left  = btn_left  & ~key_1[2];
wire press_right = btn_right & ~key_1[3];
wire press_a     = btn_a     & ~key_1[4];
wire press_b     = btn_b     & ~key_1[5];

reg [26:0] hold_cnt = 0;   // select+start held ~1 s (74 MHz) reopens the menu in-game
wire       hold_open = hold_cnt == 27'd74_000_000;
always @(posedge clk_74a) begin
    if (btn_select & btn_start) begin
        if (!hold_open) hold_cnt <= hold_cnt + 1'b1;
    end else hold_cnt <= 0;
end

// ------------------------------------------------------------------ control FSM
localparam [4:0]
    S_BOOT       = 5'd0,  S_HDR_REQ   = 5'd1,  S_HDR_WAIT  = 5'd2,  S_HDR_PARSE = 5'd3,
    S_ENT_REQ    = 5'd4,  S_ENT_WAIT  = 5'd5,  S_IMG_REQ   = 5'd6,  S_IMG_WAIT  = 5'd7,
    S_MENU       = 5'd8,  S_SEL_INIT  = 5'd9,  S_SEL_READ  = 5'd10, S_SEL_PACK  = 5'd11,
    S_SEL_WRITE  = 5'd12, S_SEL_FLAGS = 5'd13, S_OPEN_REQ  = 5'd14, S_OPEN_WAIT = 5'd15,
    S_SIZE_READ  = 5'd16, S_SIZE_LO   = 5'd17, S_SIZE_HI   = 5'd18, S_PULL_REQ  = 5'd19,
    S_PULL_WAIT  = 5'd20, S_RESET     = 5'd21, S_RUN       = 5'd22, S_OFF       = 5'd23,
    S_TITLE_INIT = 5'd24, S_TITLE_READ = 5'd25, S_TITLE_COPY = 5'd26;

reg [4:0]  state = S_BOOT;
reg [26:0] boot_timer = 0;
reg [5:0]  count = 0;      // entries in the pack
reg [5:0]  idx = 0;        // selected entry
reg [31:0] rom_size = 0;
reg [6:0]  copy_i = 0;     // 16-bit words copied for the path (40 words = 80 bytes)
reg [15:0] lo_word = 0;
reg        game_loaded = 0;
reg        done_1 = 0;
wire       done_rise = target_dataslot_done & ~done_1;

// byte offsets inside the pack, derived from count
wire [31:0] entries_bytes = {20'd0, count, 7'd0};             // count * 128
wire [31:0] image0_off    = 32'd16 + entries_bytes;
wire [31:0] image_off     = image0_off + idx * IMG_BYTES;

always @(posedge clk_74a) begin
    done_1                   <= target_dataslot_done;
    target_dataslot_read     <= 0;
    target_dataslot_openfile <= 0;
    picker_reset             <= 0;
    param_we                 <= 0;
    title_we                 <= 0;

    case (state)
    S_BOOT: begin
        menu_active     <= 0;
        picker_download <= 0;
        game_loaded     <= 0;
        idx             <= 0;
        if (!core_ready) boot_timer <= 0;
        else if (boot_timer != 27'd37_000_000) boot_timer <= boot_timer + 1'b1; // ~0.5 s after the core is up
        else state <= enable ? S_HDR_REQ : S_OFF;
    end

    // header: 16 bytes at pack offset 0 -> BRIDGE_PACK + 0
    S_HDR_REQ: begin
        target_dataslot_id         <= COVER_SLOT;
        target_dataslot_slotoffset <= 32'd0;
        target_dataslot_bridgeaddr <= BRIDGE_PACK;
        target_dataslot_length     <= 32'd16;
        target_dataslot_read       <= 1;
        state <= S_HDR_WAIT;
    end
    S_HDR_WAIT: if (done_rise) begin
        if (target_dataslot_err != 0) state <= S_OFF;   // no covers.bin on the card
        else begin ent_raddr <= 12'd3; state <= S_HDR_PARSE; end  // word 3 = count
    end
    S_HDR_PARSE: begin
        // ent_q valid one cycle after ent_raddr; spend this cycle, then latch
        if (copy_i == 0) copy_i <= 1;
        else begin
            copy_i <= 0;
            count  <= (ent_q[15:0] == 0) ? 6'd0 : (ent_q[15:0] > MAX_ENTRIES ? MAX_ENTRIES[5:0] : ent_q[5:0]);
            state  <= (ent_q[15:0] == 0) ? S_OFF : S_ENT_REQ;
        end
    end

    // entries: count*128 bytes at pack offset 16 -> BRIDGE_PACK + 16
    S_ENT_REQ: begin
        target_dataslot_id         <= COVER_SLOT;
        target_dataslot_slotoffset <= 32'd16;
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd16;
        target_dataslot_length     <= entries_bytes;
        target_dataslot_read       <= 1;
        state <= S_ENT_WAIT;
    end
    S_ENT_WAIT: if (done_rise) begin copy_i <= 0; state <= (target_dataslot_err != 0) ? S_OFF : S_TITLE_INIT; end

    // current cover image -> BRIDGE_PACK + IMG_OFFSET
    S_IMG_REQ: begin
        target_dataslot_id         <= COVER_SLOT;
        target_dataslot_slotoffset <= image_off;
        target_dataslot_bridgeaddr <= BRIDGE_PACK + IMG_OFFSET;
        target_dataslot_length     <= IMG_BYTES;
        target_dataslot_read       <= 1;
        state <= S_IMG_WAIT;
    end
    S_IMG_WAIT: if (done_rise) begin
        menu_active <= 1;
        state       <= S_MENU;
    end

    S_MENU: begin
        if (press_right)      begin idx <= (idx == count - 1) ? 6'd0 : idx + 1'b1; copy_i <= 0; state <= S_TITLE_INIT; end
        else if (press_left)  begin idx <= (idx == 0) ? count - 1'b1 : idx - 1'b1; copy_i <= 0; state <= S_TITLE_INIT; end
        else if (press_a)     begin copy_i <= 0; state <= S_SEL_INIT; end
        else if (press_b && game_loaded) begin menu_active <= 0; state <= S_RUN; end
    end

    // copy the 80-byte path (entry bytes 48..127) into param words 0..19, then flags/size = 0
    S_SEL_INIT: begin
        ent_raddr <= 12'd8 + idx * 7'd64 + 7'd24 + copy_i; // entry word 24 = byte 48
        state     <= S_SEL_READ;
    end
    S_SEL_READ: begin                                   // wait for ent_q
        ent_raddr <= ent_raddr + 1'b1;
        state     <= S_SEL_PACK;
    end
    S_SEL_PACK: begin                                   // ent_q = low word (bytes 2k, 2k+1)
        lo_word <= ent_q;
        state   <= S_SEL_WRITE;
    end
    S_SEL_WRITE: begin                                  // ent_q = high word (bytes 2k+2, 2k+3)
        // bytes in file order b0 b1 b2 b3 = lo[7:0] lo[15:8] hi[7:0] hi[15:8]
        param_wdata <= bridge_endian_little ? {ent_q[15:8], ent_q[7:0], lo_word[15:8], lo_word[7:0]}
                                            : {lo_word[7:0], lo_word[15:8], ent_q[7:0], ent_q[15:8]};
        param_waddr <= copy_i[6:1];
        param_we    <= 1;
        copy_i      <= copy_i + 2'd2;
        if (copy_i == 7'd38) begin param_waddr <= 7'd19; state <= S_SEL_FLAGS; copy_i <= 0; end
        else begin ent_raddr <= 12'd8 + idx * 7'd64 + 7'd24 + copy_i + 2'd2; state <= S_SEL_READ; end
    end
    S_SEL_FLAGS: begin                                  // words 20..65 = 0 (flags at 0x100, size at 0x104)
        param_waddr <= 7'd20 + copy_i;
        param_wdata <= 32'd0;
        param_we    <= 1;
        copy_i      <= copy_i + 1'b1;
        if (copy_i == 7'd45) begin copy_i <= 0; state <= S_OPEN_REQ; end
    end
    S_OPEN_REQ: begin
        target_dataslot_id       <= CART_SLOT;
        target_dataslot_openfile <= 1;
        state <= S_OPEN_WAIT;
    end
    S_OPEN_WAIT: if (done_rise) begin
        if (target_dataslot_err != 0) state <= S_MENU;   // file not found etc: stay in the menu
        else begin ent_raddr <= 12'd8 + idx * 7'd64 + 7'd22; state <= S_SIZE_READ; end // entry word 22 = size low
    end
    S_SIZE_READ: begin ent_raddr <= ent_raddr + 1'b1; state <= S_SIZE_LO; end
    S_SIZE_LO:   begin rom_size[15:0]  <= ent_q; state <= S_SIZE_HI; end
    S_SIZE_HI:   begin rom_size[31:16] <= ent_q; state <= S_PULL_REQ; end
    S_PULL_REQ: begin
        picker_download            <= 1;
        target_dataslot_id         <= CART_SLOT;
        target_dataslot_slotoffset <= 32'd0;
        target_dataslot_bridgeaddr <= BRIDGE_CART;
        target_dataslot_length     <= rom_size;
        target_dataslot_read       <= 1;
        state <= S_PULL_WAIT;
    end
    S_PULL_WAIT: if (done_rise) begin
        picker_download <= 0;
        state <= S_RESET;
    end
    S_RESET: begin
        picker_reset <= 1;
        menu_active  <= 0;
        game_loaded  <= 1;
        state <= S_RUN;
    end
    S_RUN: begin
        if (hold_open) begin copy_i <= 0; state <= S_TITLE_INIT; end  // select+start held: back to the menu
    end
    // title: entry words 0..21 -> title_ram (two cycles per word: address, then latch)
    S_TITLE_INIT: begin
        ent_raddr <= 12'd8 + idx * 7'd64 + copy_i;
        state     <= S_TITLE_READ;
    end
    S_TITLE_READ: state <= S_TITLE_COPY;
    S_TITLE_COPY: begin
        title_waddr_w <= copy_i[4:0];
        title_we      <= 1;
        copy_i        <= copy_i + 1'b1;
        if (copy_i == 7'd21) begin copy_i <= 0; state <= S_IMG_REQ; end
        else begin ent_raddr <= 12'd8 + idx * 7'd64 + copy_i + 1'b1; state <= S_TITLE_READ; end
    end
    S_OFF: begin
        menu_active <= 0;
    end
    default: state <= S_BOOT;
    endcase
end

// ------------------------------------------------------------------ video overlay (clk_vid domain)
// Layout at 160x144: cover at (24,4)..(135,115), title row at y 124..131 (up to 17 chars), position row at y 134.
localparam [8:0] CX = 9'd32, CY = 9'd6;
reg  [8:0] px = 0, py = 0; // current pixel position (counted from de/hs/vs)
reg        de_1 = 0, hs_1 = 0, vs_1 = 0;
always @(posedge clk_vid) begin
    de_1 <= de; hs_1 <= hs; vs_1 <= vs;
    if (vs & ~vs_1) py <= 0;
    else if (hs & ~hs_1) begin py <= py + 1'b1; px <= 0; end
    else if (de) px <= px + 1'b1;
    else if (de_1 & ~de) px <= 0;
end

// menu state synchronised into clk_vid
reg [1:0] menu_s = 0;  always @(posedge clk_vid) menu_s <= {menu_s[0], menu_active};
wire menu_v = menu_s[1];
assign menu_on = menu_v;

// All lookups use a 3-pixel lookahead (qx) so the 3-stage pipeline below lands on the current output pixel.
wire [8:0] qx = de ? px + 9'd3 : 9'd2;

// stage 1: index word / title word / shape tests
wire in_cover = (qx >= CX) && (qx < CX + COVER_W) && (py >= CY) && (py < CY + COVER_H);
wire [13:0] pix_n = (py - CY) * COVER_W + (qx - CX);
reg  [15:0] idx_q;  always @(posedge clk_vid) idx_q <= idx_ram[pix_n[13:1]];
reg  in_cover_1 = 0, pix_odd_1 = 0;
always @(posedge clk_vid) begin in_cover_1 <= in_cover; pix_odd_1 <= pix_n[0]; end

localparam [8:0] TX = 9'd12, TY = 9'd112;
wire        in_title = (py >= TY) && (py < TY + 8) && (qx >= TX) && (qx < TX + 8 * 17);
wire [7:0]  tcol     = (qx - TX) >> 3;
wire [2:0]  tbit     = (qx - TX) & 3'd7;
reg  [15:0] title_q;  always @(posedge clk_vid) title_q <= title_ram[tcol[4:1]];
reg         tcol0_1 = 0; reg [2:0] tbit_1 = 0; reg in_title_1 = 0;
always @(posedge clk_vid) begin tcol0_1 <= tcol[0]; tbit_1 <= tbit; in_title_1 <= in_title; end

wire arrow_l = (py >= 9'd44) && (py < 9'd60) && (qx >= 9'd8)   && (qx < 9'd16)  && ((qx - 9'd8)  >= ((py < 9'd52) ? (9'd52 - py) : (py - 9'd51)));
wire arrow_r = (py >= 9'd44) && (py < 9'd60) && (qx >= 9'd144) && (qx < 9'd152) && ((9'd151 - qx) >= ((py < 9'd52) ? (9'd52 - py) : (py - 9'd51)));
reg  arrow_1 = 0; always @(posedge clk_vid) arrow_1 <= arrow_l | arrow_r;

// stage 2: palette lookup / glyph row
wire [7:0]  pidx  = pix_odd_1 ? idx_q[15:8] : idx_q[7:0];
reg  [15:0] pal_q;  always @(posedge clk_vid) pal_q <= pal_ram[pidx];
wire [7:0]  tchar = tcol0_1 ? title_q[15:8] : title_q[7:0];
wire [7:0]  glyph;
font8x8_rom font (.clk(clk_vid), .addr({tchar[6:0], py[2:0] - TY[2:0]}), .q(glyph));
reg  in_cover_2 = 0, in_title_2 = 0, arrow_2 = 0; reg [2:0] tbit_2 = 0; reg [7:0] tchar_2 = 0;
always @(posedge clk_vid) begin
    in_cover_2 <= in_cover_1; in_title_2 <= in_title_1; arrow_2 <= arrow_1; tbit_2 <= tbit_1; tchar_2 <= tchar;
end
wire title_px = in_title_2 && (tchar_2 >= 8'h20) && (tchar_2 < 8'h7F) && glyph[tbit_2];

// stage 3: output
always @(posedge clk_vid) begin
    if (!menu_v)         menu_rgb <= 24'h000000;
    else if (in_cover_2) menu_rgb <= {pal_q[15:11], pal_q[15:13], pal_q[10:5], pal_q[10:9], pal_q[4:0], pal_q[4:2]};
    else if (title_px || arrow_2) menu_rgb <= 24'hF0F0F0;
    else                 menu_rgb <= 24'h101418;
end

endmodule
