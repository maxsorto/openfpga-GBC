// Cover picker: a cover-flow game menu inside the GBC core.
//
// Reads covers.bin (format v4, see tools/make_cover_pack.py) from data slot COVER_SLOT with core-initiated data
// slot reads, shows the selected cover (64x64) between previews of the previous and next game (40x40, dimmed) with
// floor reflections, a proportional title (marquee when long), the platform under it, and page dots. Left/Right
// browse (hold to repeat), A loads the game: APF 0x0192 opens the ROM into the cartridge slot, a data slot read
// streams it into cartridge memory and the core is reset. Holding Select+Start for a second reopens the menu.
//
// Bridge regions of the pack loader (BRIDGE_PACK + region << 16, 16-bit words, low byte = lower address):
//   0 header + entries   1 center palette (0x000..0x1FF) + center indices   2 preview palette
//   3 left preview       4 right preview
module cover_picker #(
    parameter MAX_ENTRIES = 31,
    parameter COVER_SLOT  = 16'd100,
    parameter CART_SLOT   = 16'd1,
    parameter [31:0] BRIDGE_PACK = 32'h30000000,
    parameter [31:0] BRIDGE_CART = 32'h10000000,
    parameter [31:0] PARAM_ADDR  = 32'hF3000000
) (
    input  wire        clk_74a,
    input  wire        enable,
    input  wire        core_ready,
    input  wire [31:0] cont1_key,

    input  wire        pack_wr,
    input  wire [27:0] pack_addr,
    input  wire [15:0] pack_data,

    output reg         target_dataslot_read = 0,
    output reg         target_dataslot_openfile = 0,
    output reg  [15:0] target_dataslot_id = 0,
    output reg  [31:0] target_dataslot_slotoffset = 0,
    output reg  [31:0] target_dataslot_bridgeaddr = 0,
    output reg  [31:0] target_dataslot_length = 0,
    input  wire        target_dataslot_done,
    input  wire [2:0]  target_dataslot_err,

    input  wire        bridge_rd,
    input  wire [31:0] bridge_addr,
    input  wire        bridge_endian_little,
    output reg  [31:0] param_rd_data,

    output reg         menu_active = 0,
    output reg         picker_download = 0,
    output reg         picker_reset = 0,

    input  wire        clk_vid,
    input  wire        de,
    input  wire        hs,
    input  wire        vs,
    output reg  [23:0] menu_rgb,
    output wire        menu_on
);

localparam CW = 64, TW = 40;
localparam [31:0] CEN_BYTES  = 512 + CW * CW;          // palette + indices
localparam [31:0] BLOB_BYTES = CEN_BYTES + TW * TW;    // 6208
localparam [31:0] TPAL_OFF   = 16, ENT_OFF = 528;

// ================================================================== pack memories (clk_74a writes)
wire [3:0]  region  = pack_addr[19:16];
wire [15:0] roff    = pack_addr[15:0];
wire [15:0] cen_off = roff - 16'h200;

wire        ent_we = pack_wr && region == 0 && roff[15:12] == 0;
wire        pal_we = pack_wr && ((region == 1 && roff[15:9] == 0) || region == 2);
wire [8:0]  pal_wa = {region == 2, roff[8:1]};
wire        cen_we = pack_wr && region == 1 && roff[15:9] != 0 && cen_off < CW * CW;
wire        thm_we = pack_wr && (region == 3 || region == 4) && roff < TW * TW;
wire [10:0] thm_wa = (region == 4 ? 11'd800 : 11'd0) + roff[10:1];

reg  [10:0] ent_raddr = 0;
wire [15:0] ent_q;
picker_dpram #(.WIDTH(16), .ADDR(11)) ent_ram (
    .wclk(clk_74a), .we(ent_we), .waddr(roff[11:1]), .wdata(pack_data),
    .rclk(clk_74a), .raddr(ent_raddr), .q(ent_q));

