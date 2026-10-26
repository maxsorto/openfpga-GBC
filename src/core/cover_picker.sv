// Cover picker: a cover-flow game menu inside the GBC core.
//
// Reads covers.bin (format v4, see tools/make_cover_pack.py) from data slot COVER_SLOT with core-initiated data
// slot reads, shows the selected cover (64x64) between previews of the previous and next game (40x40, dimmed) with
// floor reflections, a proportional title (marquee when long), the platform under it, and page dots. Left/Right
// browse (hold to repeat), A loads the game: APF 0x0192 opens the ROM into the Game slot, a data slot read
// streams it into cartridge memory, the game's .sav is opened into the Save slot and loaded, and the core is reset.
// If a suspend file (.sus) exists the save state is streamed back in and the game resumes where it was left.
// In game, L opens a pause overlay: Resume, or Home (writes the .sav, writes a save state to the .sus, back to the
// menu). File paths come from the pack (v5 path structs) and are read straight into the 0x0192 parameter struct.
//
// Bridge regions of the pack loader (BRIDGE_PACK + region << 16, 16-bit words, low byte = lower address):
//   0 header + entries   1 center palette (0x000..0x1FF) + center indices   2 preview palette
//   3 left preview       4 right preview
module cover_picker #(
    parameter MAX_ENTRIES = 31,
    parameter COVER_SLOT  = 16'd100,
    parameter CART_SLOT   = 16'd101,
    parameter SAVE_SLOT   = 16'd18,
    parameter SUS_SLOT    = 16'd102,
    parameter [31:0] BRIDGE_SAVE  = 32'h20000000,
    parameter [31:0] BRIDGE_STATE = 32'h40000000,
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
    output reg         target_dataslot_write = 0,
    output reg  [15:0] target_dataslot_id = 0,
    output reg  [31:0] target_dataslot_slotoffset = 0,
    output reg  [31:0] target_dataslot_bridgeaddr = 0,
    output reg  [31:0] target_dataslot_length = 0,
    input  wire        target_dataslot_done,
    input  wire [2:0]  target_dataslot_err,

    input  wire        bridge_rd,
    input  wire        bridge_wr,
    input  wire [31:0] bridge_wr_data,
    input  wire [31:0] bridge_addr,
    input  wire        bridge_endian_little,
    output reg  [31:0] param_rd_data,

    output reg         menu_active = 0,
    output reg         picker_download = 0,
    output reg         picker_reset = 0,
    output reg         hold_gb = 1,      // keep the Game Boy in reset: from boot until a game is launched
    output reg         pause_gb = 0,     // freeze the Game Boy (pause overlay)
    output reg         ss_start = 0,     // core-initiated save state / load state (same path the host uses)
    output reg         ss_load = 0,
    input  wire        ss_start_ok,
    input  wire        ss_load_ok,
    input  wire [31:0] sav_bytes,        // battery save size of the loaded cart (0 = none), as reported to the host
    input  wire [31:0] ss_bytes,         // save state size
    output reg         ovl_dim = 0,      // dim the game picture under the pause panel
    output reg         snd_open = 0,     // toggles: pause chime up / down
    output reg         snd_close = 0,

    input  wire        clk_vid,
    input  wire        de,
    input  wire        hs,
    input  wire        vs,
    output reg  [23:0] menu_rgb,
    output reg         menu_on = 0
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
wire        param_bwe = bridge_wr && bridge_addr[31:24] == PARAM_ADDR[31:24];   // path structs land here via 0x0180
picker_dpram #(.WIDTH(32), .ADDR(7)) param_ram (
    .wclk(clk_74a), .we(param_we | param_bwe), .waddr(param_bwe ? bridge_addr[8:2] : param_waddr),
    .wdata(param_bwe ? bridge_wr_data : param_wdata),
    .rclk(clk_74a), .raddr(bridge_addr[8:2]), .q(param_q));