// text layout map, written by the FSM, read by the renderer: {valid, char[6:0], col[2:0]}; line 1 at 0, line 2 at 256
reg         map_we = 0;
reg  [8:0]  map_wa = 0;
reg  [10:0] map_wd = 0;
wire [8:0]  map_ra;
wire [15:0] map_q;
picker_dpram #(.WIDTH(16), .ADDR(9)) map_ram (
    .wclk(clk_74a), .we(map_we), .waddr(map_wa), .wdata({5'd0, map_wd}),
    .rclk(clk_vid), .raddr(map_ra), .q(map_q));

// glyph widths for layout
reg [3:0] wrom [0:127];
initial $readmemh("font5x7_width.hex", wrom);

// ================================================================== 0x0192 parameter struct
reg  [6:0]  param_waddr = 0;
reg  [31:0] param_wdata = 0;
reg         param_we = 0;
wire [31:0] param_q;
picker_dpram #(.WIDTH(32), .ADDR(7), .DEPTH(66)) param_ram (
    .wclk(clk_74a), .we(param_we), .waddr(param_waddr), .wdata(param_wdata),
    .rclk(clk_74a), .raddr(bridge_addr[8:2]), .q(param_q));
always @(posedge clk_74a) param_rd_data <= param_q;

// ================================================================== frame tick (vsync into clk_74a)
reg [2:0] vs_s = 0;
always @(posedge clk_74a) vs_s <= {vs_s[1:0], vs};
wire frame_tick = vs_s[1] & ~vs_s[2];

// fade: level 0..8, rises one step a frame, falls two
reg [3:0] level = 0, level_target = 0;
always @(posedge clk_74a) if (frame_tick) begin
    if (level < level_target) level <= level + 1'b1;
    else if (level > level_target) level <= (level >= 2) ? level - 2'd2 : 4'd0;
end

// ================================================================== buttons
wire btn_left = cont1_key[2], btn_right = cont1_key[3], btn_a = cont1_key[4];
wire btn_select = cont1_key[14], btn_start = cont1_key[15];
reg [31:0] key_1 = 0;
always @(posedge clk_74a) key_1 <= cont1_key;
wire press_a = btn_a & ~key_1[4];

reg [26:0] hold_cnt = 0;
wire hold_open = hold_cnt == 27'd74_000_000;
always @(posedge clk_74a) begin
    if (btn_select & btn_start) begin if (!hold_open) hold_cnt <= hold_cnt + 1'b1; end
    else hold_cnt <= 0;
end