// APF bridge reads lag one transaction: latch on bridge_rd like every stock bridge device
always @(posedge clk_74a) if (bridge_rd) param_rd_data <= param_q;

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
reg [31:0] key_1 = 0;
always @(posedge clk_74a) key_1 <= cont1_key;
wire press_a  = btn_a & ~key_1[4];
wire press_b  = cont1_key[5] & ~key_1[5];
wire press_up = cont1_key[0] & ~key_1[0], press_dn = cont1_key[1] & ~key_1[1];
wire press_l  = cont1_key[8] & ~key_1[8];       // L trigger: pause overlay (R is fast forward)

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
localparam [6:0]
    S_PREAD = 41, S_PREAD_W = 42, S_PFLAGS = 43, S_PSIZE = 44, S_POPEN = 45, S_POPEN_W = 46, S_XFER_W = 47,
    S_L1 = 49, S_SETTLE = 50, S_L3 = 52, S_L4 = 53, S_L5 = 54, S_L6 = 55, S_L7 = 56, S_L8 = 57, S_L9 = 58,
    S_L10 = 59, S_L11 = 60, S_LRUN = 61, S_LFAIL = 62, S_PAUSE = 63, S_H0 = 64, S_H1 = 65, S_H2 = 66, S_H3 = 67,
    S_H4 = 68, S_H5 = 69, S_H6 = 70, S_PROBE1 = 71, S_PROBE2 = 72, S_LOAD2 = 73;
localparam [1:0] PK_ROM = 0, PK_SAV = 1, PK_SUS = 2;

reg  [6:0]  state = S_BOOT, op_ret = S_BOOT;
reg  [1:0]  pk = 0;                // path struct kind for the open subroutine
reg  [31:0] pflags = 0, psize = 0;
reg  [15:0] op_slot = 0;
reg  [2:0]  oerr = 0, xerr = 0;    // result of the last open / transfer
reg  [27:0] tmr = 0;
reg  [31:0] sv = 0, ssz = 0;       // latched save / state sizes of the running game
reg  [31:0] susp = 0, known = 0;   // per game: has a suspend file / probed
reg         lerr = 0;              // last launch failed: show the error on line 2
reg  [7:0]  ecode = 0; reg [2:0] enum_ = 0;
reg         ovl = 0, psel = 0;     // pause overlay, selected option (0 Resume, 1 Home)
reg  [1:0]  pmsg = 0;              // 0 options, 1 saving, 2 error
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
wire [31:0] paths0 = blob0 + count * BLOB_BYTES;
wire [7:0]  pslot   = {1'b0, idx, 1'b0} + {3'd0, idx} + {6'd0, pk};   // idx*3 + kind
wire [31:0] pstruct = paths0 + {16'd0, pslot, 8'd0};