// left/right with hold-to-repeat: first step on press, then every 5 frames after 20 frames
reg [5:0] rep = 0;
reg       step_l = 0, step_r = 0;
always @(posedge clk_74a) begin
    step_l <= 0; step_r <= 0;
    if (btn_left & ~key_1[2]) begin step_l <= 1; rep <= 0; end
    else if (btn_right & ~key_1[3]) begin step_r <= 1; rep <= 0; end
    else if ((btn_left | btn_right) && frame_tick) begin
        if (rep == 6'd24) begin rep <= 6'd19; step_l <= btn_left; step_r <= btn_right & ~btn_left; end
        else rep <= rep + 1'b1;
    end
end

// ================================================================== control FSM
localparam [5:0]
    S_BOOT = 0, S_HDR_REQ = 1, S_HDR_WAIT = 2, S_HDR_A = 3, S_HDR_B = 4, S_TPAL_REQ = 5, S_TPAL_WAIT = 6,
    S_ENT_REQ = 7, S_ENT_WAIT = 8, S_LOAD = 9, S_MAP_FETCH = 10, S_MAP_WAIT = 11, S_MAP_WAIT2 = 12, S_MAP_CHAR = 13,
    S_MAP_COL = 14, S_MAP_GAP = 15, S_MAP_DONE = 16, S_CEN_REQ = 17, S_CEN_WAIT = 18, S_TL_REQ = 19, S_TL_WAIT = 20,
    S_TR_REQ = 21, S_TR_WAIT = 22, S_MENU = 23, S_FADE = 24, S_SEL_INIT = 25, S_SEL_READ = 26, S_SEL_PACK = 27,
    S_SEL_WRITE = 28, S_SEL_FLAGS = 29, S_OPEN_REQ = 30, S_OPEN_WAIT = 31, S_SIZE_READ = 32, S_SIZE_LO = 33,
    S_SIZE_HI = 34, S_PULL_REQ = 35, S_PULL_WAIT = 36, S_RESET = 37, S_RUN = 38, S_OFF = 39, S_LAUNCH_FADE = 40;

reg  [5:0]  state = S_BOOT;
reg  [26:0] boot_timer = 0;
reg  [4:0]  count = 0, idx = 0;
reg  [31:0] rom_size = 0;
reg  [6:0]  copy_i = 0;
reg  [15:0] lo_word = 0;
reg         game_loaded = 0, done_1 = 0;
reg  [5:0]  k = 0;                 // character index while laying out text
reg         line2 = 0;             // laying out line 2 (platform) instead of the title
reg  [7:0]  ch = 0;
reg  [3:0]  gw = 0, col = 0;
reg  [8:0]  mp = 0;
reg  [7:0]  title_w = 0, sub_w = 0;
reg         is_gb = 0;
reg         gen = 0;               // toggles on every new selection (marquee restart)
wire        done_rise = target_dataslot_done & ~done_1;

wire [10:0] ebase = 11'd8 + {idx, 6'd0};
wire [4:0]  prev = (idx == 0) ? count - 1'b1 : idx - 1'b1;
wire [4:0]  next = (idx == count - 1'b1) ? 5'd0 : idx + 1'b1;
wire [31:0] blob0 = ENT_OFF + {20'd0, count, 7'd0};
function [31:0] blob(input [4:0] i); blob = blob0 + i * BLOB_BYTES; endfunction

// platform line, character j
function [7:0] plat_char(input gb, input [5:0] j);
    reg [111:0] s;
    begin
        s = gb ? {"GAME BOY", 48'd0} : "GAME BOY COLOR";
        plat_char = (j < (gb ? 8 : 14)) ? s[111 - j * 8 -: 8] : 8'd0;
    end
endfunction

always @(posedge clk_74a) begin
    done_1                   <= target_dataslot_done;
    target_dataslot_read     <= 0;
    target_dataslot_openfile <= 0;
    picker_reset             <= 0;
    param_we                 <= 0;
    map_we                   <= 0;

    case (state)
    S_BOOT: begin
        menu_active <= 0; picker_download <= 0; game_loaded <= 0; idx <= 0; level_target <= 0;
        if (!core_ready) boot_timer <= 0;
        else if (boot_timer != 27'd37_000_000) boot_timer <= boot_timer + 1'b1;
        else state <= enable ? S_HDR_REQ : S_OFF;
    end

    S_HDR_REQ: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= 32'd0;
        target_dataslot_bridgeaddr <= BRIDGE_PACK; target_dataslot_length <= 32'd16;
        target_dataslot_read <= 1; state <= S_HDR_WAIT;
    end
    S_HDR_WAIT: if (done_rise) begin
        if (target_dataslot_err != 0) state <= S_OFF;
        else begin ent_raddr <= 11'd3; state <= S_HDR_A; end
    end
    S_HDR_A: state <= S_HDR_B;
    S_HDR_B: begin
        count <= (ent_q == 0) ? 5'd0 : (ent_q > MAX_ENTRIES ? MAX_ENTRIES[4:0] : ent_q[4:0]);
        state <= (ent_q == 0) ? S_OFF : S_TPAL_REQ;
    end
    S_TPAL_REQ: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= TPAL_OFF;
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'h20000; target_dataslot_length <= 32'd512;
        target_dataslot_read <= 1; state <= S_TPAL_WAIT;
    end
    S_TPAL_WAIT: if (done_rise) state <= (target_dataslot_err != 0) ? S_OFF : S_ENT_REQ;
    S_ENT_REQ: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= ENT_OFF;
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd16; target_dataslot_length <= {20'd0, count, 7'd0};
        target_dataslot_read <= 1; state <= S_ENT_WAIT;
    end
    S_ENT_WAIT: if (done_rise) state <= (target_dataslot_err != 0) ? S_OFF : S_LOAD;

    // ---- load the selection: lay out the title and platform, then pull the three images
    S_LOAD: begin
        k <= 0; line2 <= 0; mp <= 9'd0; state <= S_MAP_FETCH;
        ent_raddr <= ebase + 11'd20; // flags byte (byte 40) for the platform line
    end
    S_MAP_FETCH: begin
        if (line2) state <= S_MAP_CHAR;
        else begin ent_raddr <= ebase + k[5:1]; state <= S_MAP_WAIT; end
        if (k == 0 && !line2) is_gb <= ent_q[0];   // ent_q holds word 20 here (set in S_LOAD / S_MAP_DONE)
    end
    S_MAP_WAIT:  state <= S_MAP_WAIT2;
    S_MAP_WAIT2: state <= S_MAP_CHAR;
    S_MAP_CHAR: begin
        ch = line2 ? plat_char(is_gb, k) : (k[0] ? ent_q[15:8] : ent_q[7:0]);
        gw = wrom[ch[6:0]];
        if (ch == 0 || k == (line2 ? 6'd14 : 6'd40) || mp[7:0] >= 8'd250) state <= S_MAP_DONE;
        else if (gw == 0) begin k <= k + 1'b1; state <= S_MAP_FETCH; end
        else begin col <= 0; state <= S_MAP_COL; end
    end
    S_MAP_COL: begin
        map_we <= 1; map_wa <= mp; map_wd <= {1'b1, ch[6:0], col[2:0]};
        mp <= mp + 1'b1; col <= col + 1'b1;
        if (col + 1'b1 == gw) state <= S_MAP_GAP;
    end
    S_MAP_GAP: begin
        map_we <= 1; map_wa <= mp; map_wd <= {1'b1, ch[6:0], 3'd7};   // blank column between glyphs
        mp <= mp + 1'b1; k <= k + 1'b1; state <= S_MAP_FETCH;
    end
    S_MAP_DONE: begin
        if (!line2) begin
            title_w <= (mp[7:0] == 0) ? 8'd0 : mp[7:0] - 1'b1;   // drop the trailing gap
            line2 <= 1; k <= 0; mp <= 9'd256; state <= S_MAP_FETCH;
        end else begin
            sub_w <= (mp[7:0] == 0) ? 8'd0 : mp[7:0] - 1'b1;
            state <= S_CEN_REQ;
        end
    end
    S_CEN_REQ: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= blob(idx);
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'h10000; target_dataslot_length <= CEN_BYTES;
        target_dataslot_read <= 1; state <= S_CEN_WAIT;
    end
    S_CEN_WAIT: if (done_rise) state <= (count > 1) ? S_TL_REQ : S_MENU;
    S_TL_REQ: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= blob(prev) + CEN_BYTES;
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'h30000; target_dataslot_length <= TW * TW;
        target_dataslot_read <= 1; state <= S_TL_WAIT;
    end
    S_TL_WAIT: if (done_rise) state <= S_TR_REQ;
    S_TR_REQ: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= blob(next) + CEN_BYTES;
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'h40000; target_dataslot_length <= TW * TW;
        target_dataslot_read <= 1; state <= S_TR_WAIT;
    end
    S_TR_WAIT: if (done_rise) begin gen <= ~gen; menu_active <= 1; level_target <= 4'd8; state <= S_MENU; end

    S_MENU: begin
        if (!menu_active) begin gen <= ~gen; menu_active <= 1; level_target <= 4'd8; end  // single-entry packs
        if (step_r && count > 1)      begin idx <= next; level_target <= 0; state <= S_FADE; end
        else if (step_l && count > 1) begin idx <= prev; level_target <= 0; state <= S_FADE; end
        else if (press_a)             begin level_target <= 0; state <= S_LAUNCH_FADE; end
    end
    S_FADE: if (level == 0) begin ent_raddr <= ebase + 11'd20; state <= S_LOAD; end
    S_LAUNCH_FADE: if (level == 0) begin copy_i <= 0; state <= S_SEL_INIT; end

    // ---- launch: copy the 80-byte path (entry bytes 48..127) into the 0x0192 struct, then flags/size = 0
    S_SEL_INIT: begin ent_raddr <= ebase + 11'd24 + copy_i; state <= S_SEL_READ; end
    S_SEL_READ: begin ent_raddr <= ent_raddr + 1'b1; state <= S_SEL_PACK; end
    S_SEL_PACK: begin lo_word <= ent_q; state <= S_SEL_WRITE; end
    S_SEL_WRITE: begin
        param_wdata <= bridge_endian_little ? {ent_q[15:8], ent_q[7:0], lo_word[15:8], lo_word[7:0]}
                                            : {lo_word[7:0], lo_word[15:8], ent_q[7:0], ent_q[15:8]};
        param_waddr <= copy_i[6:1]; param_we <= 1; copy_i <= copy_i + 2'd2;
        if (copy_i == 7'd38) begin copy_i <= 0; state <= S_SEL_FLAGS; end
        else begin ent_raddr <= ebase + 11'd24 + copy_i + 2'd2; state <= S_SEL_READ; end
    end
    S_SEL_FLAGS: begin
        param_waddr <= 7'd20 + copy_i; param_wdata <= 32'd0; param_we <= 1; copy_i <= copy_i + 1'b1;
        if (copy_i == 7'd45) begin copy_i <= 0; state <= S_OPEN_REQ; end
    end
    S_OPEN_REQ: begin target_dataslot_id <= CART_SLOT; target_dataslot_openfile <= 1; state <= S_OPEN_WAIT; end
    S_OPEN_WAIT: if (done_rise) begin
        if (target_dataslot_err != 0) begin level_target <= 4'd8; state <= S_MENU; end
        else begin ent_raddr <= ebase + 11'd22; state <= S_SIZE_READ; end
    end
    S_SIZE_READ: begin ent_raddr <= ent_raddr + 1'b1; state <= S_SIZE_LO; end
    S_SIZE_LO:   begin rom_size[15:0]  <= ent_q; state <= S_SIZE_HI; end
    S_SIZE_HI:   begin rom_size[31:16] <= ent_q; state <= S_PULL_REQ; end
    S_PULL_REQ: begin
        picker_download <= 1;
        target_dataslot_id <= CART_SLOT; target_dataslot_slotoffset <= 32'd0;
        target_dataslot_bridgeaddr <= BRIDGE_CART; target_dataslot_length <= rom_size;
        target_dataslot_read <= 1; state <= S_PULL_WAIT;
    end
    S_PULL_WAIT: if (done_rise) begin picker_download <= 0; state <= S_RESET; end
    S_RESET: begin picker_reset <= 1; menu_active <= 0; game_loaded <= 1; state <= S_RUN; end
    S_RUN: if (hold_open) begin level_target <= 0; ent_raddr <= ebase + 11'd20; state <= S_LOAD; end
    S_OFF: menu_active <= 0;
    default: state <= S_BOOT;
    endcase
end

// ================================================================== video (clk_vid)
// state into the video clock (values only change while the covers are faded out)
reg [1:0] menu_s = 0; reg [3:0] lvl_s = 0; reg [4:0] idx_s = 0, cnt_s = 0; reg [7:0] tw_s = 0, sw_s = 0; reg [2:0] gen_s = 0;
always @(posedge clk_vid) begin
    menu_s <= {menu_s[0], menu_active}; lvl_s <= level; idx_s <= idx; cnt_s <= count;
    tw_s <= title_w; sw_s <= sub_w; gen_s <= {gen_s[1:0], gen};
end
wire menu_v = menu_s[1];
assign menu_on = menu_v;

// visible pixel position
reg [8:0] px = 0, py = 0; reg de_1 = 0, vs_1 = 0;
always @(posedge clk_vid) begin
    de_1 <= de; vs_1 <= vs;
    if (vs & ~vs_1) py <= 0;
    else if (de_1 & ~de) begin py <= py + 1'b1; px <= 0; end
    else if (de) px <= px + 1'b1;
end

// marquee for long titles: hold 1.5 s, scroll 1 px a frame, wrap with a 24 px gap
reg [8:0] scroll = 0; reg [6:0] mq_hold = 90;
wire [8:0] period = {1'b0, tw_s} + 9'd24;
always @(posedge clk_vid) if (vs & ~vs_1) begin
    if (gen_s[2] != gen_s[1]) begin scroll <= 0; mq_hold <= 7'd90; end
    else if (mq_hold != 0) mq_hold <= mq_hold - 1'b1;
    else if (tw_s > 8'd150) begin
        if (scroll + 1'b1 >= period) begin scroll <= 0; mq_hold <= 7'd90; end
        else scroll <= scroll + 1'b1;
    end
end

// ---- layout (160x144)
localparam [8:0] CX = 48, CY = 16, CR = 14;          // center cover, reflection rows
localparam [8:0] LX = 6, RX = 114, TY = 28, TR = 10;  // previews
localparam [8:0] T1Y = 101, T2Y = 112, DY = 128;

wire [8:0] qx = de ? px + 9'd3 : 9'd2;     // 3-pixel lookahead for the 3-stage pipeline

// ---- stage 1: regions, addresses
wire in_cx = qx >= CX && qx < CX + CW;
wire in_c  = in_cx && py >= CY && py < CY + CW;
wire in_cr = in_cx && py >= CY + CW && py < CY + CW + CR;
wire [5:0] clx = qx - CX;
wire [5:0] cly = in_c ? py - CY : 6'd63 - (py - (CY + CW));
wire in_lx = qx >= LX && qx < LX + TW, in_rx = qx >= RX && qx < RX + TW;
wire in_ty = py >= TY && py < TY + TW, in_tr = py >= TY + TW && py < TY + TW + TR;
wire [5:0] tlx = in_lx ? qx - LX : qx - RX;
wire [5:0] tly = in_ty ? py - TY : 6'd39 - (py - (TY + TW));
wire thumbs_on = cnt_s > 1;
wire in_t  = thumbs_on && (in_lx || in_rx) && in_ty;
wire in_trf = thumbs_on && (in_lx || in_rx) && in_tr;
wire [10:0] tpix = {tly, 5'd0} + {tly, 3'd0} + tlx;    // ty*40 + tx

// rounded corners
function corner(input [5:0] x, input [5:0] y, input [5:0] m, input [1:0] r);
    reg [5:0] ax, ay;
    begin
        ax = (x < 3) ? x : (x > m - 3) ? m - x : 6'd3;
        ay = (y < 3) ? y : (y > m - 3) ? m - y : 6'd3;
        corner = (ax + ay) < r;
    end
endfunction

wire [11:0] cpix = {cly, clx};
wire [10:0] cen_ra = cpix[11:1];
wire [10:0] thm_ra = (in_rx ? 11'd800 : 11'd0) + tpix[10:1];
wire [15:0] cen_q, thm_q;
picker_dpram #(.WIDTH(16), .ADDR(11)) cen_ram (
    .wclk(clk_74a), .we(cen_we), .waddr(cen_off[11:1]), .wdata(pack_data),
    .rclk(clk_vid), .raddr(cen_ra), .q(cen_q));
picker_dpram #(.WIDTH(16), .ADDR(11), .DEPTH(1600)) thm_ram (
    .wclk(clk_74a), .we(thm_we), .waddr(thm_wa), .wdata(pack_data),
    .rclk(clk_vid), .raddr(thm_ra), .q(thm_q));

// text: line 1 centered or marquee, line 2 centered
wire       t1_row = py >= T1Y && py < T1Y + 7, t2_row = py >= T2Y && py < T2Y + 7;
wire [8:0] t1_start = 9'd80 - (tw_s >> 1);
wire [8:0] t2_start = 9'd80 - (sw_s >> 1);
wire       marquee  = tw_s > 8'd150;
wire [8:0] mx0 = qx - 9'd5 + scroll;
wire [8:0] mx  = (mx0 >= period) ? mx0 - period : mx0;
wire [8:0] t1x = marquee ? mx : qx - t1_start;
wire       t1_ok = t1_row && (marquee ? (qx >= 5 && qx < 155) : qx >= t1_start) && t1x < tw_s;
wire [8:0] t2x = qx - t2_start;
wire       t2_ok = t2_row && qx >= t2_start && t2x < sw_s;
assign map_ra = t2_row ? {1'b1, t2x[7:0]} : {1'b0, t1x[7:0]};
wire [2:0] trow = t2_row ? py - T2Y : py - T1Y;

// page dots: 4 px pitch, 2x2 dots, the current one a 4x2 pill
wire [8:0] d_start = 9'd80 - {cnt_s, 1'b0};
wire [8:0] dx = qx - d_start;
wire       d_row = py >= DY && py < DY + 2 && qx >= d_start && dx < {cnt_s, 2'b0};
wire       d_cur = d_row && dx[8:2] == idx_s;
wire       d_dim = d_row && !d_cur && (dx[1:0] == 1 || dx[1:0] == 2);

// background gradient
wire [7:0] bg_r = 8'd30 - py[7:3], bg_g = 8'd36 - py[7:3], bg_b = 8'd54 - py[7:2];

localparam K_NONE = 0, K_C = 1, K_CR = 2, K_T = 3, K_TR = 4;
reg [2:0] k1 = 0; reg cut1 = 0, odd1 = 0, t1_1 = 0, t2_1 = 0, dcur1 = 0, ddim1 = 0; reg [2:0] a1 = 0, trow1 = 0;
reg [7:0] bgr1 = 0, bgg1 = 0, bgb1 = 0;
always @(posedge clk_vid) begin
    k1    <= in_c ? K_C : in_cr ? K_CR : in_t ? K_T : in_trf ? K_TR : K_NONE;
    cut1  <= in_c ? corner(clx, cly, 6'd63, 2'd3) : in_t ? corner(tlx, tly, 6'd39, 2'd2) : 1'b0;
    odd1  <= (in_c || in_cr) ? cpix[0] : tpix[0];
    a1    <= in_cr ? (CR + CY + CW - 1 - py) >> 1 : (TR + TY + TW - 1 - py) >> 1;   // reflection strength
    t1_1  <= t1_ok; t2_1 <= t2_ok; trow1 <= trow;
    dcur1 <= d_cur; ddim1 <= d_dim;
    bgr1 <= bg_r; bgg1 <= bg_g; bgb1 <= bg_b;
end

// ---- stage 2: palette and glyph lookups
wire [7:0]  pidx = (k1 == K_C || k1 == K_CR) ? (odd1 ? cen_q[15:8] : cen_q[7:0]) : (odd1 ? thm_q[15:8] : thm_q[7:0]);
wire [8:0]  pal_ra = {(k1 == K_T || k1 == K_TR), pidx};
wire [15:0] pal_q;
picker_dpram #(.WIDTH(16), .ADDR(9)) pal_ram (
    .wclk(clk_74a), .we(pal_we), .waddr(pal_wa), .wdata(pack_data),
    .rclk(clk_vid), .raddr(pal_ra), .q(pal_q));
wire [7:0] glyph;
font5x7_rom font (.clk(clk_vid), .addr({map_q[9:3], trow1}), .q(glyph));

reg [2:0] k2 = 0, a2 = 0, gcol2 = 0; reg cut2 = 0, t1_2 = 0, t2_2 = 0, gval2 = 0, dcur2 = 0, ddim2 = 0;
reg [7:0] bgr2 = 0, bgg2 = 0, bgb2 = 0;
always @(posedge clk_vid) begin
    k2 <= k1; a2 <= a1; cut2 <= cut1; t1_2 <= t1_1; t2_2 <= t2_1; dcur2 <= dcur1; ddim2 <= ddim1;
    gcol2 <= map_q[2:0]; gval2 <= map_q[10];
    bgr2 <= bgr1; bgg2 <= bgg1; bgb2 <= bgb1;
end

// ---- stage 3: compose
function [7:0] mix(input [7:0] a, input [7:0] b, input [4:0] w);   // a*(16-w)/16 + b*w/16
    reg [12:0] t;
    begin
        t = {5'd0, a} * {8'd0, 5'd16 - w} + {5'd0, b} * {8'd0, w};
        mix = t[11:4];
    end
endfunction

wire [7:0] pr = {pal_q[15:11], pal_q[15:13]}, pg = {pal_q[10:5], pal_q[10:9]}, pb = {pal_q[4:0], pal_q[4:2]};
wire       side = k2 == K_T || k2 == K_TR;
wire [7:0] cr = side ? (pr >> 1) + (pr >> 4) : pr;     // previews at 9/16 brightness
wire [7:0] cg = side ? (pg >> 1) + (pg >> 4) : pg;
wire [7:0] cb = side ? (pb >> 1) + (pb >> 4) : pb;
wire [4:0] lvl2 = {lvl_s, 1'b0};                        // 0..16
wire [4:0] wr   = (k2 == K_C || k2 == K_T) ? 5'd16 : {2'b0, a2};
wire [8:0] wprod = wr * lvl2;
wire [4:0] wc   = wprod[8:4];
wire       glyph_on = gval2 && gcol2 < 3'd5 && glyph[gcol2];

always @(posedge clk_vid) begin
    if (!menu_v)                              menu_rgb <= 24'h000000;
    else if (k2 != K_NONE && !cut2)           menu_rgb <= {mix(bgr2, cr, wc), mix(bgg2, cg, wc), mix(bgb2, cb, wc)};
    else if (t1_2 && glyph_on)                menu_rgb <= {mix(bgr2, 8'd246, lvl2), mix(bgg2, 8'd246, lvl2), mix(bgb2, 8'd250, lvl2)};
    else if (t2_2 && glyph_on)                menu_rgb <= {mix(bgr2, 8'd128, lvl2), mix(bgg2, 8'd140, lvl2), mix(bgb2, 8'd168, lvl2)};
    else if (dcur2)                           menu_rgb <= 24'hE8ECF4;
    else if (ddim2)                           menu_rgb <= 24'h4A5268;
    else                                      menu_rgb <= {bgr2, bgg2, bgb2};
end

endmodule

// 5x7 font ROM (Adafruit GFX glcdfont, BSD), row-major: addr = {char[6:0], row[2:0]}, bit x = column x from the left.
module font5x7_rom (input wire clk, input wire [9:0] addr, output reg [7:0] q);
    reg [7:0] rom [0:1023];
    initial $readmemh("font5x7.hex", rom);
    always @(posedge clk) q <= rom[addr];
endmodule