// platform line, character j
// mode 0 Game Boy Color, 1 Game Boy, 2 suspended, 3 launch error
function [7:0] plat_char(input [1:0] m, input [7:0] ec, input [2:0] en, input [5:0] j);
    reg [111:0] s; reg [3:0] n;
    begin
        case (m)
        0: begin s = "GAME BOY COLOR"; n = 14; end
        1: begin s = {"GAME BOY", 48'd0}; n = 8; end
        2: begin s = {"SUSPENDED", 40'd0}; n = 9; end
        default: begin s = {"ERROR ", ec, 8'h30 + en, 48'd0}; n = 8; end
        endcase
        plat_char = (j < n) ? s[111 - j * 8 -: 8] : 8'd0;
    end
endfunction
wire [1:0] pmode = lerr ? 2'd3 : susp[idx] ? 2'd2 : is_gb ? 2'd1 : 2'd0;

always @(posedge clk_74a) begin
    done_1                   <= target_dataslot_done;
    target_dataslot_read     <= 0;
    target_dataslot_openfile <= 0;
    target_dataslot_write    <= 0;
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
        if (!known[idx]) begin pk <= PK_SUS; pflags <= 0; psize <= 0; op_slot <= SUS_SLOT; op_ret <= S_PROBE1; state <= S_PREAD; end
        else state <= S_LOAD2;
    end
    S_PROBE1: if (oerr != 0) begin known[idx] <= 1; susp[idx] <= 0; state <= S_LOAD2; end
              else begin
                  target_dataslot_id <= SUS_SLOT; target_dataslot_slotoffset <= 0;
                  target_dataslot_bridgeaddr <= PARAM_ADDR + 32'h190; target_dataslot_length <= 32'd4;
                  target_dataslot_read <= 1; op_ret <= S_PROBE2; state <= S_XFER_W;
              end
    S_PROBE2: begin known[idx] <= 1; susp[idx] <= (xerr == 0); state <= S_LOAD2; end
    S_LOAD2: begin
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
        ch = line2 ? plat_char(pmode, ecode, enum_, k) : (k[0] ? ent_q[15:8] : ent_q[7:0]);
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
        if (step_r && count > 1)      begin idx <= next; lerr <= 0; level_target <= 0; state <= S_FADE; end
        else if (step_l && count > 1) begin idx <= prev; lerr <= 0; level_target <= 0; state <= S_FADE; end
        else if (press_a)             begin level_target <= 0; state <= S_LAUNCH_FADE; end
    end
    S_FADE: if (level == 0) begin ent_raddr <= ebase + 11'd20; state <= S_LOAD; end

    // ---- subroutine: read path struct pk of game idx into the 0x0192 struct, set flags/size, open it into op_slot
    S_PREAD: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= pstruct;
        target_dataslot_bridgeaddr <= PARAM_ADDR; target_dataslot_length <= 32'd256;
        target_dataslot_read <= 1; state <= S_PREAD_W;
    end
    S_PREAD_W: if (done_rise) begin
        if (target_dataslot_err != 0) begin oerr <= 3'd5; state <= op_ret; end
        else state <= S_PFLAGS;
    end
    S_PFLAGS: begin param_waddr <= 7'd64; param_wdata <= pflags; param_we <= 1; state <= S_PSIZE; end
    S_PSIZE:  begin param_waddr <= 7'd65; param_wdata <= psize;  param_we <= 1; state <= S_POPEN; end
    S_POPEN:  begin target_dataslot_id <= op_slot; target_dataslot_openfile <= 1; state <= S_POPEN_W; end
    S_POPEN_W: if (done_rise) begin oerr <= target_dataslot_err; state <= op_ret; end
    // ---- subroutine tail: wait for a data slot read/write issued by the caller
    S_XFER_W: if (done_rise) begin xerr <= target_dataslot_err; state <= op_ret; end

    // ---- launch: ROM -> cartridge memory, .sav -> cart RAM, reset, then a suspend file (save state) if there is one
    S_LAUNCH_FADE: if (level == 0) begin
        lerr <= 0; pk <= PK_ROM; pflags <= 0; psize <= 0; op_slot <= CART_SLOT; op_ret <= S_L1; state <= S_PREAD;
    end
    S_L1: if (oerr != 0) begin ecode <= "R"; enum_ <= oerr; state <= S_LFAIL; end
          else begin ent_raddr <= ebase + 11'd22; state <= S_SIZE_READ; end
    S_SIZE_READ: begin ent_raddr <= ent_raddr + 1'b1; state <= S_SIZE_LO; end
    S_SIZE_LO:   begin rom_size[15:0]  <= ent_q; state <= S_SIZE_HI; end
    S_SIZE_HI:   begin rom_size[31:16] <= ent_q; state <= S_PULL_REQ; end
    S_PULL_REQ: begin
        picker_download <= 1;
        target_dataslot_id <= CART_SLOT; target_dataslot_slotoffset <= 32'd0;
        target_dataslot_bridgeaddr <= BRIDGE_CART; target_dataslot_length <= rom_size;
        target_dataslot_read <= 1; state <= S_PULL_WAIT;
    end
    S_PULL_WAIT: if (done_rise) begin
        picker_download <= 0;
        if (target_dataslot_err != 0) begin ecode <= "R"; enum_ <= target_dataslot_err; state <= S_LFAIL; end
        else begin tmr <= 0; state <= S_SETTLE; end
    end
    S_SETTLE: begin                                  // let the header-derived sizes settle (1 ms)
        tmr <= tmr + 1'b1;
        if (tmr == 28'd74_000) begin
            sv <= sav_bytes; ssz <= ss_bytes;
            if (sav_bytes == 0) state <= S_L6;
            else begin pk <= PK_SAV; pflags <= 0; psize <= 0; op_slot <= SAVE_SLOT; op_ret <= S_L3; state <= S_PREAD; end
        end
    end
    S_L3: if (oerr == 0) begin
              target_dataslot_id <= SAVE_SLOT; target_dataslot_slotoffset <= 0;
              target_dataslot_bridgeaddr <= BRIDGE_SAVE; target_dataslot_length <= sv;
              target_dataslot_read <= 1; op_ret <= S_L5; state <= S_XFER_W;
          end else if (oerr == 3'd3) begin          // no save yet: create it at the size the core reports
              pflags <= 32'd3; psize <= sv; op_ret <= S_L4; state <= S_PREAD;
          end else begin ecode <= "S"; enum_ <= oerr; state <= S_LFAIL; end
    S_L4: if (oerr <= 3'd1) state <= S_L6; else begin ecode <= "C"; enum_ <= oerr; state <= S_LFAIL; end
    S_L5: if (xerr != 0) begin ecode <= "L"; enum_ <= xerr; state <= S_LFAIL; end else state <= S_L6;
    S_L6: begin picker_reset <= 1; hold_gb <= 0; tmr <= 0; state <= S_L7; end
    S_L7: begin                                      // game running behind the menu backdrop; resume point?
        tmr <= tmr + 1'b1;
        if (tmr == 28'd11_000_000) begin
            if (susp[idx]) begin pk <= PK_SUS; pflags <= 0; psize <= 0; op_slot <= SUS_SLOT; op_ret <= S_L8; state <= S_PREAD; end
            else state <= S_LRUN;
        end
    end
    S_L8: if (oerr != 0) state <= S_LRUN;
          else begin
              target_dataslot_id <= SUS_SLOT; target_dataslot_slotoffset <= 0;
              target_dataslot_bridgeaddr <= BRIDGE_STATE; target_dataslot_length <= ssz;
              target_dataslot_read <= 1; op_ret <= S_L9; state <= S_XFER_W;
          end
    S_L9: if (xerr != 0) state <= S_LRUN; else begin ss_load <= 1; tmr <= 0; state <= S_L10; end
    S_L10: begin
        tmr <= tmr + 1'b1;
        if (tmr == 28'd32) ss_load <= 0;
        if ((tmr > 28'd512 && ss_load_ok) || tmr == 28'd148_000_000) begin
            // consume the resume point: truncate the .sus to 0 bytes
            pk <= PK_SUS; pflags <= 32'd2; psize <= 0; op_slot <= SUS_SLOT; op_ret <= S_L11; state <= S_PREAD;
        end
    end
    S_L11: begin susp[idx] <= 0; state <= S_LRUN; end
    S_LRUN: begin menu_active <= 0; game_loaded <= 1; state <= S_RUN; end
    S_LFAIL: begin picker_download <= 0; hold_gb <= 1; lerr <= 1; ent_raddr <= ebase + 11'd20; state <= S_LOAD2; end

    // ---- in game: L opens the pause overlay
    S_RUN: if (press_l) begin pause_gb <= 1; psel <= 0; pmsg <= 0; ovl <= 1; snd_open <= ~snd_open; state <= S_PAUSE; end
    S_PAUSE: begin
        if (press_up || press_dn) begin psel <= ~psel; pmsg <= 0; end
        else if (press_a && !psel) begin pause_gb <= 0; ovl <= 0; snd_close <= ~snd_close; state <= S_RUN; end
        else if (press_a && psel) begin pmsg <= 2'd1; state <= S_H0; end
        else if (press_b || press_l) begin pause_gb <= 0; ovl <= 0; snd_close <= ~snd_close; state <= S_RUN; end
    end
    // ---- Home: write the .sav, write a save state into the .sus, back to the menu
    S_H0: if (sv != 0) begin pk <= PK_SAV; pflags <= 0; psize <= 0; op_slot <= SAVE_SLOT; op_ret <= S_H1; state <= S_PREAD; end
          else state <= S_H3;
    S_H1: if (oerr != 0) begin ecode <= "S"; enum_ <= oerr; pmsg <= 2'd2; state <= S_PAUSE; end
          else begin
              target_dataslot_id <= SAVE_SLOT; target_dataslot_slotoffset <= 0;
              target_dataslot_bridgeaddr <= BRIDGE_SAVE; target_dataslot_length <= sv;
              target_dataslot_write <= 1; op_ret <= S_H2; state <= S_XFER_W;
          end
    S_H2: if (xerr != 0) begin ecode <= "W"; enum_ <= xerr; pmsg <= 2'd2; state <= S_PAUSE; end else state <= S_H3;
    S_H3: begin pk <= PK_SUS; pflags <= 32'd3; psize <= ssz; op_slot <= SUS_SLOT; op_ret <= S_H4; state <= S_PREAD; end
    S_H4: if (oerr > 3'd1) begin ecode <= "U"; enum_ <= oerr; pmsg <= 2'd2; state <= S_PAUSE; end
          else begin pause_gb <= 0; ss_start <= 1; tmr <= 0; state <= S_H5; end   // the state machine freezes the GB itself
    S_H5: begin
        tmr <= tmr + 1'b1;
        if (tmr == 28'd32) ss_start <= 0;
        if (tmr > 28'd512 && ss_start_ok) begin
            pause_gb <= 1;
            target_dataslot_id <= SUS_SLOT; target_dataslot_slotoffset <= 0;
            target_dataslot_bridgeaddr <= BRIDGE_STATE; target_dataslot_length <= ssz;
            target_dataslot_write <= 1; op_ret <= S_H6; state <= S_XFER_W;
        end else if (tmr == 28'd148_000_000) begin pause_gb <= 1; ecode <= "U"; enum_ <= 3'd7; pmsg <= 2'd2; state <= S_PAUSE; end
    end
    S_H6: if (xerr != 0) begin ecode <= "V"; enum_ <= xerr; pmsg <= 2'd2; state <= S_PAUSE; end
          else begin
              susp[idx] <= 1; known[idx] <= 1; ovl <= 0; pmsg <= 0; pause_gb <= 0; hold_gb <= 1;
              game_loaded <= 0; level_target <= 0; ent_raddr <= ebase + 11'd20; state <= S_LOAD;
          end
    S_OFF: begin menu_active <= 0; hold_gb <= 0; end
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
reg [1:0] ovl_s = 0; reg psel_v = 0; reg [1:0] pmsg_v = 0; reg [7:0] ec_v = 0; reg [2:0] en_v = 0;
always @(posedge clk_vid) begin ovl_s <= {ovl_s[0], ovl}; psel_v <= psel; pmsg_v <= pmsg; ec_v <= ecode; en_v <= enum_; end
wire ovl_v = ovl_s[1];
always @(posedge clk_74a) ovl_dim <= ovl;

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
wire [7:0] mq_lim = ovl_v ? 8'd92 : 8'd150;
always @(posedge clk_vid) if (vs & ~vs_1) begin
    if (gen_s[2] != gen_s[1]) begin scroll <= 0; mq_hold <= 7'd90; end
    else if (mq_hold != 0) mq_hold <= mq_hold - 1'b1;
    else if (tw_s > mq_lim) begin
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
wire [8:0] t1y = ovl_v ? 9'd51 : T1Y;
wire       t1_row = py >= t1y && py < t1y + 7, t2_row = !ovl_v && py >= T2Y && py < T2Y + 7;
wire [8:0] mq_lo = ovl_v ? 9'd34 : 9'd5, mq_hi = ovl_v ? 9'd126 : 9'd155;
wire [8:0] t1_start = 9'd80 - (tw_s >> 1);
wire [8:0] t2_start = 9'd80 - (sw_s >> 1);
wire       marquee  = tw_s > mq_lim;
wire [8:0] mx0 = qx - mq_lo + scroll;
wire [8:0] mx  = (mx0 >= period) ? mx0 - period : mx0;
wire [8:0] t1x = marquee ? mx : qx - t1_start;
wire       t1_ok = t1_row && (marquee ? (qx >= mq_lo && qx < mq_hi) : qx >= t1_start) && t1x < tw_s;
wire [8:0] t2x = qx - t2_start;
wire       t2_ok = t2_row && qx >= t2_start && t2x < sw_s;
assign map_ra = t2_row ? {1'b1, t2x[7:0]} : {1'b0, t1x[7:0]};
wire [2:0] trow = t2_row ? py - T2Y : py - t1y;

// page dots: 4 px pitch, 2x2 dots, the current one a 4x2 pill
wire [8:0] d_start = 9'd80 - {cnt_s, 1'b0};
wire [8:0] dx = qx - d_start;
wire       d_row = py >= DY && py < DY + 2 && qx >= d_start && dx < {cnt_s, 2'b0};
wire       d_cur = d_row && dx[8:2] == idx_s;
wire       d_dim = d_row && !d_cur && (dx[1:0] == 1 || dx[1:0] == 2);

// background gradient
wire [7:0] bg_r = 8'd30 - py[7:3], bg_g = 8'd36 - py[7:3], bg_b = 8'd54 - py[7:2];

// ---- pause overlay (160x144): rounded panel, title, Resume / Home, or a status line
localparam [8:0] OX0 = 28, OX1 = 132, OY0 = 46, OY1 = 98;
localparam [8:0] R0Y = 64, R1Y = 79, RMY = 71;
wire       o_in  = ovl_v && qx >= OX0 && qx < OX1 && py >= OY0 && py < OY1;
wire [8:0] oax0  = qx - OX0, oax1 = OX1 - 9'd1 - qx, oay0 = py - OY0, oay1 = OY1 - 9'd1 - py;
wire [2:0] oax   = (oax0 < 4) ? oax0[2:0] : (oax1 < 4) ? oax1[2:0] : 3'd4;
wire [2:0] oay   = (oay0 < 4) ? oay0[2:0] : (oay1 < 4) ? oay1[2:0] : 3'd4;
wire       o_cut = ({1'b0, oax} + {1'b0, oay}) < 4'd3;
wire       o_brd = !o_cut && (oax == 0 || oay == 0 || ({1'b0, oax} + {1'b0, oay}) == 4'd3);
// which text row: 0 Resume, 1 Home, 2 Saving..., 3 Error
wire       o_msg = pmsg_v != 0;
wire       o_r0  = !o_msg && py >= R0Y - 2 && py < R0Y + 9;
wire       o_r1  = !o_msg && py >= R1Y - 2 && py < R1Y + 9;
wire       o_rm  = o_msg && py >= RMY && py < RMY + 7;
wire [1:0] o_typ = o_r0 ? 2'd0 : o_r1 ? 2'd1 : (pmsg_v == 1) ? 2'd2 : 2'd3;
wire [3:0] o_len = o_typ == 0 ? 4'd6 : o_typ == 1 ? 4'd4 : o_typ == 2 ? 4'd9 : 4'd8;
wire [8:0] o_w   = {o_len, 2'b0} + {o_len, 1'b0} - 9'd1;        // len*6 - 1
wire [8:0] o_st  = 9'd80 - (o_w >> 1);
wire [8:0] o_dx  = qx - o_st;
wire [8:0] o_ty  = o_r0 ? py - R0Y : o_r1 ? py - R1Y : py - RMY;
wire       o_trow = (o_r0 || o_r1 || o_rm) && o_ty < 7 && qx >= o_st && o_dx < o_w;
wire [14:0] o_jm = o_dx * 6'd43;
wire [3:0] o_j   = o_jm[11:8];
wire [2:0] o_col = o_dx - {o_j, 2'b0} - {o_j, 1'b0};
function [7:0] ostr(input [1:0] t, input [3:0] j, input [7:0] ec, input [2:0] en);
    reg [71:0] v;
    begin
        case (t)
        0: v = {"Resume", 24'd0};
        1: v = {"Home", 40'd0};
        2: v = "Saving...";
        default: v = {"Error ", ec, 8'h30 + en, 8'd0};
        endcase
        ostr = (j < 9) ? v[71 - j * 8 -: 8] : 8'h20;
    end
endfunction
wire [7:0] o_ch  = ostr(o_typ, o_j, ec_v, en_v);
// pill behind the selected option
wire       o_sel = (o_r0 && !psel_v) || (o_r1 && psel_v);
wire [8:0] o_px  = qx - (o_st - 9'd6);
wire [8:0] o_py  = o_r0 ? py - (R0Y - 2) : py - (R1Y - 2);
wire [8:0] o_pw  = o_w + 9'd12;
wire       o_pil = o_sel && qx >= o_st - 9'd6 && o_px < o_pw &&
                   !(((o_px == 0) || (o_px == o_pw - 1)) && ((o_py == 0) || (o_py == 10)));

localparam K_NONE = 0, K_C = 1, K_CR = 2, K_T = 3, K_TR = 4;
reg [2:0] k1 = 0; reg cut1 = 0, odd1 = 0, t1_1 = 0, t2_1 = 0, dcur1 = 0, ddim1 = 0; reg [2:0] a1 = 0, trow1 = 0;
reg [7:0] bgr1 = 0, bgg1 = 0, bgb1 = 0;
reg dbg1 = 0; reg [6:0] dch1 = 0; reg [2:0] dcol1 = 0, drow1 = 0;
reg oin1 = 0, ocut1 = 0, obrd1 = 0, opil1 = 0;
always @(posedge clk_vid) begin
    dbg1 <= o_in && o_trow; dch1 <= o_ch[6:0]; dcol1 <= o_col; drow1 <= o_ty[2:0];
    oin1 <= o_in; ocut1 <= o_cut; obrd1 <= o_brd; opil1 <= o_pil;
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
font5x7_rom font (.clk(clk_vid), .addr(dbg1 ? {dch1, drow1} : {map_q[9:3], trow1}), .q(glyph));

reg [2:0] k2 = 0, a2 = 0, gcol2 = 0; reg cut2 = 0, t1_2 = 0, t2_2 = 0, gval2 = 0, dcur2 = 0, ddim2 = 0;
reg [7:0] bgr2 = 0, bgg2 = 0, bgb2 = 0; reg dbg2 = 0;
reg oin2 = 0, ocut2 = 0, obrd2 = 0, opil2 = 0;
always @(posedge clk_vid) begin
    oin2 <= oin1; ocut2 <= ocut1; obrd2 <= obrd1; opil2 <= opil1;
    k2 <= k1; a2 <= a1; cut2 <= cut1; t1_2 <= t1_1; t2_2 <= t2_1; dcur2 <= dcur1; ddim2 <= ddim1;
    gcol2 <= dbg1 ? dcol1 : map_q[2:0]; gval2 <= dbg1 ? 1'b1 : map_q[10]; dbg2 <= dbg1;
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
    menu_on <= menu_v || (ovl_v && oin2 && !ocut2);
    if (ovl_v) begin
        if (obrd2)                            menu_rgb <= 24'h464E64;
        else if (opil2 && dbg2 && glyph_on)   menu_rgb <= 24'h141824;
        else if (opil2)                       menu_rgb <= 24'hE8ECF4;
        else if (dbg2 && glyph_on)            menu_rgb <= 24'hD2D6E2;
        else if (t1_2 && glyph_on)            menu_rgb <= 24'h969EB4;
        else                                  menu_rgb <= 24'h141824;
    end
    else if (!menu_v)                         menu_rgb <= 24'h000000;
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

// Pause menu chime: two short triangle-wave notes with an exponential decay, up (E6, B6) on open, down on close.
// Runs on the audio clock; open/close are toggles from the 74 MHz domain. Output is mixed into the game audio.
module ui_chime #(parameter CLK_HZ = 33_554_430) (
    input  wire        clk,
    input  wire        t_open, t_close,
    output reg  signed [15:0] out = 0
);
localparam [23:0] INC_LO = 24'd660, INC_HI = 24'd988;    // 1319 Hz and 1976 Hz at 33.55 MHz with a 24-bit phase
reg [2:0] so = 0, sc = 0;
reg [23:0] phase = 0, inc = 0;
reg [7:0]  amp = 0;
reg [13:0] div = 0;
reg [7:0]  ticks = 0;        // envelope ticks (488 us) into the current note
reg        note2 = 0, down = 0;
always @(posedge clk) begin
    so <= {so[1:0], t_open}; sc <= {sc[1:0], t_close};
    phase <= phase + inc;
    div <= div + 1'b1;
    if (so[2] != so[1] || sc[2] != sc[1]) begin
        down <= sc[2] != sc[1]; note2 <= 0; amp <= 8'd255; ticks <= 0;
        inc <= (sc[2] != sc[1]) ? INC_HI : INC_LO;
    end else if (div == 0) begin
        if (ticks != 8'd255) ticks <= ticks + 1'b1;
        if (!note2 && ticks == 8'd90) begin      // second note after ~44 ms
            note2 <= 1; amp <= 8'd255; inc <= down ? INC_LO : INC_HI;
        end else if (amp != 0)
            amp <= (amp > 8'd6) ? amp - (note2 ? (amp >> 5) : (amp >> 4)) - 1'b1 : 8'd0;   // ~8 / 15 ms decay
    end
end
// triangle, +-16383
wire [14:0] ramp = phase[22:8];
wire signed [15:0] tri_w = phase[23] ? $signed({1'b0, ~ramp}) - 16'sd16384 : $signed({1'b0, ramp}) - 16'sd16384;
wire signed [24:0] prod = tri_w * $signed({1'b0, amp});
wire signed [24:0] prod_s = prod >>> 10;
always @(posedge clk) out <= amp == 0 ? 16'sd0 : prod_s[15:0];   // peak about +-4k
endmodule
