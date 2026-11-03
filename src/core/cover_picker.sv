// Cover picker: a cover-flow game menu inside the GBC core.
//
// Library size: up to 2047 games. Covers stream from the pack into an SDRAM cache of 128 slots (game g lives in slot
// g mod 128) as you scroll: the selected game first, then its neighbors, then four ahead in the scroll direction.
// A cover that has not arrived yet draws as a dark tile. Each game's entry (title, flags, size) is read from the
// card when it is selected. Pack v7 stores covers at a 64 KB stride; v6 packs (45568 B stride) still load.
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
    parameter MAX_ENTRIES = 2047,
    parameter CB = 7,                // cover cache: 2^CB slots of 64 KB in SDRAM (7: 128 slots, 8 MB)
    parameter DEBUG_SQUARES = 0,     // 1 draws the diagnostic squares along the top of the menu (see README)
    parameter COVER_SLOT  = 16'd100,
    parameter CART_SLOT   = 16'd101,
    parameter SAVE_SLOT   = 16'd18,
    parameter SUS_SLOT    = 16'd102,
    parameter LOG_SLOT    = 16'd103,
    parameter FAV_SLOT    = 16'd104,
    parameter CARTS_SLOT  = 16'd105,
    parameter [31:0] BRIDGE_SAVE  = 32'h20000000,
    parameter [31:0] BRIDGE_STATE = 32'h40000000,
    parameter [31:0] BRIDGE_PACK = 32'h30000000,
    parameter [31:0] BRIDGE_CART = 32'h10000000,
    parameter [31:0] PARAM_ADDR  = 32'hF3000000,
    parameter [31:0] LOG_ADDR    = 32'hF4000000,
    parameter [31:0] FAV_ADDR    = 32'hF5000000,
    parameter [31:0] CRL_ADDR    = 32'hF6000000
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
    output reg         snd_ins = 0,      // toggles: a cart seats (click and a rising chime) / a cart leaves
    output reg         snd_rem = 0,

    // hi-res menu: cover art lives in SDRAM above the ROM area while the Game Boy is held in reset
    input  wire        clk_sys,
    input  wire        sd_ce,            // SDRAM controller sync (ce_cpu2x)
    output wire        sd_own,           // clk_sys: menu owns the SDRAM read port
    output reg  [23:0] sd_addr = 0,
    output reg         sd_oe = 0,
    output reg         sd_we = 0,
    output reg  [15:0] sd_wd = 0,
    input  wire [15:0] sd_q,
    input  wire        art_wr,           // clk_sys: one cover art word from the cart loader (while art_load)
    input  wire [23:0] art_waddr,        // SDRAM word address
    input  wire [15:0] art_wdata,
    input  wire [15:0] dbg,              // clk_sys: diagnostic bits from core_top, drawn as squares at the top left
    input  wire [31:0] cart_notify,      // clk_74a: last APF 0x00B1 (cartridge adapter) payload, for the debug log
    input  wire        cart_play,        // clk_74a: the user chose Play Cartridge (cart slot powered, physical mode)
    output reg         cprobe_req = 0,   // toggle: read the cart header (core_top, clk_sys)
    output reg         cart_mode = 0,    // clk_74a: the Game Boy plays the inserted cart (physical mode)
    output wire        cart_safe,        // hold the cart pins at bus idle (a game cart is in, or not checked yet)
    input  wire        cprobe_done,      // toggle from clk_sys: cart_hdr is valid
    input  wire [223:0] cart_hdr,        // cart bytes 0x134..0x14F, byte i at [8i +: 8]
    output reg         art_load = 0,     // clk_74a: cover art is streaming into SDRAM through the cart loader
    output wire        hr_mode,          // clk_vid: video comes from the hi-res menu (scaler slot 2)
    output reg         hr_de = 0, hr_hs = 0, hr_vs = 0,
    output reg  [23:0] hr_rgb = 0,

    input  wire        clk_vid,
    input  wire        de,
    input  wire        hs,
    input  wire        vs,
    output reg  [23:0] menu_rgb,
    output reg         menu_on = 0
);

localparam CW = 128, TW = 80;                          // art sizes in the pack (RGB565)
localparam [31:0] BLOB_BYTES = 2 * (CW * CW + TW * TW); // 45568: the bytes of one cover that are read
localparam [31:0] ENT_OFF    = 528;
localparam [15:0] PLACEHOLDER = 16'h2124;              // RGB565 tile drawn where a cover has not arrived yet
localparam [31:0] ART_BRIDGE = 32'h10800000;           // cart loader, byte 8 MB = SDRAM word 0x400000
localparam [23:0] ART_WORD   = 24'h400000;             // 64 KB (32K words) per game

// ================================================================== pack memories (clk_74a writes)
wire [3:0]  region  = pack_addr[19:16];
wire [15:0] roff    = pack_addr[15:0];

wire        ent_we = pack_wr && region == 0 && roff[15:11] == 0;

reg  [10:0] ent_raddr = 0;
wire [15:0] ent_q;
picker_dpram #(.WIDTH(16), .ADDR(10)) ent_ram (
    .wclk(clk_74a), .we(ent_we), .waddr(roff[11:1]), .wdata(pack_data),
    .rclk(clk_74a), .raddr(ent_raddr[9:0]), .q(ent_q));

// text layout map, written by the FSM, read by the renderer: {valid, char[6:0], col[2:0]}; line 1 at 0, line 2 at 256
reg         map_we = 0;
reg  [8:0]  map_wa = 0;
reg  [10:0] map_wd = 0;
wire [8:0]  map_ra;
wire [15:0] map_q;
picker_dpram #(.WIDTH(16), .ADDR(9)) map_ram (
    .wclk(clk_74a), .we(map_we), .waddr(map_wa), .wdata({5'd0, map_wd}),
    .rclk(clk_vid), .raddr(map_ra), .q(map_q));

// hi-res layout map (title at 0, platform at 512): {valid, char[6:0], col[3:0]}
reg         map2_we = 0;
reg  [10:0] map2_wa = 0;
reg  [11:0] map2_wd = 0;
wire [10:0] map2_ra;
wire [11:0] map2_q;
picker_dpram #(.WIDTH(12), .ADDR(11)) map2_ram (
    .wclk(clk_74a), .we(map2_we), .waddr(map2_wa), .wdata(map2_wd),
    .rclk(clk_vid), .raddr(map2_ra), .q(map2_q));

// glyph widths for layout: 5x7 (pause panel) and the hi-res font
reg [3:0] wrom [0:127];
initial $readmemh("font5x7_width.hex", wrom);
reg [3:0] wrom2 [0:127];
initial $readmemh("font_hr_width.hex", wrom2);
reg [3:0] wrom3 [0:63];
initial $readmemh("font_sm_width.hex", wrom3);
// the button legend's string (up to 63 characters and a 0), built by the FSM from the context, laid out as line 3
reg         lstr_we = 0; reg [5:0] lstr_wa = 0, lstr_ra = 0; reg [5:0] lstr_wd = 0;
(* ramstyle = "MLAB" *) reg [5:0] lstr_m [0:63];
reg  [5:0]  lstr_q = 0;
integer lsi;
initial for (lsi = 0; lsi < 64; lsi = lsi + 1) lstr_m[lsi] = 0;
always @(posedge clk_74a) begin if (lstr_we) lstr_m[lstr_wa] <= lstr_wd; lstr_q <= lstr_m[lstr_ra]; end
// the legend font holds only what the legend uses: compact code 1..26 A to Z, 27 space, 28..41 the pictures 1..14
function [5:0] leg_code(input [7:0] c);
    leg_code = (c >= "A" && c <= "Z") ? c[5:0] - 6'd0 : (c == " ") ? 6'd27 : (c != 0 && c < 8'd15) ? 6'd27 + c[5:0] : 6'd0;
endfunction

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
// (param_rd_data is latched at the end of the file, where the debug log's read port is declared)

// ================================================================== frame tick (vsync into clk_74a)
reg [2:0] vs_s = 0;
reg       vs_any = 0;              // frame tick source (clk_vid): hi-res timing in the menu, else the Game Boy's
always @(posedge clk_74a) vs_s <= {vs_s[1:0], vs_any};
wire frame_tick = vs_s[1] & ~vs_s[2];

// fade: level 0..8, rises one step a frame, falls two
reg [3:0] level = 0, level_target = 0;
always @(posedge clk_74a) if (frame_tick) begin
    if (level < level_target) level <= level + 1'b1;
    else if (level > level_target) level <= zm ? level - 1'b1 : (level >= 2) ? level - 2'd2 : 4'd0;   // slower under the zoom
end

// ================================================================== buttons
wire btn_left = cont1_key[2], btn_right = cont1_key[3], btn_a = cont1_key[4];
reg [31:0] key_1 = 0;
always @(posedge clk_74a) key_1 <= cont1_key;
wire press_a  = btn_a & ~key_1[4];
wire press_b  = cont1_key[5] & ~key_1[5];
wire press_up = cont1_key[0] & ~key_1[0], press_dn = cont1_key[1] & ~key_1[1];
wire press_l  = cont1_key[8] & ~key_1[8];       // L trigger: pause overlay (R is fast forward)
wire press_x  = cont1_key[6] & ~key_1[6];       // X: the selected game's options
wire press_sel = cont1_key[14] & ~key_1[14];    // Select: All / Favorites
wire press_y  = cont1_key[7] & ~key_1[7];       // Y: grid view on / off
wire press_r  = cont1_key[9] & ~key_1[9];       // L / R in the menu: previous / next letter

// left/right with hold-to-repeat: first step on press, then every 5 frames after 20 frames
reg [5:0] rep = 0;
reg       step_l = 0, step_r = 0;
always @(posedge clk_74a) begin
    step_l <= 0; step_r <= 0;
    if (btn_left & ~key_1[2]) begin step_l <= 1; rep <= 0; end
    else if (btn_right & ~key_1[3]) begin step_r <= 1; rep <= 0; end
    else if ((btn_left | btn_right) && frame_tick) begin
        if (rep == 6'd24) begin rep <= 6'd16; step_l <= btn_left; step_r <= btn_right & ~btn_left; end
        else rep <= rep + 1'b1;
    end
end

// cart header check: x = 0; for 0x134..0x14C: x = x - b - 1; must equal 0x14D
function hdr_ok(input [223:0] h);
    reg [7:0] x; integer hi;
    begin
        x = 8'd0;
        for (hi = 0; hi < 25; hi = hi + 1) x = x - h[hi * 8 +: 8] - 8'd1;
        hdr_ok = (x == h[25 * 8 +: 8]);
    end
endfunction

// default image for a cart header: 0x143 = 0xC0 Game Boy Color only (clear cart), bit 7 works on both (black), else gray
function [1:0] ctype(input [223:0] h);
    ctype = (h[15 * 8 +: 8] == 8'hC0) ? 2'd2 : h[15 * 8 + 7] ? 2'd1 : 2'd0;
endfunction
// the title area 0x134..0x142 is ASCII (or zero) on every real cart: a set bit 7 means the read went wrong, which
// the header checksum can miss (an even number of flipped bit 7s leaves it unchanged)
function title_ascii(input [223:0] h);
    integer ti;
    begin title_ascii = 1; for (ti = 0; ti < 15; ti = ti + 1) if (h[ti * 8 + 7]) title_ascii = 0; end
endfunction
function [7:0] bad_char(input [5:0] j);
    reg [143:0] t;
    begin t = "Clean the contacts"; bad_char = (j < 18) ? t[143 - j * 8 -: 8] : 8'd0; end
endfunction
function [7:0] none_char(input [5:0] j);
    reg [95:0] t;
    begin t = "No cartridge"; none_char = (j < 12) ? t[95 - j * 8 -: 8] : 8'd0; end
endfunction
// title character j from a cart header: 16 bytes, 11 on Color carts (a game code follows), '_' as a space,
// anything unprintable ends it
function [7:0] hdr_char(input [223:0] h, input [5:0] j);
    reg [7:0] b;
    begin
        b = (j < (h[15 * 8 + 7] ? 6'd11 : 6'd16)) ? h[j[3:0] * 8 +: 8] : 8'd0;
        hdr_char = (b == 8'h5F) ? 8'h20 : (b >= 8'h20 && b < 8'h7F) ? b : 8'd0;
    end
endfunction

// ================================================================== control FSM
localparam [5:0]
    S_BOOT = 0, S_HDR_REQ = 1, S_HDR_WAIT = 2, S_HDR_A = 3, S_HDR_B = 4, S_CR0 = 5, S_CR1 = 6,
    S_CR2 = 7, S_CL0 = 8, S_LOAD = 9, S_MAP_FETCH = 10, S_MAP_WAIT = 11, S_MAP_WAIT2 = 12, S_MAP_CHAR = 13,
    S_MAP_COL = 14, S_MAP_GAP = 15, S_MAP_DONE = 16, S_CL1 = 17, S_CL2 = 18, S_CL3 = 19, S_CL4 = 20,
    S_CL5 = 21, S_CL6 = 22, S_MENU = 23, S_FADE = 24, S_CLX = 25, S_LC5 = 26, S_VLOAD = 27,
    S_SEL_WRITE = 28, S_SEL_FLAGS = 29, S_OPEN_REQ = 30, S_OPEN_WAIT = 31, S_SIZE_READ = 32, S_SIZE_LO = 33,
    S_SIZE_HI = 34, S_PULL_REQ = 35, S_PULL_WAIT = 36, S_RESET = 37, S_RUN = 38, S_OFF = 39, S_LAUNCH_FADE = 40;
localparam [6:0]
    S_PREAD = 41, S_PREAD_W = 42, S_PFLAGS = 43, S_PSIZE = 44, S_POPEN = 45, S_POPEN_W = 46, S_XFER_W = 47,
    S_L1 = 49, S_SETTLE = 50, S_L3 = 52, S_L4 = 53, S_L5 = 54, S_L6 = 55, S_L7 = 56, S_L8 = 57, S_L9 = 58,
    S_L10 = 59, S_L11 = 60, S_LRUN = 61, S_LFAIL = 62, S_PAUSE = 63, S_H0 = 64, S_H1 = 65, S_H2 = 66, S_H3 = 67,
    S_H4 = 68, S_H5 = 69, S_H6 = 70, S_PROBE1 = 71, S_PROBE2 = 72, S_LOAD2 = 73, S_AF0 = 74, S_AF1 = 75, S_AF2 = 76, S_LG2 = 77,
    S_HDR_C = 78, S_LOADE = 79, S_LOADK = 80, S_AFRT = 81, S_HDR_D = 82, S_HDR_E = 83, S_HDR_F = 84, S_AF0W = 85,
    S_IDX_REQ = 86, S_IDX_W = 87, S_IDX_RD = 88, S_IDX_RD2 = 89, S_JMP0 = 90, S_JMP1 = 91, S_JMP2 = 92,
    S_LC1 = 93, S_LC2 = 94, S_LC3 = 95, S_LC4 = 96, S_FV0 = 97, S_FV1 = 98, S_FV2 = 99, S_FV3 = 100, S_FW0 = 101,
    S_FW1 = 102, S_GM = 103, S_GMA = 104, S_GMF = 105, S_GMF2 = 106, S_MODE = 107,
    S_CP0 = 108, S_CP1 = 109, S_CP2 = 110, S_CP3 = 111, S_CP4 = 112, S_CP5 = 113, S_CP6 = 114, S_CP7 = 115,
    S_CP8 = 116, S_CP9 = 117, S_CPM = 118, S_CRUN0 = 119, S_CRUN = 120,
    S_CPH = 121, S_CPH2 = 122, S_CP10 = 123, S_CP11 = 124, S_CPD = 125, S_CPX = 126, S_LB0 = 127, S_LB1 = 48;
localparam [7:0] S_LC6 = 128, S_LC7 = 129, S_FL0 = 130, S_FL1 = 131, S_MAP_WAIT3 = 132;
localparam [1:0] PK_ROM = 0, PK_SAV = 1, PK_SUS = 2;
localparam [12:0] LOG_BYTES = 13'd2048;   // debug log file size (256 records)

reg  [7:0]  state = S_BOOT, op_ret = S_BOOT;
reg  [1:0]  pk = 0;                // path struct kind for the open subroutine
reg  [31:0] pflags = 0, psize = 0;
reg  [15:0] op_slot = 0;
reg  [2:0]  oerr = 0, xerr = 0;    // result of the last open / transfer
reg  [27:0] tmr = 0;
reg  [27:0] mt = 0;                // time idle in the menu (log flush after 3 s)
reg         plog = 0, lflush_req = 0; // path struct = the log file's; a log flush is due
reg         pfav = 0;              // path struct = favorites.cfg (after the log path)
reg  [31:0] sv = 0, ssz = 0;       // latched save / state sizes of the running game
reg         cur_susp = 0, cur_known = 0;   // the selected game has a suspend file (probed on every selection)
reg  [31:0] cur_crc = 0;           // the selected game's ROM CRC32 (pack v7 entry)
reg         cur_favp = 0;          // the pack marks it a favorite (entry flags bit 1)
// favorite changes made on the Pocket this session and since the last sync (favorites.cfg), newest last
localparam FN = 15;
reg  [31:0] fv_crc [0:FN-1]; reg fv_st [0:FN-1]; reg [3:0] fv_n = 0;
reg  [10:0] fv_fp [0:FN-1], fv_ap [0:FN-1];   // the game's favorites block position (0x7FF: none) and A to Z position
reg  [10:0] cur_fp = 11'h7FF, cur_ap = 0;     // the selected entry's (pack v7 with CRT1 flags bit 3; else none / idx)
// live favorites: Favorites mode reads its positions from a list rebuilt from the pack's favorites block and the
// session's changes (unstarred ones dropped, newly starred ones appended), so a star counts at once
wire        live = crt_ok && crt_flags[3];
reg         fl_req = 0, fl_ack = 0;           // rebuild request (toggle) and its acknowledgement
reg  [10:0] lfav_n = 0;                       // the live list's length
wire        fl_valid = fl_req == fl_ack;
reg         fl_we = 0; reg [10:0] fl_wa = 0, fl_wd = 0, fl_ra = 0, gen_addr = 0, rr_addr = 0;
wire [10:0] fl_q;
picker_dpram #(.WIDTH(11), .ADDR(11)) fl_ram (.wclk(clk_74a), .we(fl_we), .waddr(fl_wa), .wdata(fl_wd), .rclk(clk_74a), .raddr(fl_ra), .q(fl_q));
wire [10:0] fcount = live ? lfav_n : fav_count;   // favorites shown
// rebuild: walk the pack's favorites block and keep each position unless the newest change for it is "off"; then
// append, in order, every change that is "on" for a game outside the block whose newest same-CRC change it is
reg  [2:0]  rb_st = 0; reg [10:0] rb_p = 0, rb_n = 0; reg [3:0] rb_r = 0, rb_r2 = 0; reg rb_skip = 0, rb_last = 0;
always @(posedge clk_74a) begin
    fl_we <= 0;
    case (rb_st)
    0: if (fl_req != fl_ack) begin rb_p <= 0; rb_n <= 0; rb_r <= 0; rb_skip <= 0; rb_st <= 3'd1; end
    1: begin                                         // position rb_p: scan the changes for its newest record
        if (rb_p >= fav_count) begin rb_r <= 0; rb_r2 <= 0; rb_last <= 1; rb_st <= 3'd3; end
        else if (rb_r < fv_n) begin if (fv_fp[rb_r] == rb_p) rb_skip <= !fv_st[rb_r]; rb_r <= rb_r + 1'b1; end
        else begin
            if (!rb_skip) begin fl_we <= 1; fl_wa <= rb_n; fl_wd <= rb_p; rb_n <= rb_n + 1'b1; end
            rb_p <= rb_p + 1'b1; rb_r <= 0; rb_skip <= 0;
        end
    end
    3: begin                                         // change rb_r: is it the newest for its CRC? (rb_r2 scans after it)
        if (rb_r >= fv_n) begin lfav_n <= rb_n; fl_ack <= fl_req; rb_st <= 0; end
        else if (rb_r2 < fv_n) begin if (rb_r2 > rb_r && fv_crc[rb_r2] == fv_crc[rb_r]) rb_last <= 0; rb_r2 <= rb_r2 + 1'b1; end
        else begin
            if (rb_last && fv_st[rb_r] && fv_fp[rb_r] == 11'h7FF && rb_n < 11'd2040) begin fl_we <= 1; fl_wa <= rb_n; fl_wd <= fv_ap[rb_r]; rb_n <= rb_n + 1'b1; end
            rb_r <= rb_r + 1'b1; rb_r2 <= 0; rb_last <= 1;
        end
    end
    default: rb_st <= 0;
    endcase
end
reg         fav_ok = 0;            // favorites.cfg was found or created, so changes can be saved
reg         fl_lift = 0;           // the change being saved removes the selected favorite (lift it out)
reg  [7:0]  fl_ret = 0;            // where a rebuild returns: the entry load at boot, the options after a change
reg         lt_go = 0;             // start the lift
reg         zm_go = 0, zm_in = 0, zm_home = 0;   // the zoom: into a game (the cover grows as the menu fades) or back out
reg  [3:0]  fj = 0; reg fhit = 0, fval = 0;
reg  [6:0]  fw = 0; reg fv_v2 = 0;  // favorites.cfg word counter and record format
// options menu (X) and list mode (Select)
reg         gm_on = 0; reg [1:0] gm_sel = 0;     // 0 Play, 1 Start over (only when suspended), 2 Favorite, 3 Back
reg         fav_mode = 0;          // Select: only the favorites at the top of the list
// Play Cartridge: the cart's header is read and looked up in the pack's fingerprint table (FPR1)
reg         cart_view = 0;         // showing the inserted cartridge's cover (A boots the cart)
reg         cart_none = 0;         // the cartridge view with nothing in the slot: the empty slot drawing (CRT1 flag 4)
reg         cart_checked = 0;
reg         cart_found = 0; reg [10:0] cart_idx = 0;   // a cart we own is inserted, and its pack entry
reg  [2:0]  cpd_s = 0;
reg  [31:0] fp_off = 0; reg [10:0] fp_cnt = 0, fp_ck = 0, fp_n = 0, fp_j = 0;
reg  [15:0] fp_w0 = 0, fp_w1 = 0, fp_w2 = 0;
reg  [31:0] tcrc = 0;              // CRC32 of the cart's 11-byte title (0x134..0x13E), the same in every revision
reg  [3:0]  tb = 0; reg [2:0] tbit = 0;
reg         m_ex = 0, m_ti = 0; reg [10:0] m_exi = 0, m_tii = 0;   // first exact / first same-title match
reg         cart_present = 0;      // a valid Game Boy header was read from the slot
reg         rp = 0;                // this header read is a live check from the menu, not the boot check
reg  [27:0] rp_tmr = 0;            // menu: time since the last live check
reg  [223:0] cart_last = 0;        // the header the menu last acted on
reg         lgh_req = 0;           // toggle: the debug log should record the cart header (logger owns lgh_pend)
assign cart_safe = !cart_checked || cart_present;
reg  [10:0] rlo = 0;               // first index of the browsing range
reg  [10:0] fav_count = 0;         // from the letter index
reg         lerr = 0;              // last launch failed: show the error on line 2
reg  [7:0]  ecode = 0; reg [2:0] enum_ = 0;
reg         ovl = 0, psel = 0;     // pause overlay, selected option (0 Resume, 1 Home)
reg  [1:0]  pmsg = 0;              // 0 options, 1 saving, 2 error
reg         ago = 0, ago_dir = 0;  // start a cover flow step (pulse) and its direction
// carts the pack doesn't know (CRT1 block at file offset 96): default cartridge images, the browsable list length,
// and carts.cfg, where the core logs them so the next sync can identify them and add their covers
reg         crt_ok = 0;            // the pack has a CRT1 block
reg  [31:0] crt_off = 0;           // file offset of the three default cartridge images (gray, black, clear); 0: none
reg  [10:0] lcount = 0;            // entries 0..lcount-1 are the list; the rest are cartridge-only (shown when inserted)
reg         crl_ok = 0;            // the paths area has a carts.cfg path struct (after favorites.cfg)
reg  [15:0] crt_acc [0:2];         // glow colors of the default images
reg         cart_unk = 0;          // the inserted cart isn't in the pack: its cover is default image cart_type
reg         cart_bad = 0;          // its title bytes aren't ASCII: a misread (dirty or shorted contacts), not logged
reg  [1:0]  cart_type = 0;
reg  [6:0]  crl_n = 0;             // records in carts.cfg
reg  [223:0] crl_last = 0;         // the header last logged this session
reg  [7:0]  cl_ret = 0;
reg         pcart = 0;             // path struct = carts.cfg (after favorites.cfg)
reg  [10:0] lidx = 0;              // list position to return to from the cart view
reg         lmode = 0;             // and its mode (1: Favorites)
reg  [10:0] fidx = 0, aidx = 0;    // where Favorites and All were left
reg  [15:0] crt_flags = 0;         // CRT1 flags: bit 0 carts.cfg path, bit 1 the All games cover
reg  [15:0] cur_acc = 0;           // glow color of the selection (pack v7 entry bytes 42-43)
reg         tl_hold = 0;           // the new title waits for a cartridge transition to land
// cartridge transitions (cover flow block below): pulse, direction (1: the cart comes in), with effects (a real
// insert or removal: ring, shine, bloom, sound; Select and Left/Right just move)
reg         vt_go = 0, vt_in = 0, vt_fx = 0;
wire        vt_busy, vt_txt;
localparam [15:0] ACC_DEFAULT = 16'hCEBF;   // a cool white, for entries without a color
reg  [3:0]  tl_target = 0;
reg         anim = 0, adir = 0;    // cover flow step in progress; adir 0: moved right (idx = old next), 1: left
reg  [3:0]  af = 0;                // animation frame
reg  [3:0]  tlevel = 0;            // title fade, separate from the whole-menu fade
reg  [26:0] boot_timer = 0;
reg  [11:0] clr = 0;               // boot: table clear counter
reg  [10:0] count = 0, idx = 0;
reg  [15:0] pver = 0;              // pack format version
reg  [31:0] rom_size = 0;
reg  [6:0]  copy_i = 0;
reg  [15:0] lo_word = 0;
reg         game_loaded = 0, done_1 = 0;
reg  [5:0]  k = 0;                 // character index while laying out text
reg  [7:0]  chr = 0;               // the character at k, registered a cycle before S_MAP_CHAR
reg         line2 = 0;             // laying out line 2 (platform) instead of the title
reg  [7:0]  ch = 0;
reg  [3:0]  gw = 0, col = 0;
reg  [10:0] mp = 0;
reg  [7:0]  title_w = 0;
reg  [8:0]  htw = 0, hsw = 0, lgw = 0;   // hi-res title / platform / legend widths
reg         line3 = 0, lonly = 0;  // laying out the legend; only the legend (the context changed)
reg  [2:0]  lb_h = 0; reg [5:0] lb_j = 0, lb_n = 0; reg [1:0] lb_g = 0;   // legend builder: hint slot, character, length, gap count
reg  [6:0]  leg_built = 7'h7F;     // the context the string was built for
reg         lf = 0;                // layout pass for the hi-res font
reg  [10:0] af_g = 0;              // art loader: game being fetched
reg  [7:0]  af_ret = 0;            // art loader: state to return to
reg  [1:0]  art_try = 0;           // art loader: retries left for this game
reg         pend_l = 0, pend_r = 0, pend_a = 0;   // presses that arrived while the loader was busy
reg         pend_u = 0, pend_d = 0;               // Up / Down: jump to the previous / next section
reg         pend_x = 0, pend_s = 0;               // X: options, Select: list mode
reg         pend_y = 0, pend_b = 0;               // Y: grid view; B: back to the cover flow
reg         pend_jl = 0, pend_jr = 0;             // L / R: letter jumps
// grid view: 4 by 2 cells of 72 px (pitch 76 by 94) above the title block, the selection drawn as an 80 px "pop"
// over its cell (free cover 1); the cover flow's math is bypassed while it is on. State here, motion further down.
reg         grid_pref = 0, grid = 0;              // wanted (Y); drawn (set by the morph in, cleared by the morph out)
reg         g_morph = 0, g_min = 0; reg [3:0] g_mf = 0;     // morph running, going in, frame
reg         g_move = 0; reg [2:0] g_vf = 0;                 // the pop sliding to another cell
reg         g_scroll = 0, g_sdn = 0; reg [2:0] g_sf = 0;    // the rows sliding one pitch, down
reg  [8:0]  g_top = 0;             // list row (4 games) shown as the top lattice row
reg         g_up = 0;              // during a scroll up the three lattice rows start one row above g_top
reg  signed [7:0] lat_y = 0;       // the rows' shift during a scroll
reg  [4:0]  lat_b = 0, side_b = 0; // lattice / flow side cover brightness during the morph
reg  signed [10:0] p_x = 0, p_y = 0, p_fx = 0, p_fy = 0, p_tx = 0, p_ty = 0; reg [7:0] p_s = 0, p_fs = 0, p_ts = 0;
reg         g_go = 0, g_go1 = 0, g_go2 = 0; reg [1:0] g_kind = 0;   // from the FSM: 0 idx changed, 1 morph in, 2 out
reg  [8:0]  mk_r = 0, mv_r = 0; reg [6:0] sc_r = 0;   // this frame's morph, move and scroll curve values, registered
wire        g_anim = g_morph | g_move | g_scroll;
wire        grid_draw = grid | g_morph;
wire signed [9:0] g_base = $signed({1'b0, g_top}) - $signed({9'd0, g_up});   // list row of lattice row 0
// letter index (pack v7, header area at offset 16): section 0 = the top of the list (played and favorites),
// sections 1..27 = the first game whose title starts with '#' (not a letter) or A..Z
reg  [10:0] sec_start [0:27]; reg [27:0] sec_ok = 0;
reg         idx_ok = 0;            // the pack has a letter index
reg  [4:0]  sj = 0;                // section scan / load counter
reg  [4:0]  jbest = 0, jwrap = 0; reg jhave = 0, jwhave = 0;
reg         jup = 0;               // this jump goes up
reg         lbl_on = 0; reg [4:0] lbl_sec = 0;   // platform line shows the section label after a jump
reg         dbg_art_err = 0, dbg_art_done = 0;   // diagnostics: a refused art read; the art stream finished
reg         is_gb = 0;
reg         gen = 0;               // toggles on every new selection (marquee restart)
wire        done_rise = target_dataslot_done & ~done_1;
wire [7:0]  cp_none = S_CPX;       // no cart we own (or none at all): see S_CPX
wire        vsel = cart_view && (cart_unk || cart_none);   // the selection is a default image (index count + type, or count + 3: the empty slot)
wire        slot_ok = crt_ok && crt_flags[2];   // the pack has the empty slot drawing
wire [10:0] lcnt = (crt_ok && lcount != 0 && lcount <= count) ? lcount : count;   // list length

wire [10:0] ebase = 11'd8;          // the selected game's entry is read to word 8 (after the 16 byte header)
// browsing range: the whole list, or (Select) only the favorites section at the top
// Favorites: positions 0..fav_count-1, then (when the pack has it) the All games cover at position fav_count,
// which is drawn from virtual game count + 3. All: the A to Z part, fav_count..lcnt-1 (the favorites block at the
// top of the pack is only for Favorites). The cart view: just the cart.
reg  [10:0] rcount = 0;
wire        tile_ok = crt_ok && crt_flags[1] && fav_count != 0 && count < 11'd2044;
always @(posedge clk_74a) begin
    rcount <= cart_view ? 11'd1 : (fav_mode && fav_count != 0) ? fcount + {10'd0, tile_ok} : lcnt - fav_count;
    rlo    <= cart_view ? idx : (fav_mode && fav_count != 0) ? 11'd0 : fav_count;
end
wire [10:0] rhi  = rlo + rcount - 1'b1;
wire [10:0] prev = (idx <= rlo) ? rhi : idx - 1'b1;
wire [10:0] next = (idx >= rhi) ? rlo : idx + 1'b1;
reg         vtile = 0;             // the All games cover is selected (registered: it feeds the text layout)
always @(posedge clk_74a) vtile <= fav_mode && tile_ok && idx == fcount && !cart_view;
function [10:0] vmap(input [10:0] pos);              // list position -> game (cover and entry), the pack's own order
    vmap = (fav_mode && tile_ok && !cart_view && pos == fcount) ? count + 11'd3 + {10'd0, crt_flags[2]} : pos;
endfunction
// a Favorites position through the live list (fl_q read two cycles after its address): the tile stays virtual
function [10:0] lmap(input [10:0] pos, input [10:0] q);
    lmap = (fav_mode && tile_ok && !cart_view && pos == fcount) ? count + 11'd3 + {10'd0, crt_flags[2]} : (fav_mode && live && !cart_view) ? q : pos;
endfunction
// the games at the selection and its neighbours, read from the live list round robin (fl_ram_b); the entry loader
// and the grid's side covers use them
reg  [1:0]  lk = 0, lk_1 = 0, lk_2 = 0; reg [1:0] rr_own = 0;
reg  [10:0] g_cur = 0, g_prev = 0, g_next = 0;
reg  [10:0] rr_src1 = 0, rr_src2 = 0, g_cur_src = 11'h7FF;   // the idx a lookup was made for
wire        gen_busy = cph >= 3'd2;                  // the generator owns the port while one of its reads is in flight
wire [10:0] rr_a = (lk == 0) ? idx : (lk == 1) ? prev : next;
// the lookup only matters when Favorites mode reads the live list; otherwise the position is the game
wire        g_cur_ok = !(fav_mode && live) || (g_cur_src == idx && fl_valid);
wire [10:0] cur_g = (fav_mode && live) ? g_cur : vmap(idx);
always @(posedge clk_74a) begin
    fl_ra <= gen_busy ? gen_addr : rr_a;
    rr_own <= {rr_own[0], !gen_busy};                // whose read answers two cycles later
    if (!gen_busy) lk <= (lk == 2'd2) ? 2'd0 : lk + 1'b1;   // rotate only on a read that was issued: no address is starved
    lk_1 <= lk; lk_2 <= lk_1; rr_src1 <= idx; rr_src2 <= rr_src1;
    if (rr_own[1]) case (lk_2) 0: begin g_cur <= lmap(idx, fl_q); g_cur_src <= rr_src2; end 1: g_prev <= lmap(prev, fl_q); default: g_next <= lmap(next, fl_q); endcase
end
// pack layout, computed once after the header is read (registered: these feed 32-bit offsets)
reg  [31:0] stride = 0;            // v7 pads every cover to 64 KB, v6 packs them at 45568 B
reg  [31:0] blob0 = 0, paths0 = 0, lay_t = 0;
reg  [31:0] art_mul = 0, art_off = 0;   // offset of af_g's cover, two cycles behind af_g
wire        art_v = af_g >= count;       // a default cartridge image: they follow the FPR2 table
always @(posedge clk_74a) begin art_mul <= (art_v ? af_g - count : af_g) * stride; art_off <= (art_v ? crt_off : blob0) + art_mul; end
wire [12:0] pslot   = (plog | pfav | pcart) ? {1'b0, count, 1'b0} + {2'd0, count} + {11'd0, pcart, pfav}   // after every game's: log, favorites, carts
                           : {1'b0, idx, 1'b0} + {2'd0, idx} + {11'd0, pk};  // idx*3 + kind
wire [31:0] pstruct = paths0 + {11'd0, pslot, 8'd0};

// ---------------------------------------------------------------- cover cache (clk_74a)
// tag per SDRAM slot (game g lives in slot g mod 2^CB): {valid, game}. One read port, shared round robin: phases 0..3 look up the four visible covers,
// phases 4..7 test prefetch candidates in priority order.
reg         tag_we = 0; reg [CB-1:0] tag_wa = 0; reg [11:0] tag_wd = 0;
reg  [CB-1:0] tag_ra = 0;
wire [11:0] tag_q;
picker_dpram #(.WIDTH(12), .ADDR(CB)) tag_ram (
    .wclk(clk_74a), .we(tag_we), .waddr(tag_wa), .wdata(tag_wd),
    .rclk(clk_74a), .raddr(tag_ra), .q(tag_q));
reg  [10:0] cg [0:3];              // games of the four visible covers (cover flow block below)
reg         cl [0:3];              // their art is in the cache
reg  [4:0]  tph = 0, tph_1 = 0, tph_2 = 0;       // 32 phases: 4 visible covers, then candidates
reg  [4:0]  cand = 0, cand_1 = 0, cand_2 = 0;    // prefetch candidate number
reg  [10:0] tg_1 = 0, tg_2 = 0;    // game whose tag is being read
reg         need_v = 0; reg [10:0] need_g = 0;   // the highest priority missing cover
reg         sweep_hit = 0; reg [10:0] sweep_g = 0;
reg         need_clr = 0, sweep_bad = 0;   // a load just finished: drop need and the sweep that saw the old tag
                                   // (need_v is stale on the clock need_clr is high, so the FSM checks both)
// candidate offsets: 0, +1, -1, +2, -2, then 4 ahead in the scroll direction, then 2 behind
function signed [4:0] cand_off(input [3:0] c, input dir_left);
    reg signed [4:0] o;
    begin
        case (c)
        0: o = 0; 1: o = 1; 2: o = -1; 3: o = 2; 4: o = -2; 5: o = 3; 6: o = 4; 7: o = 5; 8: o = 6;
        9: o = -3; default: o = -4;
        endcase
        cand_off = (dir_left && c >= 5) ? -o : o;
    end
endfunction
reg last_left = 0;                 // direction of the last step, for prefetch
// the candidates' games (idx + offset, wrapped around the library), recomputed one at a time whenever the selection,
// the direction or the count changes: one add, then one wrap per cycle until in range (several for tiny libraries).
// In the grid view the candidates are the lattice's cells instead: its three rows (0..11, which are also what the
// lattice draws), then the row below (12..15), then the row above (16..19); positions past the list are not valid.
reg  [10:0] cgame [0:19]; reg cok [0:19];
reg  [4:0]  cj = 0; reg [2:0] cph = 0; reg signed [12:0] cgv = 0; reg cok_p = 0;
reg  [10:0] c_idx = 11'h7FF, c_cnt = 0, c_lo = 0; reg c_left = 0; reg signed [9:0] c_gb = 0; reg c_grid = 0;
reg         c_valid = 0;           // every candidate matches the current selection (one full pass since the change)
wire        use_grid = grid_draw && !cart_view;   // the grid's layout and candidates (the cart view is the flow's)
wire [4:0]  nc = use_grid ? 5'd20 : 5'd11;        // candidates in use
always @(posedge clk_74a) begin
    if (idx != c_idx || rcount != c_cnt || last_left != c_left || rlo != c_lo || g_base != c_gb || use_grid != c_grid || !fl_valid) begin
        c_idx <= idx; c_cnt <= rcount; c_left <= last_left; c_lo <= rlo; c_gb <= g_base; c_grid <= use_grid; cj <= 0; cph <= 0; c_valid <= 0;
    end else if (rcount != 0) begin
        if (cph >= 3'd2 && cph <= 3'd4) cph <= cph + 1'b1;   // the list RAM answers four cycles after the request (the port mux, then the RAM)
        else if (cph == 3'd5) begin
            cgame[cj] <= lmap(cgv[10:0], fl_q); cok[cj] <= cok_p; cph <= 0;
            if (use_grid) begin cj <= (cj == 5'd19) ? 5'd0 : cj + 1'b1; if (cj == 5'd19) c_valid <= 1; end
            else begin cj <= (cj == 5'd10) ? 5'd0 : cj + 1'b1; if (cj == 5'd10) c_valid <= 1; end
        end
        else if (use_grid) begin : gridc
            reg signed [11:0] grow; reg signed [12:0] gpos;
            grow = $signed({{2{g_base[9]}}, g_base}) + ((cj < 5'd12) ? $signed({10'd0, cj[3:2]}) : (cj < 5'd16) ? 12'sd3 : -12'sd1);
            gpos = $signed({2'b0, rlo}) + (grow <<< 2) + $signed({11'd0, cj[1:0]});
            cgv <= gpos; gen_addr <= gpos[10:0]; cok_p <= grow >= 0 && gpos <= $signed({2'b0, rhi}); cph <= 3'd2;
        end
        else if (cph == 0) begin cgv <= $signed({2'b0, idx}) + cand_off(cj[3:0], last_left); cph <= 3'd1; end
        else if (cgv < $signed({2'b0, rlo})) cgv <= cgv + $signed({2'b0, rcount});
        else if (cgv >= $signed({2'b0, rlo}) + $signed({2'b0, rcount})) cgv <= cgv - $signed({2'b0, rcount});
        else begin gen_addr <= cgv[10:0]; cok_p <= 1; cph <= 3'd2; end
    end
end
wire [10:0] tg_now = (tph < 4) ? cg[tph[1:0]] : cgame[cand];
// a published miss is usable only for the selection it was computed for
wire        need_ok = need_v && !need_clr && c_valid && idx == c_idx && rcount == c_cnt && last_left == c_left && rlo == c_lo && g_base == c_gb && use_grid == c_grid;
reg         lat_l [0:19];          // the candidate's art is in the cache (the lattice uses 0..11)
integer li;
initial for (li = 0; li < 20; li = li + 1) lat_l[li] = 0;
always @(posedge clk_74a) begin
    tph <= tph + 1'b1;
    tag_ra <= tg_now[CB-1:0];
    tph_1 <= tph; tg_1 <= tg_now; cand_1 <= cand;
    tph_2 <= tph_1; tg_2 <= tg_1; cand_2 <= cand_1;
    if (tph >= 4) cand <= (cand >= nc - 1'b1) ? 5'd0 : cand + 1'b1;
    // tag_q holds the tag read two cycles ago (address registered, then the RAM's own register)
    if (tph_2 < 4) cl[tph_2[1:0]] <= tag_q[11] && tag_q[10:0] == tg_2;
    else if (count != 0) begin : sweep
        reg miss, keep; integer oj;
        // the slot's current game may only be evicted by a nearer candidate: if it is itself a candidate of equal or
        // higher priority (or on screen), leave it, so two games that share a slot never take turns evicting each other
        keep = tag_q[11] && (tag_q[10:0] == cg[0] || tag_q[10:0] == cg[1] || tag_q[10:0] == cg[2] || tag_q[10:0] == cg[3]);
        for (oj = 0; oj < 20; oj = oj + 1)
            if (oj < nc && oj <= cand_2 && cok[oj] && tag_q[11] && tag_q[10:0] == cgame[oj]) keep = 1;
        miss = cok[cand_2] && !(tag_q[11] && tag_q[10:0] == tg_2) && !keep;
        if (c_valid) lat_l[cand_2] <= cok[cand_2] && tag_q[11] && tag_q[10:0] == tg_2;
        if (cand_2 == 0) begin                       // candidate 0 closes the last sweep and opens the next
            if (!sweep_bad) begin need_v <= sweep_hit; need_g <= sweep_g; end
            sweep_bad <= 0;
            sweep_hit <= miss; sweep_g <= tg_2;      // never evict a visible cover; first miss wins
        end else if (miss && !sweep_hit) begin
            sweep_hit <= 1; sweep_g <= tg_2;
        end
    end
    if (need_clr || !c_valid) begin need_v <= 0; sweep_hit <= 0; sweep_bad <= 1; end   // stale: start over
end

// platform line, character j
// mode 0 Game Boy Color, 1 Game Boy, 2 suspended, 3 launch error
// mode 4: the section just jumped to (FAVORITES, #, a letter) or the list mode (sec 28: ALL GAMES)
// mode 5: the options menu, opt 0 Play, 1 Start over, 2 favorite on/off, 3 Back
function [7:0] plat_char(input [2:0] m, input [7:0] ec, input [2:0] en, input [4:0] sec, input [1:0] opt, input fav,
                         input [15:0] bcd, input [2:0] nd, input [5:0] j);
    reg [191:0] s; reg [4:0] n;
    begin
        case (m)
        0: begin s = {"GAME BOY COLOR", 80'd0}; n = 14; end
        1: begin s = {"GAME BOY", 128'd0}; n = 8; end
        2: begin s = {"SUSPENDED", 120'd0}; n = 9; end
        4: begin
            if (sec == 0) begin s = {"FAVORITES", 120'd0}; n = 9; end
            else if (sec == 28) begin s = {"ALL GAMES", 120'd0}; n = 9; end
            else if (sec == 29) begin s = {"CARTRIDGE REMOVED", 56'd0}; n = 17; end
            else begin s = {(sec == 1) ? 8'h23 : 8'h40 + {3'd0, sec} - 8'd1, 184'd0}; n = 1; end   // '#', 'A'..'Z'
        end
        5: case (opt)
            0: begin s = {"< PLAY >", 128'd0}; n = 8; end
            1: begin s = {"< START OVER >", 80'd0}; n = 14; end
            2: if (fav) begin s = {"< UNFAVORITE >", 80'd0}; n = 14; end
               else begin s = {"< ADD TO FAVORITES >", 32'd0}; n = 20; end
            default: begin s = {"< BACK >", 128'd0}; n = 8; end
           endcase
        6: begin s = {"CARTRIDGE", 120'd0}; n = 9; end
        7: begin                                     // the All games cover: "<n> GAMES"
            case (nd)
            1: s = {8'h30 + bcd[3:0], " GAMES", 136'd0};
            2: s = {8'h30 + bcd[7:4], 8'h30 + bcd[3:0], " GAMES", 128'd0};
            3: s = {8'h30 + bcd[11:8], 8'h30 + bcd[7:4], 8'h30 + bcd[3:0], " GAMES", 120'd0};
            default: s = {8'h30 + bcd[15:12], 8'h30 + bcd[11:8], 8'h30 + bcd[7:4], 8'h30 + bcd[3:0], " GAMES", 112'd0};
            endcase
            n = {2'd0, nd} + 5'd6;
        end
        default: begin s = {"ERROR ", ec, 8'h30 + en, 128'd0}; n = 8; end
        endcase
        plat_char = (j < n) ? s[191 - j * 8 -: 8] : 8'd0;
    end
endfunction
wire [2:0] pmode = lerr ? 3'd3 : cart_view ? 3'd6 : vtile ? 3'd7 : gm_on ? 3'd5 : lbl_on ? 3'd4 : cur_susp ? 3'd2 : is_gb ? 3'd1 : 3'd0;
function [7:0] tile_char(input [5:0] j);
    reg [71:0] t;
    begin t = "All games"; tile_char = (j < 9) ? t[71 - j * 8 -: 8] : 8'd0; end
endfunction
// the All list's length in decimal for the cover's platform line (double dabble, 11 steps, whenever it changes)
reg  [10:0] gn_src = 11'h7FF, gn_sh = 0; reg [15:0] gacc = 0, gbcd = 0; reg [3:0] gn_i = 0;
wire [10:0] gn = lcnt - fav_count;
wire [2:0]  gnd = (gbcd[15:12] != 0) ? 3'd4 : (gbcd[11:8] != 0) ? 3'd3 : (gbcd[7:4] != 0) ? 3'd2 : 3'd1;
// the platform line's character k, registered: the layout reaches S_MAP_CHAR a cycle after k changes (a long mux
// from the game count's digits otherwise lands on the layout's state)
reg [7:0] pch = 0;
always @(posedge clk_74a) pch <= plat_char(pmode, ecode, enum_, lbl_sec, gm_sel, cur_fav, gbcd, gnd, k);
// ---- the button legend: a context picks up to five hints (a picture, a space, a word), three spaces apart.
// Contexts: 1 flow All, 2 flow Favorites, 3 grid All, 4 grid Favorites, 5 options, 6 cartridge, 7 the All games cover,
// 8 no cartridge, 9 settings. The Select hint names the next stop of the ring: 1 FAVORITES, 2 ALL GAMES, 3 CARTRIDGE.
// Mirrored by tools/legend_model.py; the pictures live in font_sm codes 1 to 14 (tools/make_legend_font.py).
wire        favs_ok  = fav_count != 0 && idx_ok;
wire [3:0]  leg_ctx  = !menu_active ? 4'd0 : gm_on ? 4'd5 : cart_view ? (cart_present ? 4'd6 : 4'd8) : vtile ? 4'd7 :
                       fav_mode ? (grid_pref ? 4'd4 : 4'd2) : (grid_pref ? 4'd3 : 4'd1);
wire [1:0]  leg_next = cart_view ? (favs_ok ? 2'd1 : 2'd2) : fav_mode ? 2'd2 : (cart_found || slot_ok) ? 2'd3 : favs_ok ? 2'd1 : 2'd0;
wire        leg_let  = idx_ok && !fav_mode && lcnt > 1;
wire [6:0]  leg_key  = {leg_ctx, leg_next, leg_let};
// hint h: 0 Y GRID, 1 Y FLOW, 2 X OPTIONS, 3 A PLAY, 4 Select FAVORITES, 5 Select ALL GAMES, 6 Select CARTRIDGE,
// 7 L R LETTER, 8 D-pad CHOOSE, 9 A OK, 10 B BACK, 11 A PLAY CART, 12 A ALL GAMES, 13 D-pad SETTING, 14 D-pad CHANGE
// (15 means no hint). Character j of hint h, 0 past its end.
function [7:0] hint_char(input [3:0] h, input [5:0] j);
    reg [111:0] t; reg [3:0] n;
    begin
        case (h)
        0:  begin t = {8'd1, " GRID", 64'd0}; n = 6; end
        1:  begin t = {8'd1, " FLOW", 64'd0}; n = 6; end
        2:  begin t = {8'd2, " OPTIONS", 40'd0}; n = 9; end
        3:  begin t = {8'd3, " PLAY", 64'd0}; n = 6; end
        4:  begin t = {8'd7, " FAVORITES", 24'd0}; n = 11; end
        5:  begin t = {8'd7, " ALL GAMES", 24'd0}; n = 11; end
        6:  begin t = {8'd7, " CARTRIDGE", 24'd0}; n = 11; end
        7:  begin t = {8'd11, 8'd12, " LETTER", 40'd0}; n = 9; end
        8:  begin t = {8'd5, " CHOOSE", 48'd0}; n = 8; end
        9:  begin t = {8'd3, " OK", 80'd0}; n = 4; end
        10: begin t = {8'd4, " BACK", 64'd0}; n = 6; end
        11: begin t = {8'd3, " PLAY CART", 24'd0}; n = 11; end
        12: begin t = {8'd3, " ALL GAMES", 24'd0}; n = 11; end
        13: begin t = {8'd6, " SETTING", 40'd0}; n = 9; end
        14: begin t = {8'd5, " CHANGE", 48'd0}; n = 8; end
        default: begin t = 112'd0; n = 0; end
        endcase
        hint_char = (j < n) ? t[111 - j * 8 -: 8] : 8'd0;
    end
endfunction
// the hint in slot sl (0..4) of a context, 15 past the end (the Select hint is 3 + next; none when next is 0)
function [3:0] leg_hint(input [3:0] ctx, input [1:0] nxt, input lt_, input [2:0] sl);
    reg [3:0] selh; reg [3:0] h0, h1, h2, h3, h4;
    begin
        selh = (nxt == 0) ? 4'd15 : 4'd3 + {2'd0, nxt};
        h0 = 4'd15; h1 = 4'd15; h2 = 4'd15; h3 = 4'd15; h4 = 4'd15;
        case (ctx)
        1, 2, 3, 4: begin
            h0 = (ctx == 3 || ctx == 4) ? 4'd1 : 4'd0; h1 = 4'd2; h2 = 4'd3;
            if (selh != 4'd15) begin h3 = selh; h4 = (lt_ && (ctx == 1 || ctx == 3)) ? 4'd7 : 4'd15; end
            else h3 = (lt_ && (ctx == 1 || ctx == 3)) ? 4'd7 : 4'd15;
        end
        5: begin h0 = 4'd8; h1 = 4'd9; h2 = 4'd10; end
        6: begin h0 = 4'd11; h1 = selh; end
        7: begin h0 = 4'd12; h1 = 4'd0; h2 = selh; end
        8: begin h0 = selh; end
        9: begin h0 = 4'd13; h1 = 4'd14; h2 = 4'd10; end
        default: ;
        endcase
        case (sl) 0: leg_hint = h0; 1: leg_hint = h1; 2: leg_hint = h2; 3: leg_hint = h3; default: leg_hint = h4; endcase
    end
endfunction
always @(posedge clk_74a) begin
    if (gn_i == 0) begin
        if (gn != gn_src) begin gn_src <= gn; gn_sh <= gn; gacc <= 0; gn_i <= 4'd11; end
    end else begin : dd
        reg [15:0] a;
        a = gacc;
        if (a[3:0] > 4'd4) a[3:0] = a[3:0] + 4'd3;
        if (a[7:4] > 4'd4) a[7:4] = a[7:4] + 4'd3;
        if (a[11:8] > 4'd4) a[11:8] = a[11:8] + 4'd3;
        if (a[15:12] > 4'd4) a[15:12] = a[15:12] + 4'd3;
        gacc <= {a[14:0], gn_sh[10]}; gn_sh <= {gn_sh[9:0], 1'b0}; gn_i <= gn_i - 1'b1;
        if (gn_i == 4'd1) gbcd <= {a[14:0], gn_sh[10]};
    end
end
// the selected game's favorite state: the newest change made on the Pocket, else the pack's flag
reg cur_fav = 0;
integer fq;
always @(posedge clk_74a) begin : favq
    reg f;
    f = cur_favp;
    for (fq = 0; fq < FN; fq = fq + 1) if (fq < fv_n && fv_crc[fq] == cur_crc) f = fv_st[fq];
    cur_fav <= f;
end

always @(posedge clk_74a) begin
    done_1                   <= target_dataslot_done;
    target_dataslot_read     <= 0;
    target_dataslot_openfile <= 0;
    target_dataslot_write    <= 0;
    vt_go                    <= 0;
    g_go                     <= 0;
    lt_go                    <= 0;
    zm_go                    <= 0;
    lstr_we                  <= 0;
    picker_reset             <= 0;
    param_we                 <= 0;
    map_we                   <= 0;
    map2_we                  <= 0;
    ago                      <= 0;
    tag_we                   <= 0;
    need_clr                 <= 0;
    if (step_l) pend_l <= 1;
    if (step_r) pend_r <= 1;
    if (press_a) pend_a <= 1;
    if (press_up) pend_u <= 1;
    if (press_dn) pend_d <= 1;
    if (press_x) pend_x <= 1;
    if (press_sel) pend_s <= 1;
    if (press_y) pend_y <= 1;
    if (press_b) pend_b <= 1;
    if (press_l) pend_jl <= 1;
    if (press_r) pend_jr <= 1;
    cpd_s <= {cpd_s[1:0], cprobe_done};

    // idle time with the menu up and no buttons held (the live cart check leaves S_MENU every second: keep counting)
    if (menu_active && cont1_key[15:0] == 0) begin if (mt != 28'd250_000_000) mt <= mt + 1'b1; end else mt <= 0;
    if (state == S_MENU && rp_tmr != 28'd250_000_000) rp_tmr <= rp_tmr + 1'b1;

    case (state)
    S_BOOT: begin
        // hold the Game Boy explicitly: the power-up value of hold_gb is not reliable on hardware (seen low in build 14)
        menu_active <= 0; picker_download <= 0; game_loaded <= 0; idx <= 0; level_target <= 0; hold_gb <= 1;
        art_load <= 0; cart_mode <= 0; cart_found <= 0; cart_view <= 0; cart_checked <= 0; cart_present <= 0; rp <= 0; cart_last <= 0;
        // clear the per-game suspend table and the cover cache tags (power-up contents are not trusted)
        if (clr != 12'd2048) begin
            if (clr < (12'd1 << CB)) begin tag_we <= 1; tag_wa <= clr[CB-1:0]; tag_wd <= 12'd0; end
            clr <= clr + 1'b1;
        end
        if (!core_ready) boot_timer <= 0;
        else if (boot_timer != 27'd37_000_000) boot_timer <= boot_timer + 1'b1;
        else if (clr == 12'd2048) state <= enable ? S_HDR_REQ : S_OFF;
    end

    S_HDR_REQ: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= 32'd0;
        target_dataslot_bridgeaddr <= BRIDGE_PACK; target_dataslot_length <= 32'd16;
        target_dataslot_read <= 1; state <= S_HDR_WAIT;
    end
    S_HDR_WAIT: if (done_rise) begin
        if (target_dataslot_err != 0) state <= S_OFF;
        else begin ent_raddr <= 11'd2; state <= S_HDR_A; end
    end
    S_HDR_A: begin ent_raddr <= 11'd3; state <= S_HDR_B; end
    S_HDR_B: begin pver <= ent_q; state <= S_HDR_C; end
    S_HDR_C: begin
        count <= (ent_q == 0) ? 11'd0 : (ent_q > MAX_ENTRIES ? MAX_ENTRIES[10:0] : ent_q[10:0]);
        state <= (ent_q == 0) ? S_OFF : S_HDR_D;
    end
    S_HDR_D: begin stride <= (pver >= 16'd7) ? 32'd65536 : BLOB_BYTES; blob0 <= ENT_OFF + {14'd0, count, 7'd0}; state <= S_HDR_E; end
    S_HDR_E: begin lay_t <= count * stride; state <= S_HDR_F; end
    S_HDR_F: begin paths0 <= blob0 + lay_t; idx_ok <= 0; sec_ok <= 0; state <= (pver >= 16'd7) ? S_IDX_REQ : S_LOAD; end
    // ---- letter index: 60 bytes from file offset 16 into ent_ram words 200.. ("IDX1", played, favorites, 27 starts)
    S_IDX_REQ: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= 32'd16;
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd400; target_dataslot_length <= 32'd64;
        target_dataslot_read <= 1; state <= S_IDX_W;
    end
    S_IDX_W: if (done_rise) begin
        if (target_dataslot_err != 0) state <= S_LOAD;
        else begin sj <= 0; ent_raddr <= 11'd200; state <= S_IDX_RD; end
    end
    S_IDX_RD: begin ent_raddr <= ent_raddr + 1'b1; state <= S_IDX_RD2; end   // two-cycle read latency
    S_IDX_RD2: begin                                 // ent_q = word 200 + sj
        ent_raddr <= ent_raddr + 1'b1;
        case (sj)
        0: if (ent_q != 16'h4449) state <= S_LOAD;                     // "ID"
        1: if (ent_q != 16'h3158) state <= S_LOAD;                     // "X1"
        2: begin sec_start[0] <= 11'd0; sec_ok[0] <= ent_q != 0; fav_count <= ent_q[10:0]; end   // favorites (offset 20)
        3: if (ent_q != 0) sec_ok[0] <= 1;                             // played (offset 22)
        default: begin
            sec_start[sj - 5'd3] <= ent_q[10:0];
            sec_ok[sj - 5'd3] <= ent_q != 16'hFFFF && ent_q[10:0] < count;
        end
        endcase
        sj <= sj + 1'b1;
        if (sj == 5'd30) begin idx_ok <= 1; fv_n <= 0; fav_mode <= fav_count != 0; idx <= 11'd0; aidx <= fav_count; state <= S_CR0; end
    end
    // ---- CRT1 block, 20 bytes from file offset 96 into ent_ram words 540..: "CRT1", default image offset, list
    // length, flags (bit 0: carts.cfg path), three glow colors
    S_CR0: begin
        crt_ok <= 0; crl_ok <= 0; crt_off <= 0; lcount <= 0; crt_flags <= 0;
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= 32'd96;
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd1080; target_dataslot_length <= 32'd20;
        target_dataslot_read <= 1; op_ret <= S_CR1; state <= S_XFER_W;
    end
    S_CR1: if (xerr != 0) state <= S_FV0; else begin sj <= 0; ent_raddr <= 11'd540; state <= S_CR2; end
    S_CR2: begin                                     // ent_q = word 540 + sj - 1 (two-cycle read latency)
        ent_raddr <= ent_raddr + 1'b1; sj <= sj + 1'b1;
        case (sj)
        1: if (ent_q != 16'h5243) state <= S_FV0;                    // "CR"
        2: if (ent_q != 16'h3154) state <= S_FV0;                    // "T1"
        3: crt_off[15:0] <= ent_q;
        4: crt_off[31:16] <= ent_q;
        5: lcount <= ent_q[10:0];
        6: begin crl_ok <= ent_q[0]; crt_flags <= ent_q; end
        7: crt_acc[0] <= ent_q;
        8: crt_acc[1] <= ent_q;
        9: begin crt_acc[2] <= ent_q; crt_ok <= 1; state <= S_FV0; end
        default: ;
        endcase
    end
    // ---- favorites.cfg: open it (create if missing) and read the changes not yet synced into fv_*
    S_FV0: begin pfav <= 1; pflags <= 32'd3; psize <= 32'd4096; op_slot <= FAV_SLOT; op_ret <= S_FV1; state <= S_PREAD; end
    S_FV1: begin
        pfav <= 0;
        fl_ret <= S_LOAD;
        if (oerr > 3'd1) state <= S_FL0;                                   // no path in the pack, or refused
        else begin
            fav_ok <= 1;
            target_dataslot_id <= FAV_SLOT; target_dataslot_slotoffset <= 32'd0;
            target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd600; target_dataslot_length <= 32'd256;
            target_dataslot_read <= 1; op_ret <= S_FV2; state <= S_XFER_W;
        end
    end
    S_FV2: begin
        if (xerr != 0) state <= S_FL0;
        else begin fw <= 0; ent_raddr <= 11'd300; state <= S_FV3; end
    end
    S_FV3: begin                                     // ent_q = word 300 + fw - 1 (two-cycle read latency)
        ent_raddr <= ent_raddr + 1'b1; fw <= fw + 1'b1;
        if (fw == 7'd1 && ent_q != 16'h4146) state <= S_FL0;                    // "FA"
        if (fw == 7'd2 && ent_q != 16'h3156 && ent_q != 16'h3256) state <= S_FL0; // "V1" or "V2"
        if (fw == 7'd2) fv_v2 <= ent_q == 16'h3256;
        if (fw == 7'd4) fj <= (ent_q > FN) ? FN[3:0] : ent_q[3:0];              // n (word 303)
        if (fw >= 7'd5) begin : rec                                             // records from word 304: 4 or 8 words
            reg [6:0] w; reg [3:0] r; reg [2:0] f;
            w = fw - 7'd5; r = fv_v2 ? w[6:3] : w[6:2]; f = fv_v2 ? w[2:0] : {1'b0, w[1:0]};
            if (r < fj && r < FN) begin
                case (f)
                0: fv_crc[r][15:0]  <= ent_q;
                1: fv_crc[r][31:16] <= ent_q;
                2: begin fv_st[r] <= ent_q[0]; fv_n <= r + 1'b1; fv_fp[r] <= 11'h7FF; fv_ap[r] <= 0; end
                4: fv_fp[r] <= ent_q[10:0];
                5: fv_ap[r] <= ent_q[10:0];
                default: ;
                endcase
            end
            if (w == 7'd124 || r >= fj) state <= S_FL0;
        end
    end
    // ---- write favorites.cfg from fv_* (served at FAV_ADDR), then back to the options menu
    S_FW0: begin
        if (!fav_ok) state <= S_GMA;
        else begin pfav <= 1; pflags <= 32'd3; psize <= 32'd4096; op_slot <= FAV_SLOT; op_ret <= S_FW1; state <= S_PREAD; end
    end
    S_FW1: begin
        pfav <= 0;
        if (oerr > 3'd1) state <= S_GMA;
        else begin
            target_dataslot_id <= FAV_SLOT; target_dataslot_slotoffset <= 32'd0;
            target_dataslot_bridgeaddr <= FAV_ADDR; target_dataslot_length <= 32'd4096;
            fl_ret <= S_GMA; target_dataslot_write <= 1; op_ret <= live ? S_FL0 : S_GMA; state <= S_XFER_W;
        end
    end
    // ---- options menu (X): Left/Right choose, A confirms, B or X closes. The platform line shows the option.
    S_GMA: if (tlevel == 0) state <= S_LOAD2;      // fade the text, relayout (S_MAP_DONE returns here or to S_MENU)
           else tl_target <= 0;
    S_GM: begin
        if (pend_l || pend_r) begin : cyc
            reg [1:0] o;
            o = pend_r ? gm_sel + 1'b1 : gm_sel - 1'b1;
            if (o == 2'd1 && !cur_susp) o = pend_r ? 2'd2 : 2'd0;    // Start over only for a suspended game
            pend_l <= 0; pend_r <= 0; gm_sel <= o; state <= S_GMA;
        end else if (pend_a) begin
            pend_a <= 0;
            case (gm_sel)
            0: begin gm_on <= 0; level_target <= 0; zm_go <= 1; zm_in <= 1; state <= S_LAUNCH_FADE; end
            1: begin pk <= PK_SUS; pflags <= 32'd2; psize <= 0; op_slot <= SUS_SLOT; op_ret <= S_GMF; state <= S_PREAD; end
            2: begin                                 // record the change; the newest record for a CRC wins
                if (fv_n == FN) begin : shift
                    integer si2;
                    for (si2 = 0; si2 < FN - 1; si2 = si2 + 1) begin fv_crc[si2] <= fv_crc[si2 + 1]; fv_st[si2] <= fv_st[si2 + 1]; fv_fp[si2] <= fv_fp[si2 + 1]; fv_ap[si2] <= fv_ap[si2 + 1]; end
                    fv_crc[FN - 1] <= cur_crc; fv_st[FN - 1] <= !cur_fav; fv_fp[FN - 1] <= cur_fp; fv_ap[FN - 1] <= cur_ap;
                end else begin fv_crc[fv_n] <= cur_crc; fv_st[fv_n] <= !cur_fav; fv_fp[fv_n] <= cur_fp; fv_ap[fv_n] <= cur_ap; fv_n <= fv_n + 1'b1; end
                fl_lift <= live && fav_mode && cur_fav;   // unstarring in Favorites: the cover leaves the list
                state <= S_FW0;
            end
            default: begin gm_on <= 0; state <= S_GMA; end
            endcase
        end else if (press_b || pend_x) begin pend_x <= 0; pend_b <= 0; gm_on <= 0; state <= S_GMA; end
        if (pend_u || pend_d || pend_s) begin pend_u <= 0; pend_d <= 0; pend_s <= 0; end
    end
    S_GMF: begin cur_susp <= 0; gm_on <= 0; level_target <= 0; zm_go <= 1; zm_in <= 1; state <= S_LAUNCH_FADE; end   // emptied: boot fresh
    // ---- a favorite changed: rebuild the live list; an unstarred favorite lifts out of Favorites mode
    S_FL0: begin fl_req <= ~fl_req; state <= S_FL1; if (fl_lift) begin lt_go <= 1; gm_on <= 0; end end
    S_FL1: if (fl_valid) begin
        if (fl_lift) begin fl_lift <= 0; if (idx > lfav_n) idx <= lfav_n; lerr <= 0; tl_target <= 0; state <= S_FADE; end
        else state <= fl_ret;
    end
    // ---- Play Cartridge: read the header, look it up in the pack, show the cover or boot the cart at once
    S_CP0: begin cprobe_req <= ~cprobe_req; tmr <= 0; state <= S_CP1; end
    S_CP1: begin
        tmr <= tmr + 1'b1;
        if (cpd_s[2] != cpd_s[1]) state <= S_CP2;
        else if (tmr == 28'd3_700_000) state <= cp_none;                     // 50 ms: no answer, just play
    end
    S_CP2: if (!hdr_ok(cart_hdr)) begin
               if (rp && !cart_present) begin rp <= 0; state <= S_MENU; end     // still no cart
               else begin cart_present <= 0; cart_last <= 0; state <= cp_none; end
           end else if (rp && cart_present && cart_hdr == cart_last) begin rp <= 0; state <= S_MENU; end   // same cart
           else begin cart_present <= 1; cart_last <= cart_hdr; tcrc <= 32'hFFFFFFFF; tb <= 0; tbit <= 0; state <= S_CPH; end
    S_CPH: begin : crcstep                           // zlib CRC32, one bit per clock (88 clocks)
        reg [31:0] c;
        c = (tbit == 0) ? tcrc ^ {24'd0, cart_hdr[tb * 8 +: 8]} : tcrc;
        c = {1'b0, c[31:1]} ^ (c[0] ? 32'hEDB88320 : 32'd0);
        tbit <= tbit + 1'b1;
        if (tbit == 3'd7) begin
            if (tb == 4'd10) begin tcrc <= ~c; lgh_req <= ~lgh_req; state <= (pver < 16'd7) ? cp_none : S_CPH2; end
            else begin tcrc <= c; tb <= tb + 1'b1; end
        end else tcrc <= c;
    end
    S_CPH2: begin
               target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= 32'd80;
               target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd1000; target_dataslot_length <= 32'd12;
               target_dataslot_read <= 1; op_ret <= S_CP3; state <= S_XFER_W;
           end
    S_CP3: if (xerr != 0) state <= cp_none; else begin sj <= 0; ent_raddr <= 11'd500; state <= S_CP4; end
    S_CP4: begin                                     // words 500..504: "FP" "R2" offset lo, offset hi, count
        ent_raddr <= ent_raddr + 1'b1; sj <= sj + 1'b1;
        if (sj == 5'd1 && ent_q != 16'h5046) state <= cp_none;
        if (sj == 5'd2 && ent_q != 16'h3252) state <= cp_none;
        if (sj == 5'd3) fp_off[15:0] <= ent_q;
        if (sj == 5'd4) fp_off[31:16] <= ent_q;
        if (sj == 5'd5) begin fp_cnt <= (ent_q > count) ? count : ent_q[10:0]; fp_ck <= 0; m_ex <= 0; m_ti <= 0; state <= S_CP5; end
    end
    S_CP5: if (fp_ck >= fp_cnt) state <= S_CPD;       // searched everything
           else begin                                // the next 64 records (8 bytes each) into words 600..855
               fp_n <= (fp_cnt - fp_ck > 11'd64) ? 11'd64 : fp_cnt - fp_ck;
               target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= fp_off + {18'd0, fp_ck, 3'b000};
               target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd1200;
               target_dataslot_length <= ((fp_cnt - fp_ck > 11'd64) ? 32'd512 : {18'd0, fp_cnt - fp_ck, 3'b000});
               target_dataslot_read <= 1; op_ret <= S_CP6; state <= S_XFER_W;
           end
    S_CP6: if (xerr != 0) state <= cp_none; else begin fp_j <= 0; ent_raddr <= 11'd600; state <= S_CP7; end
    // record fp_j is words 600 + 4j: {0x14F, 0x14E}, {0x143, 0x14D}, title CRC low, title CRC high
    S_CP7:  begin ent_raddr <= 11'd601 + {fp_j[8:0], 2'b00}; state <= S_CP8; end
    S_CP8:  begin fp_w0 <= ent_q; ent_raddr <= 11'd602 + {fp_j[8:0], 2'b00}; state <= S_CP9; end
    S_CP9:  begin fp_w1 <= ent_q; ent_raddr <= 11'd603 + {fp_j[8:0], 2'b00}; state <= S_CP10; end
    S_CP10: begin fp_w2 <= ent_q; state <= S_CP11; end
    S_CP11: begin
        if (!m_ex && fp_w0 == {cart_hdr[27*8 +: 8], cart_hdr[26*8 +: 8]} && fp_w1[7:0] == cart_hdr[25*8 +: 8]) begin
            m_ex <= 1; m_exi <= fp_ck + fp_j;                                           // same revision
        end
        if (!m_ti && {ent_q, fp_w2} == tcrc) begin m_ti <= 1; m_tii <= fp_ck + fp_j; end   // same title, any revision
        if (fp_j + 1'b1 == fp_n) begin fp_ck <= fp_ck + fp_n; state <= S_CP5; end
        else begin fp_j <= fp_j + 1'b1; ent_raddr <= 11'd600 + {fp_j[8:0] + 9'd1, 2'b00}; state <= S_CP7; end
    end
    S_CPD: if (m_ex || m_ti) begin cart_unk <= 0; cart_bad <= 0; cart_idx <= m_ex ? m_exi : m_tii; state <= S_CPM; end
           else if (crt_ok && crt_off != 0 && count < 11'd2045) begin  // not in the pack: a default cartridge image
               cart_unk <= 1; cart_bad <= !title_ascii(cart_hdr); cart_type <= ctype(cart_hdr); cart_idx <= count + ctype(cart_hdr);
               state <= S_CPM;
           end else state <= cp_none;
    S_CPM: begin                                     // show the cart: it drops in over the list (or the empty slot)
        if (!cart_view) begin lidx <= idx; lmode <= fav_mode; if (fav_mode) fidx <= idx; else aidx <= idx; end
        idx <= cart_idx; cart_found <= 1; cart_view <= 1; cart_none <= 0; fav_mode <= 0; lbl_on <= 0; rp <= 0; tl_target <= 0;
        vt_go <= 1; vt_in <= 1; vt_fx <= 1;
        cl_ret <= S_FADE; state <= (cart_unk && !cart_bad && crl_ok && cart_hdr != crl_last) ? S_CL0 : S_FADE;
    end
    S_CPX: begin
        cart_found <= 0;
        if (!rp) state <= cart_play ? S_CRUN0 : S_LOAD;                        // boot: Play Cartridge boots it anyway
        else begin
            rp <= 0;
            if (cart_view) begin                                               // the cart we were showing is gone
                cart_view <= 0; fav_mode <= lmode; idx <= (lidx < lcnt) ? lidx : 11'd0; lbl_on <= 1; lbl_sec <= 5'd29; lerr <= 0; tl_target <= 0;
                vt_go <= 1; vt_in <= 0; vt_fx <= 1; state <= S_FADE;
            end else state <= S_MENU;
        end
    end
    // ---- carts.cfg: append the unknown cart's header (read the record count, write the record, then the count)
    S_CL0: begin pcart <= 1; pflags <= 32'd3; psize <= 32'd4096; op_slot <= CARTS_SLOT; op_ret <= S_CL1; state <= S_PREAD; end
    S_CL1: begin
        pcart <= 0;
        if (oerr > 3'd1) state <= S_CLX;
        else begin
            target_dataslot_id <= CARTS_SLOT; target_dataslot_slotoffset <= 32'd0;
            target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd1100; target_dataslot_length <= 32'd16;
            target_dataslot_read <= 1; op_ret <= S_CL2; state <= S_XFER_W;
        end
    end
    S_CL2: if (xerr != 0) state <= S_CLX; else begin crl_n <= 0; sj <= 0; ent_raddr <= 11'd550; state <= S_CL3; end
    S_CL3: begin                                     // ent_q = word 550 + sj - 1: "CR" "L1" version n
        ent_raddr <= ent_raddr + 1'b1; sj <= sj + 1'b1;
        if (sj == 5'd1 && ent_q != 16'h5243) state <= S_CL4;               // new or empty file: record 0
        if (sj == 5'd2 && ent_q != 16'h314C) state <= S_CL4;
        if (sj == 5'd4) begin crl_n <= (ent_q > 16'd127) ? 7'd127 : ent_q[6:0]; state <= S_CL4; end
    end
    S_CL4: if (crl_n == 7'd127) state <= S_CLX;                            // full until the next sync empties it
           else begin
               target_dataslot_id <= CARTS_SLOT; target_dataslot_slotoffset <= {20'd0, crl_n, 5'd0} + 32'd16;
               target_dataslot_bridgeaddr <= CRL_ADDR + 32'd16; target_dataslot_length <= 32'd32;
               target_dataslot_write <= 1; op_ret <= S_CL5; state <= S_XFER_W;
           end
    S_CL5: if (xerr != 0) state <= S_CLX; else begin crl_n <= crl_n + 1'b1; state <= S_CL6; end
    S_CL6: begin
        target_dataslot_id <= CARTS_SLOT; target_dataslot_slotoffset <= 32'd0;
        target_dataslot_bridgeaddr <= CRL_ADDR; target_dataslot_length <= 32'd16;
        target_dataslot_write <= 1; op_ret <= S_CLX; state <= S_XFER_W;
    end
    S_CLX: begin crl_last <= cart_hdr; state <= cl_ret; end
    S_CRUN0: begin                                   // boot the cart: the Game Boy runs it in physical mode
        level_target <= 0;
        if (level == 0) begin
            cart_view <= 0; cart_mode <= 1; menu_active <= 0; game_loaded <= 1; picker_reset <= 1; hold_gb <= 0; state <= S_CRUN;
        end
    end
    S_CRUN: if (press_l) begin pause_gb <= 1; psel <= 0; pmsg <= 0; ovl <= 1; snd_open <= ~snd_open; state <= S_PAUSE; end   // playing the cart: L pauses
    // ---- jump: the nearest section start after idx (down) or before it (up), wrapping around the list
    S_JMP0: begin sj <= 0; jhave <= 0; jwhave <= 0; state <= S_JMP1; end
    S_JMP1: begin
        if (sec_ok[sj] && (sj != 0 || fav_count == 0)) begin   // the favorites (section 0) are not in All
            if (!jup && sec_start[sj] > idx && (!jhave || sec_start[sj] < sec_start[jbest])) begin jbest <= sj; jhave <= 1; end
            if ( jup && sec_start[sj] < idx && (!jhave || sec_start[sj] > sec_start[jbest])) begin jbest <= sj; jhave <= 1; end
            if (!jwhave || (!jup ? sec_start[sj] < sec_start[jwrap] : sec_start[sj] > sec_start[jwrap])) begin jwrap <= sj; jwhave <= 1; end
        end
        sj <= sj + 1'b1;
        if (sj == 5'd27) state <= S_JMP2;
    end
    S_JMP2: begin
        if ((jhave || jwhave) && sec_start[jhave ? jbest : jwrap] != idx) begin
            idx <= sec_start[jhave ? jbest : jwrap]; lbl_sec <= jhave ? jbest : jwrap; lbl_on <= 1;
            last_left <= jup; lerr <= 0; tl_target <= 0; state <= S_FADE;
            if (grid) begin g_go <= 1; g_kind <= 0; end
        end else state <= S_MENU;
    end

    // ---- cover loader: fetch need_g into its cache slot, then return to af_ret
    S_AF0: begin
        af_g <= need_g; art_load <= 1; tmr <= 0;
        tag_we <= 1; tag_wa <= need_g[CB-1:0]; tag_wd <= {1'b0, need_g};      // slot invalid while it is rewritten
        state <= S_AF0W;
    end
    S_AF0W: begin                                    // art_off settles two cycles after af_g
        tmr <= tmr + 1'b1;
        if (tmr == 28'd3) begin
            target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= art_off;
            target_dataslot_bridgeaddr <= ART_BRIDGE + ({21'd0, af_g} % (32'd1 << CB) << 16); target_dataslot_length <= BLOB_BYTES;
            target_dataslot_read <= 1; state <= S_AF1;
        end
    end
    S_AF1: if (done_rise) begin
        tmr <= 0;
        if (target_dataslot_err != 0) begin
            dbg_art_err <= 1;
            if (art_try != 0) begin art_try <= art_try - 1'b1; state <= S_AFRT; end
            else begin art_try <= 2'd3; state <= S_AF2; end    // give up: show what arrived rather than retry forever
        end else begin art_try <= 2'd3; state <= S_AF2; end
    end
    S_AF2: begin                                     // let the last words drain into SDRAM, then mark the slot valid
        tmr <= tmr + 1'b1;
        if (tmr == 28'd4000) begin
            art_load <= 0; dbg_art_done <= 1;
            tag_we <= 1; tag_wa <= af_g[CB-1:0]; tag_wd <= {1'b1, af_g}; need_clr <= 1;
            state <= af_ret;
        end
    end
    S_AFRT: begin                                    // the host refused the read: wait 20 ms and ask again
        tmr <= tmr + 1'b1;
        if (tmr == 28'd1_480_000) begin art_load <= 0; need_clr <= 1; state <= af_ret; end
    end

    // ---- load the selection: read its entry, probe its suspend file once, lay out the title and platform
    S_LOAD: if (!cart_checked) begin cart_checked <= 1; state <= S_CP0; end
    else if (vsel || vtile) state <= S_VLOAD;
    else if (!g_cur_ok) ;                            // the game at the selection is still being looked up
    else begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= ENT_OFF + {14'd0, cur_g, 7'd0};
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd16; target_dataslot_length <= 32'd128;
        target_dataslot_read <= 1; state <= S_LOADE;
    end
    S_LOADE: if (done_rise) begin ent_raddr <= ebase + 11'd24; state <= S_LC1; end   // CRC, words 24 and 25
    S_LC1: begin ent_raddr <= ebase + 11'd25; state <= S_LC2; end
    S_LC2: begin cur_crc[15:0] <= ent_q; ent_raddr <= ebase + 11'd20; state <= S_LC3; end
    S_LC3: begin cur_crc[31:16] <= ent_q; ent_raddr <= ebase + 11'd21; state <= S_LC4; end
    S_LC4: begin cur_favp <= ent_q[1] && pver >= 16'd7; ent_raddr <= ebase + 11'd62; state <= S_LC5; end
    S_LC5: begin cur_acc <= (pver >= 16'd7 && ent_q != 0) ? ent_q : ACC_DEFAULT; ent_raddr <= ebase + 11'd63; state <= S_LC6; end   // word 21
    S_LC6: begin cur_fp <= live ? ent_q[10:0] : 11'h7FF; state <= S_LC7; end                // word 62: favorites position
    S_LC7: begin cur_ap <= live ? ent_q[10:0] : idx; state <= S_LOADK; end                 // word 63: A to Z position
    S_VLOAD: begin                                   // a cart the pack doesn't know: title from its header
        cur_known <= !vtile && !cart_none; cur_susp <= 0; cur_crc <= 0; cur_favp <= 0; cur_acc <= cart_none ? 16'd0 : crt_acc[cart_type];
        state <= S_LOAD2;
    end
    S_LOADK: begin
        cur_known <= 0; cur_susp <= 0;
        ent_raddr <= ebase + 11'd20;                // flags word, read by the layout as it starts (S_MAP_FETCH)
        pk <= PK_SUS; pflags <= 0; psize <= 0; op_slot <= SUS_SLOT; op_ret <= S_PROBE1; state <= S_PREAD;
    end
    S_PROBE1: if (oerr != 0) begin cur_known <= 1; cur_susp <= 0; ent_raddr <= ebase + 11'd20; state <= S_LOAD2; end
              else begin
                  target_dataslot_id <= SUS_SLOT; target_dataslot_slotoffset <= 0;
                  target_dataslot_bridgeaddr <= PARAM_ADDR + 32'h190; target_dataslot_length <= 32'd4;
                  target_dataslot_read <= 1; op_ret <= S_PROBE2; state <= S_XFER_W;
              end
    S_PROBE2: begin cur_known <= 1; cur_susp <= (xerr == 0); ent_raddr <= ebase + 11'd20; state <= S_LOAD2; end
    S_LOAD2: begin                                   // build the legend string, then lay out the three lines
        lonly <= 0; lb_h <= 0; lb_j <= 0; lb_g <= 0; lb_n <= 0; leg_built <= leg_key; state <= S_LB1;
    end
    S_LB0: begin                                     // the string is built: lay out everything, or line 3 only
        if (lonly) begin k <= 0; line2 <= 1; line3 <= 1; lf <= 1; mp <= 11'd1024; state <= S_MAP_FETCH; end
        else begin
            k <= 0; line2 <= 0; line3 <= 0; lf <= 1; mp <= 11'd0; state <= S_MAP_FETCH;
            ent_raddr <= ebase + 11'd20; // flags byte (byte 40) for the platform line
        end
    end
    S_LB1: begin : build                             // one character of the legend string per cycle
        reg [3:0] h, hn; reg [7:0] c;
        h = leg_hint(leg_built[6:3], leg_built[2:1], leg_built[0], lb_h);
        hn = leg_hint(leg_built[6:3], leg_built[2:1], leg_built[0], lb_h + 3'd1);
        c = (h == 4'd15) ? 8'd0 : hint_char(h, lb_j);
        lstr_wa <= lb_n;                             // every write lands at the string's current length
        if (lb_g != 0) begin                         // the three spaces between hints
            lstr_we <= 1; lstr_wd <= 6'd27; lb_n <= lb_n + 1'b1; lb_g <= lb_g - 1'b1;
            if (lb_g == 2'd1) begin lb_h <= lb_h + 1'b1; lb_j <= 0; end
        end else if (h == 4'd15 || lb_h == 3'd5 || lb_n == 6'd62) begin   // the end: a terminator
            lstr_we <= 1; lstr_wd <= 6'd0; state <= S_LB0;
        end else if (c == 8'd0) begin                // this hint ended: a gap if another follows, else the end
            if (hn == 4'd15 || lb_h == 3'd4) begin lstr_we <= 1; lstr_wd <= 6'd0; state <= S_LB0; end
            else lb_g <= 2'd3;
        end else begin
            lstr_we <= 1; lstr_wd <= leg_code(c); lb_n <= lb_n + 1'b1; lb_j <= lb_j + 1'b1;
        end
    end
    S_MAP_FETCH: begin
        if (line3) begin lstr_ra <= k; state <= S_MAP_WAIT; end
        else if (line2) state <= S_MAP_CHAR;
        else begin ent_raddr <= ebase + k[5:1]; state <= S_MAP_WAIT; end
        if (k == 0 && !line2 && lf) is_gb <= vsel ? !cart_hdr[15 * 8 + 7] : ent_q[0];   // ent_q holds word 20 here (set in S_LB0)
    end
    S_MAP_WAIT:  state <= S_MAP_WAIT2;
    S_MAP_WAIT2: state <= S_MAP_WAIT3;
    S_MAP_WAIT3: begin                               // the character, registered: its mux is long and the width lookup follows
        chr <= line3 ? {2'b0, lstr_q} : cart_none ? none_char(k) : vsel ? (cart_bad ? bad_char(k) : hdr_char(cart_hdr, k)) :
               vtile ? tile_char(k) :
               (k[0] ? ent_q[15:8] : ent_q[7:0]);
        state <= S_MAP_CHAR;
    end
    S_MAP_CHAR: begin
        ch = (line2 && !line3) ? pch : chr;
        gw = line3 ? wrom3[ch[5:0]] : lf ? wrom2[ch[6:0]] : wrom[ch[6:0]];
        if (ch == 0 || k == (line3 ? 6'd63 : line2 ? 6'd24 : 6'd40) || (line3 ? mp >= 11'd1332 : lf ? mp[8:0] >= 9'd500 : mp[7:0] >= 8'd250)) state <= S_MAP_DONE;
        else if (gw == 0) begin k <= k + 1'b1; state <= S_MAP_FETCH; end
        else begin col <= 0; state <= S_MAP_COL; end
    end
    S_MAP_COL: begin
        if (lf) begin map2_we <= 1; map2_wa <= mp; map2_wd <= {1'b1, ch[6:0], col}; end else begin map_we <= 1; map_wa <= mp[8:0]; map_wd <= {1'b1, ch[6:0], col[2:0]}; end
        mp <= mp + 1'b1; col <= col + 1'b1;
        if (col + 1'b1 == gw) begin
            if (lf) begin k <= k + 1'b1; state <= S_MAP_FETCH; end   // advance widths include the spacing
            else state <= S_MAP_GAP;
        end
    end
    S_MAP_GAP: begin
        map_we <= 1; map_wa <= mp[8:0]; map_wd <= {1'b1, ch[6:0], 3'd7};   // blank column between glyphs
        mp <= mp + 1'b1; k <= k + 1'b1; state <= S_MAP_FETCH;
    end
    S_MAP_DONE: begin
        if (lf && !line2) begin htw <= mp[8:0]; line2 <= 1; k <= 0; mp <= 11'd512; state <= S_MAP_FETCH; end
        else if (lf && !line3) begin hsw <= mp[8:0]; line3 <= 1; k <= 0; mp <= 11'd1024; state <= S_MAP_FETCH; end
        else if (lf && lonly) begin lgw <= mp[8:0]; line3 <= 0; line2 <= 0; lf <= 0; lonly <= 0; state <= S_MENU; end
        else if (lf) begin lgw <= mp[8:0]; lf <= 0; line2 <= 0; line3 <= 0; k <= 0; mp <= 11'd0; state <= S_MAP_FETCH; end
        else begin
            title_w <= (mp[7:0] == 0) ? 8'd0 : mp[7:0] - 1'b1;   // drop the trailing gap
            if (!menu_active) lflush_req <= 1;          // fresh menu (boot or Home): write the log once it is idle
            if (!menu_active) begin pend_l <= 0; pend_r <= 0; pend_a <= 0; pend_u <= 0; pend_d <= 0; pend_x <= 0; pend_s <= 0; pend_y <= 0; pend_b <= 0; pend_jl <= 0; pend_jr <= 0; end   // presses from before the menu showed
            gen <= ~gen; menu_active <= 1; level_target <= 4'd8; state <= gm_on ? S_GM : S_MENU;
            if (zm_home) begin zm_home <= 0; zm_go <= 1; zm_in <= 0; end   // back from a game: the cover shrinks into place
            tl_target <= vt_txt ? 4'd0 : 4'd8; tl_hold <= vt_txt;   // after a cartridge transition lands
        end
    end

    S_MENU: begin
        if (!menu_active) begin gen <= ~gen; menu_active <= 1; level_target <= 4'd8; tl_target <= 4'd8; end
        if (tl_hold && !vt_txt) begin tl_hold <= 0; tl_target <= 4'd8; end
        if (vt_busy) begin                           // a cartridge transition: only fetch covers (presses wait)
            if (need_ok) begin af_ret <= S_MENU; state <= S_AF0; end
        end else if (cart_view) begin
            pend_u <= 0; pend_d <= 0; pend_x <= 0; pend_y <= 0; pend_b <= 0; pend_jl <= 0; pend_jr <= 0;
            if (pend_a && cart_none) pend_a <= 0;
            else if (pend_a) begin pend_a <= 0; state <= S_CRUN0; end
            else if (pend_l || pend_r || (pend_s && !cart_play)) begin   // to the list (Select: the ring goes on to Favorites)
                pend_l <= 0; pend_r <= 0; pend_s <= 0; cart_view <= 0; cart_none <= 0;
                if (pend_s && favs_ok) begin fav_mode <= 1; idx <= (fidx <= fav_count) ? fidx : 11'd0; lbl_sec <= 5'd0; end
                else if (pend_s) begin fav_mode <= 0; idx <= (aidx < lcnt) ? aidx : fav_count; lbl_sec <= 5'd28; end
                else begin fav_mode <= lmode; idx <= (lidx < lcnt) ? lidx : 11'd0; lbl_sec <= lmode ? 5'd0 : 5'd28; end
                lbl_on <= 1; lerr <= 0; tl_target <= 0; vt_go <= 1; vt_in <= 0; vt_fx <= 0; state <= S_FADE;
                if (grid) begin g_go <= 1; g_kind <= 0; end
            end
            else if (lflush_req && mt >= 28'd222_000_000) begin
                lflush_req <= 0; plog <= 1; pflags <= 32'd3; psize <= {19'd0, LOG_BYTES}; op_slot <= LOG_SLOT; op_ret <= S_LG2; state <= S_PREAD;
            end else if (need_ok) begin af_ret <= S_MENU; state <= S_AF0; end
            else if (rp_tmr >= 28'd74_000_000) begin rp_tmr <= 0; rp <= 1; state <= S_CP0; end
        end else if (leg_key != leg_built && !anim) begin   // the legend's context changed: rebuild its line
            lonly <= 1; lb_h <= 0; lb_j <= 0; lb_g <= 0; lb_n <= 0; leg_built <= leg_key; state <= S_LB1;
        end else if (g_anim) begin                   // the grid is moving: presses wait (covers still arrive)
            if (need_ok) begin af_ret <= S_MENU; state <= S_AF0; end
        end else if (!anim && pend_y && !vt_busy && lcnt != 0) begin          // Y: grid on / off
            pend_y <= 0; pend_b <= 0; g_go <= 1; g_kind <= grid_pref ? 2'd2 : 2'd1; grid_pref <= ~grid_pref;
        end else if (grid && pend_b) begin                                     // B: back to the cover flow
            pend_b <= 0; g_go <= 1; g_kind <= 2'd2; grid_pref <= 0;
        end else if (grid && (pend_r || pend_l) && lcnt > 1) begin            // grid: next / previous cell, wrapping rows
            pend_r <= 0; pend_l <= 0; idx <= pend_r ? next : prev; last_left <= !pend_r; lerr <= 0; lbl_on <= 0; tl_target <= 0;
            g_go <= 1; g_kind <= 0; state <= S_FADE;
        end else if (grid && (pend_u || pend_d)) begin : grid_ud            // grid: a row up / down, stopping at the ends
            reg [10:0] gt; reg ok;
            ok = 0; gt = idx;
            if (pend_d && gd_full) begin gt = idx + 11'd4; ok = 1; end
            else if (pend_d && gd_last) begin gt = rhi; ok = 1; end   // a shorter last row
            else if (pend_u && gu_ok) begin gt = idx - 11'd4; ok = 1; end
            pend_u <= 0; pend_d <= 0;
            if (ok) begin idx <= gt; last_left <= pend_u; lerr <= 0; lbl_on <= 0; tl_target <= 0; g_go <= 1; g_kind <= 0; state <= S_FADE; end
        end else if (!grid && !anim && pend_r && lcnt > 1) begin
            pend_r <= 0; idx <= next; last_left <= 0; lerr <= 0; lbl_on <= 0; ago <= 1; ago_dir <= 0; tl_target <= 0; state <= S_FADE;
        end else if (!grid && !anim && pend_l && lcnt > 1) begin
            pend_l <= 0; idx <= prev; last_left <= 1; lerr <= 0; lbl_on <= 0; ago <= 1; ago_dir <= 1; tl_target <= 0; state <= S_FADE;
        end else if (!anim && pend_x && pver >= 16'd7 && cur_known) begin
            pend_x <= 0; gm_on <= 1; gm_sel <= 0; lbl_on <= 0; state <= S_GMA;
        end else if (!anim && pend_s && ((fav_count != 0 && idx_ok) || cart_found || slot_ok)) begin
            pend_s <= 0; lerr <= 0; tl_target <= 0; state <= S_FADE;
            if (!fav_mode && cart_found) begin                         // All -> Cartridge
                fav_mode <= 0; lbl_on <= 0; cart_view <= 1; lidx <= idx; lmode <= 0; aidx <= idx; idx <= cart_idx;
                vt_go <= 1; vt_in <= 1; vt_fx <= 0;
            end else if (!fav_mode && slot_ok) begin                   // All -> the empty slot
                fav_mode <= 0; lbl_on <= 0; cart_view <= 1; cart_none <= 1; lidx <= idx; lmode <= 0; aidx <= idx; idx <= count + 11'd3;
                vt_go <= 1; vt_in <= 1; vt_fx <= 0;
            end else if (!fav_mode) begin                              // All -> Favorites (no cartridge)
                fav_mode <= 1; lbl_on <= 1; lbl_sec <= 5'd0; aidx <= idx; idx <= fidx;
                if (grid) begin g_go <= 1; g_kind <= 0; end
            end else begin                                             // Favorites -> All
                fav_mode <= 0; lbl_on <= 1; lbl_sec <= 5'd28; fidx <= vtile ? 11'd0 : idx; idx <= aidx;
                if (grid) begin g_go <= 1; g_kind <= 0; end
            end
        end else if (!anim && (pend_jl || pend_jr) && idx_ok && !fav_mode && lcnt > 1) begin   // L / R: letter jumps
            jup <= pend_jl; pend_jl <= 0; pend_jr <= 0; state <= S_JMP0;
        end else if (pend_a && vtile) begin                           // All games: to the A to Z list
            pend_a <= 0; fidx <= 11'd0; fav_mode <= 0; idx <= aidx; lbl_on <= 1; lbl_sec <= 5'd28; lerr <= 0; tl_target <= 0;
            if (grid) begin g_go <= 1; g_kind <= 0; end
            state <= S_FADE;
        end else if (pend_a) begin pend_a <= 0; pend_l <= 0; pend_r <= 0; pend_u <= 0; pend_d <= 0; lbl_on <= 0; level_target <= 0; zm_go <= 1; zm_in <= 1; state <= S_LAUNCH_FADE; end
        else if (lflush_req && mt >= 28'd222_000_000) begin   // 3 s idle: write the debug log to its file
            lflush_req <= 0; plog <= 1; pflags <= 32'd3; psize <= {19'd0, LOG_BYTES}; op_slot <= LOG_SLOT; op_ret <= S_LG2; state <= S_PREAD;
        end else if (need_ok) begin af_ret <= S_MENU; state <= S_AF0; end
        else if (rp_tmr >= 28'd74_000_000 && !anim && !pend_l && !pend_r && !pend_a && !pend_x && !pend_s) begin
            rp_tmr <= 0; rp <= 1; state <= S_CP0;                              // live cart check (read only)
        end
        if (!grid) begin pend_u <= 0; pend_d <= 0; end            // Up and Down only mean something in the grid
        if (lcnt <= 1 || !idx_ok || fav_mode) begin pend_jl <= 0; pend_jr <= 0; end
        if (!grid) pend_b <= 0;
        if (lcnt == 0 || vt_busy) pend_y <= 0;
        if ((fav_count == 0 || !idx_ok) && !cart_found && !slot_ok) pend_s <= 0;
        if (pver < 16'd7) pend_x <= 0;
        if (lcnt <= 1) begin pend_l <= 0; pend_r <= 0; end
    end
    S_LG2: begin
        plog <= 0;
        if (oerr > 3'd1) state <= S_MENU;
        else begin
            target_dataslot_id <= LOG_SLOT; target_dataslot_slotoffset <= 0;
            target_dataslot_bridgeaddr <= LOG_ADDR; target_dataslot_length <= {19'd0, LOG_BYTES};
            target_dataslot_write <= 1; op_ret <= S_MENU; state <= S_XFER_W;
        end
    end
    S_FADE: if (tlevel == 0) state <= S_LOAD;      // title faded out: read the new entry and relayout
            else if (need_ok) begin af_ret <= S_FADE; state <= S_AF0; end   // use the fade to fetch covers

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
            if (cur_susp) begin pk <= PK_SUS; pflags <= 0; psize <= 0; op_slot <= SUS_SLOT; op_ret <= S_L8; state <= S_PREAD; end
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
    S_L11: begin cur_susp <= 0; state <= S_LRUN; end
    S_LRUN: begin menu_active <= 0; game_loaded <= 1; state <= S_RUN; end
    S_LFAIL: begin picker_download <= 0; hold_gb <= 1; lerr <= 1; ent_raddr <= ebase + 11'd20; state <= S_LOAD2; end

    // ---- in game: L opens the pause overlay
    S_RUN: if (press_l) begin pause_gb <= 1; psel <= 0; pmsg <= 0; ovl <= 1; snd_open <= ~snd_open; state <= S_PAUSE; end
    S_PAUSE: begin
        if (press_up || press_dn) begin psel <= ~psel; pmsg <= 0; end
        else if (press_a && !psel) begin pause_gb <= 0; ovl <= 0; snd_close <= ~snd_close; state <= cart_mode ? S_CRUN : S_RUN; end
        else if (press_a && psel && cart_mode) begin   // Home from a cart: its save is on the cart; back to its cover
            ovl <= 0; pmsg <= 0; pause_gb <= 0; hold_gb <= 1; cart_mode <= 0; game_loaded <= 0; level_target <= 0;
            cart_view <= 1; vt_go <= 1; vt_in <= 1; vt_fx <= 0; state <= S_LOAD;
        end
        else if (press_a && psel) begin pmsg <= 2'd1; state <= S_H0; end
        else if (press_b || press_l) begin pause_gb <= 0; ovl <= 0; snd_close <= ~snd_close; state <= cart_mode ? S_CRUN : S_RUN; end
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
              cur_susp <= 1; cur_known <= 1; ovl <= 0; pmsg <= 0; pause_gb <= 0; hold_gb <= 1;
              game_loaded <= 0; level_target <= 0; zm_home <= 1; state <= S_LOAD;
          end
    S_OFF: begin menu_active <= 0; hold_gb <= 0; end
    default: state <= S_BOOT;
    endcase
end

// ================================================================== cover flow animation (clk_74a)
// Five slots: -2 (off left), -1 (left preview), 0 (center), +1 (right preview), +2 (off right). On a step every cover
// glides from its old slot to its new one over AN frames with an ease-out curve, resizing and fading on the way.
// Up to four covers are visible at once; they never overlap, so each screen column belongs to at most one.
localparam AN = 8;
always @(posedge clk_74a) begin
    if (ago || ago_lt) begin anim <= 1; af <= 0; adir <= ago ? ago_dir : 1'b0; end
    else if (frame_tick && anim) begin if (af == AN - 1) anim <= 0; else af <= af + 1'b1; end
    if (frame_tick) begin
        if (tlevel < tl_target) tlevel <= (tlevel + 2'd2 > tl_target) ? tl_target : tlevel + 2'd2;
        else if (tlevel > tl_target) tlevel <= (tlevel >= 3) ? tlevel - 2'd3 : 4'd0;
    end
end
function [8:0] ease(input [3:0] f);             // 1 - (1 - t)^3, t = (f + 1) / AN, scaled to 256
    case (f) 0: ease = 85; 1: ease = 147; 2: ease = 192; 3: ease = 222; 4: ease = 241; 5: ease = 251; 6: ease = 255;
             default: ease = 256; endcase
endfunction
function signed [10:0] slot_x(input signed [2:0] sl);
    case (sl) -3'sd2: slot_x = -11'sd64; -3'sd1: slot_x = 11'sd12; 3'sd0: slot_x = 11'sd96; 3'sd1: slot_x = 11'sd228;
              default: slot_x = 11'sd320; endcase
endfunction
function [7:0] slot_s(input signed [2:0] sl);
    case (sl) 3'sd0: slot_s = 8'd128; -3'sd1, 3'sd1: slot_s = 8'd80; default: slot_s = 8'd64; endcase
endfunction
function [4:0] slot_b(input signed [2:0] sl);
    case (sl) 3'sd0: slot_b = 5'd16; -3'sd1, 3'sd1: slot_b = 5'd9; default: slot_b = 5'd0; endcase
endfunction
// art step (8.8 fixed point, source pixels per screen pixel): 80 px art up to 80 on screen, 128 px art above
reg [9:0] step_lut [0:255];
integer si;
initial for (si = 0; si < 256; si = si + 1) step_lut[si] = (si == 0) ? 10'd256 : (si <= 80) ? (80 * 256) / si : (128 * 256) / si;

reg  [8:0] e_now = 9'd256;
always @(posedge clk_74a) e_now <= anim ? ease(af) : 9'd256;

// ---------------------------------------------------------------- cartridge transitions (clk_74a)
// The cartridge sits above the list. A cart going in (or Select to it) pushes the list down out of view while the
// cart's cover drops in from the top and seats with a small overshoot; going out lifts it away and the list rises
// back, its previews a few frames behind. The covers that leave are drawn from a snapshot taken at the start (k = 3
// is the old center; on the way in, k = 0 and 2 are the old previews); the covers that arrive are the live selection.
// The two rows stay D lines apart, so no screen line ever has two covers in one column. When a real cart seats, a ring
// of light leaves it, a shine crosses its cover, a glow in its color blooms and settles, and the chime plays.
// Curves and effects: tools/anim_model.py (its preview draws frames the way the video section below does).
// ---- generated by tools/anim_model.py tables: do not edit by hand
localparam [5:0] VN_IN = 24, VN_OUT = 26, V_SEAT = 12, V_TXT_IN = 16, V_TXT_OUT = 22;
localparam [4:0] RING_N = 30, GLINT_N = 26;
localparam [7:0] GLOW_REST = 87, GLOW_BLOOM = 204;
function signed [10:0] u_in_f(input [5:0] i);
    case (i) 0: u_in_f = 41; 1: u_in_f = 78; 2: u_in_f = 111; 3: u_in_f = 139; 4: u_in_f = 164; 5: u_in_f = 185; 6: u_in_f = 203; 7: u_in_f = 218; 8: u_in_f = 231; 9: u_in_f = 240; 10: u_in_f = 248; 11: u_in_f = 254; 12: u_in_f = 257; 13: u_in_f = 260; 14: u_in_f = 261; 15: u_in_f = 261; 16: u_in_f = 261; 17: u_in_f = 260; 18: u_in_f = 258; 19: u_in_f = 257; 20: u_in_f = 256; 21: u_in_f = 256; 22: u_in_f = 256; 23: u_in_f = 256; default: u_in_f = 256; endcase
endfunction
function signed [10:0] u_out_f(input [5:0] i);
    case (i) 0: u_out_f = -11'sd2; 1: u_out_f = -11'sd4; 2: u_out_f = -11'sd4; 3: u_out_f = -11'sd3; 4: u_out_f = 0; 5: u_out_f = 1; 6: u_out_f = 3; 7: u_out_f = 6; 8: u_out_f = 12; 9: u_out_f = 21; 10: u_out_f = 33; 11: u_out_f = 49; 12: u_out_f = 70; 13: u_out_f = 96; 14: u_out_f = 128; 15: u_out_f = 160; 16: u_out_f = 186; 17: u_out_f = 207; 18: u_out_f = 223; 19: u_out_f = 235; 20: u_out_f = 244; 21: u_out_f = 250; 22: u_out_f = 253; 23: u_out_f = 255; 24: u_out_f = 256; 25: u_out_f = 256; default: u_out_f = 256; endcase
endfunction
function signed [10:0] glint_p(input [4:0] i);
    case (i) 0: glint_p = -11'sd48; 1: glint_p = -11'sd47; 2: glint_p = -11'sd43; 3: glint_p = -11'sd36; 4: glint_p = -11'sd26; 5: glint_p = -11'sd15; 6: glint_p = -11'sd1; 7: glint_p = 15; 8: glint_p = 33; 9: glint_p = 52; 10: glint_p = 73; 11: glint_p = 94; 12: glint_p = 116; 13: glint_p = 138; 14: glint_p = 160; 15: glint_p = 181; 16: glint_p = 202; 17: glint_p = 221; 18: glint_p = 239; 19: glint_p = 255; 20: glint_p = 269; 21: glint_p = 280; 22: glint_p = 290; 23: glint_p = 297; 24: glint_p = 301; 25: glint_p = 302; default: glint_p = 400; endcase
endfunction
function [3:0] glint_w(input [3:0] i);
    case (i) 0: glint_w = 14; 1: glint_w = 12; 2: glint_w = 11; 3: glint_w = 10; 4: glint_w = 9; 5: glint_w = 7; 6: glint_w = 6; 7: glint_w = 5; 8: glint_w = 4; 9: glint_w = 4; 10: glint_w = 3; 11: glint_w = 2; 12: glint_w = 1; 13: glint_w = 1; 14: glint_w = 0; 15: glint_w = 0; default: glint_w = 0; endcase
endfunction
function [16:0] ring_r2(input [4:0] i);
    case (i) 0: ring_r2 = 4096; 1: ring_r2 = 6785; 2: ring_r2 = 9905; 3: ring_r2 = 13338; 4: ring_r2 = 16983; 5: ring_r2 = 20749; 6: ring_r2 = 24561; 7: ring_r2 = 28352; 8: ring_r2 = 32066; 9: ring_r2 = 35657; 10: ring_r2 = 39087; 11: ring_r2 = 42326; 12: ring_r2 = 45352; 13: ring_r2 = 48148; 14: ring_r2 = 50704; 15: ring_r2 = 53015; 16: ring_r2 = 55080; 17: ring_r2 = 56901; 18: ring_r2 = 58487; 19: ring_r2 = 59846; 20: ring_r2 = 60991; 21: ring_r2 = 61936; 22: ring_r2 = 62699; 23: ring_r2 = 63296; 24: ring_r2 = 63746; 25: ring_r2 = 64070; 26: ring_r2 = 64287; 27: ring_r2 = 64420; 28: ring_r2 = 64487; 29: ring_r2 = 64512; default: ring_r2 = 0; endcase
endfunction
function [11:0] ring_b(input [4:0] i);
    case (i) 0: ring_b = 640; 1: ring_b = 824; 2: ring_b = 995; 3: ring_b = 1155; 4: ring_b = 1303; 5: ring_b = 1440; 6: ring_b = 1567; 7: ring_b = 1684; 8: ring_b = 1791; 9: ring_b = 1888; 10: ring_b = 1977; 11: ring_b = 2057; 12: ring_b = 2130; 13: ring_b = 2194; 14: ring_b = 2252; 15: ring_b = 2302; 16: ring_b = 2347; 17: ring_b = 2385; 18: ring_b = 2418; 19: ring_b = 2446; 20: ring_b = 2470; 21: ring_b = 2489; 22: ring_b = 2504; 23: ring_b = 2516; 24: ring_b = 2525; 25: ring_b = 2531; 26: ring_b = 2535; 27: ring_b = 2538; 28: ring_b = 2539; 29: ring_b = 2540; default: ring_b = 0; endcase
endfunction
function [14:0] ring_m(input [4:0] i);
    case (i) 0: ring_m = 22195; 1: ring_m = 16329; 2: ring_m = 12784; 3: ring_m = 10391; 4: ring_m = 8671; 5: ring_m = 7369; 6: ring_m = 6343; 7: ring_m = 5514; 8: ring_m = 4829; 9: ring_m = 4252; 10: ring_m = 3756; 11: ring_m = 3325; 12: ring_m = 2945; 13: ring_m = 2609; 14: ring_m = 2307; 15: ring_m = 2036; 16: ring_m = 1788; 17: ring_m = 1563; 18: ring_m = 1356; 19: ring_m = 1166; 20: ring_m = 992; 21: ring_m = 831; 22: ring_m = 684; 23: ring_m = 550; 24: ring_m = 428; 25: ring_m = 319; 26: ring_m = 223; 27: ring_m = 141; 28: ring_m = 73; 29: ring_m = 24; default: ring_m = 0; endcase
endfunction
function [7:0] glow_i(input [7:0] i);
    case (i) 0: glow_i = 255; 1: glow_i = 255; 2: glow_i = 255; 3: glow_i = 255; 4: glow_i = 255; 5: glow_i = 255; 6: glow_i = 255; 7: glow_i = 255; 8: glow_i = 255; 9: glow_i = 254; 10: glow_i = 254; 11: glow_i = 254; 12: glow_i = 253; 13: glow_i = 253; 14: glow_i = 252; 15: glow_i = 250; 16: glow_i = 245; 17: glow_i = 239; 18: glow_i = 231; 19: glow_i = 222; 20: glow_i = 213; 21: glow_i = 203; 22: glow_i = 192; 23: glow_i = 182; 24: glow_i = 172; 25: glow_i = 162; 26: glow_i = 152; 27: glow_i = 143; 28: glow_i = 134; 29: glow_i = 126; 30: glow_i = 118; 31: glow_i = 111; 32: glow_i = 105; 33: glow_i = 99; 34: glow_i = 94; 35: glow_i = 89; 36: glow_i = 84; 37: glow_i = 80; 38: glow_i = 77; 39: glow_i = 74; 40: glow_i = 71; 41: glow_i = 68; 42: glow_i = 66; 43: glow_i = 64; 44: glow_i = 62; 45: glow_i = 60; 46: glow_i = 58; 47: glow_i = 57; 48: glow_i = 56; 49: glow_i = 54; 50: glow_i = 53; 51: glow_i = 52; 52: glow_i = 51; 53: glow_i = 50; 54: glow_i = 49; 55: glow_i = 49; 56: glow_i = 48; 57: glow_i = 47; 58: glow_i = 46; 59: glow_i = 46; 60: glow_i = 45; 61: glow_i = 44; 62: glow_i = 44; 63: glow_i = 43; 64: glow_i = 42; 65: glow_i = 42; 66: glow_i = 41; 67: glow_i = 41; 68: glow_i = 40; 69: glow_i = 40; 70: glow_i = 39; 71: glow_i = 39; 72: glow_i = 38; 73: glow_i = 37; 74: glow_i = 37; 75: glow_i = 36; 76: glow_i = 36; 77: glow_i = 35; 78: glow_i = 35; 79: glow_i = 34; 80: glow_i = 34; 81: glow_i = 34; 82: glow_i = 33; 83: glow_i = 33; 84: glow_i = 32; 85: glow_i = 32; 86: glow_i = 31; 87: glow_i = 31; 88: glow_i = 30; 89: glow_i = 30; 90: glow_i = 30; 91: glow_i = 29; 92: glow_i = 29; 93: glow_i = 28; 94: glow_i = 28; 95: glow_i = 27; 96: glow_i = 27; 97: glow_i = 27; 98: glow_i = 26; 99: glow_i = 26; 100: glow_i = 26; 101: glow_i = 25; 102: glow_i = 25; 103: glow_i = 24; 104: glow_i = 24; 105: glow_i = 24; 106: glow_i = 23; 107: glow_i = 23; 108: glow_i = 23; 109: glow_i = 22; 110: glow_i = 22; 111: glow_i = 22; 112: glow_i = 21; 113: glow_i = 21; 114: glow_i = 21; 115: glow_i = 21; 116: glow_i = 20; 117: glow_i = 20; 118: glow_i = 20; 119: glow_i = 19; 120: glow_i = 19; 121: glow_i = 19; 122: glow_i = 18; 123: glow_i = 18; 124: glow_i = 18; 125: glow_i = 18; 126: glow_i = 17; 127: glow_i = 17; 128: glow_i = 17; 129: glow_i = 17; 130: glow_i = 16; 131: glow_i = 16; 132: glow_i = 16; 133: glow_i = 16; 134: glow_i = 15; 135: glow_i = 15; 136: glow_i = 15; 137: glow_i = 15; 138: glow_i = 15; 139: glow_i = 14; 140: glow_i = 14; 141: glow_i = 14; 142: glow_i = 14; 143: glow_i = 13; 144: glow_i = 13; 145: glow_i = 13; 146: glow_i = 13; 147: glow_i = 13; 148: glow_i = 12; 149: glow_i = 12; 150: glow_i = 12; 151: glow_i = 12; 152: glow_i = 12; 153: glow_i = 12; 154: glow_i = 11; 155: glow_i = 11; 156: glow_i = 11; 157: glow_i = 11; 158: glow_i = 11; 159: glow_i = 10; 160: glow_i = 10; 161: glow_i = 10; 162: glow_i = 10; 163: glow_i = 10; 164: glow_i = 10; 165: glow_i = 10; 166: glow_i = 9; 167: glow_i = 9; 168: glow_i = 9; 169: glow_i = 9; 170: glow_i = 9; 171: glow_i = 9; 172: glow_i = 9; 173: glow_i = 8; 174: glow_i = 8; 175: glow_i = 8; 176: glow_i = 8; 177: glow_i = 8; 178: glow_i = 8; 179: glow_i = 8; 180: glow_i = 8; 181: glow_i = 7; 182: glow_i = 7; 183: glow_i = 7; 184: glow_i = 7; 185: glow_i = 7; 186: glow_i = 7; 187: glow_i = 7; 188: glow_i = 7; 189: glow_i = 7; 190: glow_i = 6; 191: glow_i = 6; 192: glow_i = 6; 193: glow_i = 6; 194: glow_i = 6; 195: glow_i = 6; 196: glow_i = 6; 197: glow_i = 6; 198: glow_i = 6; 199: glow_i = 6; 200: glow_i = 6; 201: glow_i = 5; 202: glow_i = 5; 203: glow_i = 5; 204: glow_i = 5; 205: glow_i = 5; 206: glow_i = 5; 207: glow_i = 5; 208: glow_i = 5; 209: glow_i = 5; 210: glow_i = 5; 211: glow_i = 5; 212: glow_i = 5; 213: glow_i = 4; 214: glow_i = 4; 215: glow_i = 4; 216: glow_i = 4; 217: glow_i = 4; 218: glow_i = 4; 219: glow_i = 4; 220: glow_i = 4; 221: glow_i = 4; 222: glow_i = 4; 223: glow_i = 4; 224: glow_i = 4; 225: glow_i = 4; 226: glow_i = 4; 227: glow_i = 4; 228: glow_i = 4; 229: glow_i = 3; 230: glow_i = 3; 231: glow_i = 3; 232: glow_i = 3; 233: glow_i = 3; 234: glow_i = 3; 235: glow_i = 3; 236: glow_i = 3; 237: glow_i = 3; 238: glow_i = 3; 239: glow_i = 3; 240: glow_i = 3; 241: glow_i = 3; 242: glow_i = 3; 243: glow_i = 3; 244: glow_i = 3; 245: glow_i = 3; 246: glow_i = 3; 247: glow_i = 3; 248: glow_i = 3; 249: glow_i = 2; 250: glow_i = 2; 251: glow_i = 2; 252: glow_i = 2; 253: glow_i = 2; 254: glow_i = 2; 255: glow_i = 2; default: glow_i = 0; endcase
endfunction
// ---- end of generated tables
localparam signed [10:0] D = 11'sd256;
// cover k (0..3, left to right) parameters, set in the block after this one
reg  signed [10:0] cx [0:3]; reg [7:0] cs [0:3]; reg [4:0] cb [0:3]; reg cv [0:3];
reg         vt = 0, vt_arm = 0, vt_dir = 0, vt_fxr = 0;   // moving; waiting for the arriving art; 1: in; effects
reg         lt = 0, pin0 = 0; reg [2:0] ltf = 0; reg ago_lt = 0;   // the lift: shrinking the old centre; then a step with cover 0 pinned
reg         zm = 0, zdir = 0; reg [3:0] zf = 0;    // the zoom: 12 frames, the selected cover between its rest size and 240 px
reg  signed [10:0] zx0 = 0, zt0 = 0; reg [7:0] zs0 = 0;   // its rest geometry (x, top, size)
reg  [8:0]  zk_r = 0; reg [16:0] zd_r = 0; reg [7:0] zs_r = 0; reg signed [10:0] zx_r = 0, zy_r = 0;   // the zoom, pipelined
reg  [7:0]  lts = 0; reg [4:0] ltb = 0;            // the lifting cover's size and brightness this frame
localparam [7:0] ZS = 8'd240;
localparam [2:0] LT_N = 7;
function [8:0] lift_k(input [2:0] i);                // 256 .. 0 over 8 frames, ease out (1 - (1-t)^3 reversed)
    case (i) 0: lift_k = 171; 1: lift_k = 109; 2: lift_k = 64; 3: lift_k = 34; 4: lift_k = 15; 5: lift_k = 5; 6: lift_k = 1; default: lift_k = 0; endcase
endfunction
reg  [5:0]  vf = 0, vt_wait = 0; reg vt_rdy = 0;
reg  signed [10:0] gx [0:3]; reg [7:0] gs [0:3]; reg [4:0] gb [0:3]; reg [10:0] gg [0:3]; reg gv [0:3], gk [0:3];
reg  signed [10:0] cy [0:3]; reg ck [0:3];             // per cover: vertical offset, transparent black (default image)
reg  [7:0]  glow = 0, glow_tgt = 0, glow_rate = 0;     // glow level, approached 1/16 per frame (rate 0) or faded at rate
reg  [15:0] glow_acc = 0;                              // its color
reg  [4:0]  rf = 5'd31, gf = 5'd31;                    // ring / shine frame (31: off)
reg  [10:0] glow_out = 0;
assign vt_busy = vt_arm | vt;
assign vt_txt  = vt_arm | (vt && vf < (vt_dir ? V_TXT_IN : V_TXT_OUT));
wire [5:0]  vfl = vt_dir ? (vf < 2 ? 6'd63 : vf - 6'd2) : (vf < 3 ? 6'd63 : vf - 6'd3);   // previews lag (63: not yet)
wire signed [10:0] um = !vt ? 11'sd0 : vt_dir ? u_in_f(vf) : u_out_f(vf);
wire signed [10:0] ul = (!vt || vfl == 6'd63) ? 11'sd0 : vt_dir ? u_in_f(vfl) : u_out_f(vfl);
integer gi;
always @(posedge clk_74a) begin
    ago_lt <= 0;
    if (lt_go) begin
        lt <= 1; ltf <= 0;
        for (gi = 0; gi < 4; gi = gi + 1) begin
            gx[gi] <= cx[gi == 3 ? 1 : gi]; gs[gi] <= cs[gi == 3 ? 1 : gi]; gb[gi] <= cb[gi == 3 ? 1 : gi];
            gg[gi] <= cg[gi == 3 ? 1 : gi]; gk[gi] <= ck[gi == 3 ? 1 : gi];
            gv[gi] <= cv[gi == 3 ? 1 : gi] && menu_active;
        end
    end else if (lt && frame_tick) begin
        if (ltf == LT_N) begin lt <= 0; ago_lt <= 1; pin0 <= 1; end else ltf <= ltf + 1'b1;
    end
    begin : liftsz
        reg [16:0] ps_, pb_;
        ps_ = gs[1] * lift_k(ltf); pb_ = gb[1] * lift_k(ltf);
        lts <= ps_[15:8]; ltb <= pb_[12:8];
    end
    if (!anim && !ago_lt && !ago) pin0 <= 0;
    if (zm_go) begin                                               // snapshot the selected cover's rest geometry
        zm <= 1; zdir <= zm_in; zf <= 0;
        zx0 <= cx[1]; zs0 <= cs[1]; zt0 <= 11'sd96 - $signed({4'b0, cs[1][7:1]}) + cy[1];
    end else if (zm && frame_tick) begin
        if (zf == GN_MORPH - 1) zm <= 0; else zf <= zf + 1'b1;
    end
    begin : zoomsz                                                 // three registered steps; the frame is 1.24 M cycles long
        zk_r <= zdir ? grid_morph(zf) : 9'd256 - grid_morph(zf);
        zd_r <= (ZS - zs0) * zk_r;
        zs_r <= zs0 + zd_r[15:8];
        zx_r <= zx0 - ($signed({4'b0, zs_r[7:1]}) - $signed({4'b0, zs0[7:1]}));
        zy_r <= zt0 - ($signed({4'b0, zs_r[7:1]}) - $signed({4'b0, zs0[7:1]})) - 11'sd96 + $signed({4'b0, zs_r[7:1]});
    end
    if (vt_go) begin
        vt_arm <= 1; vt <= 0; vf <= 0; vt_wait <= 0; vt_rdy <= 0; vt_dir <= vt_in; vt_fxr <= vt_fx;
        for (gi = 0; gi < 4; gi = gi + 1) begin                    // what is on screen now (registered: the old state)
            gx[gi] <= cx[gi == 3 ? 1 : gi]; gs[gi] <= cs[gi == 3 ? 1 : gi]; gb[gi] <= cb[gi == 3 ? 1 : gi];
            gg[gi] <= cg[gi == 3 ? 1 : gi]; gk[gi] <= ck[gi == 3 ? 1 : gi];
            gv[gi] <= cv[gi == 3 ? 1 : gi] && menu_active;
        end
        glow_rate <= vt_in ? 8'd38 : 8'd15;                         // the old glow goes first
    end else if (frame_tick) begin
        // effects step first, so a seat below (bloom, ring and shine restart) overrides them
        if (rf != 5'd31) rf <= (rf == RING_N - 1'b1) ? 5'd31 : rf + 1'b1;
        if (gf != 5'd31) gf <= (gf == GLINT_N - 1'b1) ? 5'd31 : gf + 1'b1;
        if (glow_rate != 0) glow <= (glow > glow_rate) ? glow - glow_rate : 8'd0;
        else begin : approach
            reg signed [9:0] dd, st;
            dd = $signed({2'b0, glow_tgt}) - $signed({2'b0, glow});
            st = dd >>> 4;
            if (st == 0 && dd != 0) st = (dd > 0) ? 10'sd1 : -10'sd1;
            glow <= glow + st[7:0];
        end
        if (vt_arm) begin                                          // start once the arriving cover is in the cache
            vt_wait <= vt_wait + 1'b1;
            vt_rdy <= c_valid && c_idx == idx && cl[1] && menu_active;
            if ((vt_rdy && c_valid && c_idx == idx && cl[1] && menu_active) || vt_wait == 6'd45) begin
                vt_arm <= 0; vt <= 1; vf <= 0;
                if (!vt_dir && vt_fxr) snd_rem <= ~snd_rem;
            end
        end else if (vt) begin
            if (vf == (vt_dir ? VN_IN : VN_OUT) - 1'b1) vt <= 0; else vf <= vf + 1'b1;
            if (vt_dir && vf == V_SEAT) begin                     // seated
                glow_acc <= cur_acc; glow_tgt <= GLOW_REST; glow_rate <= 0;
                if (vt_fxr) begin glow <= GLOW_BLOOM; rf <= 0; gf <= 0; snd_ins <= ~snd_ins; end
            end
        end
    end
    if (!cart_view && !vt_busy) begin glow_tgt <= 0; if (glow_rate == 0) glow_rate <= 8'd15; end   // left without a transition
    glow_out <= glow * level;                                      // dims with the menu
end

// ---------------------------------------------------------------- grid view (clk_74a)
// Cells are 72 px on a 76 by 94 pitch: columns at x = 10, 86, 162, 238, rows at y = 8 and 102 (a third row at 196
// only exists while a scroll brings it in; the lattice is cut at row 192, where the title block starts). The
// selection is the "pop": free cover 1 drawn 80 px at its cell less 4, over the lattice, whose cell under it is
// skipped. Y morphs the flow into the grid over 12 frames (the centre cover shrinks into its cell while the side
// covers go, then the lattice comes in) and back. A move slides the pop to its new cell over 6 frames; when the
// cell is past the window the rows slide one pitch over 8 frames and the new row enters under the clip line.
// Curves: tools/grid_model.py (its preview draws the frames the way the video section below does).
// ---- generated by tools/grid_model.py tables: do not edit by hand
localparam [3:0] GN_MOVE = 6, GN_SCROLL = 8, GN_MORPH = 12;
function [8:0] grid_move(input [2:0] i);
    case (i) 0: grid_move = 108; 1: grid_move = 180; 2: grid_move = 224; 3: grid_move = 247; 4: grid_move = 255; 5: grid_move = 256; default: grid_move = 256; endcase
endfunction
function [6:0] grid_scroll(input [2:0] i);
    case (i) 0: grid_scroll = 31; 1: grid_scroll = 54; 2: grid_scroll = 71; 3: grid_scroll = 82; 4: grid_scroll = 89; 5: grid_scroll = 93; 6: grid_scroll = 94; 7: grid_scroll = 94; default: grid_scroll = 94; endcase
endfunction
function [8:0] grid_morph(input [3:0] i);
    case (i) 0: grid_morph = 59; 1: grid_morph = 108; 2: grid_morph = 148; 3: grid_morph = 180; 4: grid_morph = 205; 5: grid_morph = 224; 6: grid_morph = 237; 7: grid_morph = 247; 8: grid_morph = 252; 9: grid_morph = 255; 10: grid_morph = 256; 11: grid_morph = 256; default: grid_morph = 256; endcase
endfunction
function [4:0] grid_sideb(input [3:0] i);
    case (i) 0: grid_sideb = 7; 1: grid_sideb = 5; 2: grid_sideb = 3; 3: grid_sideb = 0; 4: grid_sideb = 0; 5: grid_sideb = 0; 6: grid_sideb = 0; 7: grid_sideb = 0; 8: grid_sideb = 0; 9: grid_sideb = 0; 10: grid_sideb = 0; 11: grid_sideb = 0; default: grid_sideb = 0; endcase
endfunction
function [4:0] grid_latb(input [3:0] i);
    case (i) 0: grid_latb = 0; 1: grid_latb = 0; 2: grid_latb = 0; 3: grid_latb = 0; 4: grid_latb = 1; 5: grid_latb = 2; 6: grid_latb = 3; 7: grid_latb = 4; 8: grid_latb = 5; 9: grid_latb = 6; 10: grid_latb = 7; 11: grid_latb = 9; default: grid_latb = 9; endcase
endfunction
// ---- end of generated tables
localparam signed [10:0] GPX = 11'sd76, GPY = 11'sd94;
wire [10:0] g_pos = idx - rlo;                         // the selection's place in the list being browsed
wire [1:0]  g_col = g_pos[1:0]; wire [8:0] g_row = g_pos[10:2];
wire signed [10:0] g_vr = $signed({2'b0, g_row}) - $signed({2'b0, g_top});   // its lattice row from the top one
wire signed [10:0] g_cx = 11'sd6 + GPX * $signed({9'd0, g_col});             // the pop's x at that cell
// whether a row down (a full row, or a shorter last row) or a row up exists, registered: presses wait a frame anyway
reg         gd_full = 0, gd_last = 0, gu_ok = 0;
always @(posedge clk_74a) begin
    gd_full <= g_pos + 11'd4 < rcount; gd_last <= (g_pos | 11'd3) + 11'd1 < rcount; gu_ok <= g_pos >= 11'd4;
end
wire signed [10:0] lat_vy = vt_busy ? (vt_dir ? ul : D - ul) : (cart_view ? D : 11'sd0);   // pushed out by a cartridge
reg  signed [9:0]  lat_sbase = 0;                      // list row of lattice row 0 as the cells were last snapped
reg  [10:0] lat_g [0:11]; reg lat_v [0:11];           // the cells: game, in the list
reg  signed [10:0] lat_y0 = 0;                         // top of lattice row 0 on screen
reg  [3:0]  lat_skip = 4'd15;                          // the cell under the pop at rest (15: none)
reg         lat_on = 0;
integer gl;
initial for (gl = 0; gl < 12; gl = gl + 1) begin lat_g[gl] = 0; lat_v[gl] = 0; end
function signed [10:0] glerp(input signed [10:0] a, input signed [10:0] b, input [8:0] k);
    reg signed [21:0] d;
    begin d = (b - a) * $signed({1'b0, k}); glerp = a + d[18:8]; end
endfunction
always @(posedge clk_74a) begin
    g_go1 <= g_go; g_go2 <= g_go1;                     // two cycles: rlo and rcount follow a mode change
    mk_r <= g_min ? grid_morph(g_mf) : 9'd256 - grid_morph(g_mf);
    mv_r <= grid_move(g_vf); sc_r <= grid_scroll(g_sf);
    if (g_go2) begin
        if (g_kind == 2'd1) begin                      // morph in: the selection's row becomes the top row
            g_top <= g_row; g_up <= 0; lat_y <= 0; g_morph <= 1; g_min <= 1; g_mf <= 0; side_b <= 5'd9; lat_b <= 0;
            p_fx <= 11'sd96; p_fy <= 11'sd32; p_fs <= 8'd128; p_tx <= g_cx; p_ty <= 11'sd4; p_ts <= 8'd80;
            p_x <= 11'sd96; p_y <= 11'sd32; p_s <= 8'd128; g_move <= 0; g_scroll <= 0;
        end else if (g_kind == 2'd2) begin             // morph out, from wherever the pop rests
            g_morph <= 1; g_min <= 0; g_mf <= 0; side_b <= 0; lat_b <= 5'd9;
            p_fx <= 11'sd96; p_fy <= 11'sd32; p_fs <= 8'd128; p_tx <= p_x; p_ty <= p_y; p_ts <= p_s; g_move <= 0; g_scroll <= 0;
        end else if (grid_draw) begin                  // the selection moved
            p_fx <= p_x; p_fy <= p_y; p_fs <= p_s; p_tx <= g_cx; p_ts <= 8'd80; g_vf <= 0;
            if (g_vr >= 0 && g_vr <= 1) begin p_ty <= 11'sd4 + GPY * g_vr; g_move <= 1; end
            else if (g_vr == 2) begin p_ty <= 11'sd4 + GPY; g_move <= 1; g_scroll <= 1; g_sdn <= 1; g_sf <= 0; g_up <= 0; lat_y <= 0; end
            else if (g_vr == -1) begin p_ty <= 11'sd4; g_move <= 1; g_scroll <= 1; g_sdn <= 0; g_sf <= 0; g_up <= 1; lat_y <= 0; end
            else begin g_top <= g_row; g_up <= 0; lat_y <= 0; p_x <= g_cx; p_y <= 11'sd4; p_s <= 8'd80; end   // far: no motion
        end
    end else if (frame_tick) begin
        if (g_scroll) begin
            lat_y <= g_sdn ? -$signed({4'd0, sc_r}) : $signed({4'd0, sc_r});
            if (g_sf == GN_SCROLL - 1) begin g_scroll <= 0; lat_y <= 0; g_up <= 0; g_top <= g_sdn ? g_top + 1'b1 : g_top - 1'b1; end
            else g_sf <= g_sf + 1'b1;
        end
        if (g_move) begin : mv
            reg [8:0] k;
            k = mv_r;
            p_x <= glerp(p_fx, p_tx, k); p_y <= glerp(p_fy, p_ty, k); p_s <= glerp({3'b0, p_fs}, {3'b0, p_ts}, k);
            if (g_vf == GN_MOVE - 1) g_move <= 0; else g_vf <= g_vf + 1'b1;
        end
        if (g_morph) begin : mo
            reg [8:0] k; reg [3:0] fo;
            k = mk_r;
            fo = g_min ? g_mf : 4'd11 - g_mf;
            p_x <= glerp(p_fx, p_tx, k); p_y <= glerp(p_fy, p_ty, k); p_s <= glerp({3'b0, p_fs}, {3'b0, p_ts}, k);
            side_b <= grid_sideb(fo); lat_b <= grid_latb(fo);
            if (g_mf == GN_MORPH - 1) begin g_morph <= 0; grid <= g_min; end else g_mf <= g_mf + 1'b1;
        end
    end
    // the lattice as drawn: a snapshot of the candidates whenever they are complete, and its row 0 top (continuous
    // through a scroll: expressed from the snapped base row, so a stale snapshot still lands where it was)
    if (c_valid && use_grid) begin
        for (gl = 0; gl < 12; gl = gl + 1) begin lat_g[gl] <= cgame[gl]; lat_v[gl] <= cok[gl]; end
        lat_sbase <= g_base;
    end
    lat_y0 <= 11'sd8 + GPY * ($signed({lat_sbase[9], lat_sbase}) - $signed({2'b0, g_top})) + $signed({{3{lat_y[7]}}, lat_y}) + lat_vy;
    lat_on <= grid_draw && lat_b != 0;
    lat_skip <= (!g_move && !g_scroll && $signed({2'b0, g_row}) >= $signed({lat_sbase[9], lat_sbase}) && $signed({2'b0, g_row}) < $signed({lat_sbase[9], lat_sbase}) + 11'sd3)
                ? {g_row[1:0] - lat_sbase[1:0], g_col} : 4'd15;
end

// two stages: the cover flow math into n*, then the cartridge transition's choice into c* (cx is on a long path)
reg  signed [10:0] nxr [0:3]; reg [7:0] nsr [0:3]; reg [4:0] nbr [0:3]; reg [10:0] ngr [0:3]; reg nvr [0:3];
integer ki;
always @(posedge clk_74a) begin   // registered: these cross into clk_vid
    for (ki = 0; ki < 4; ki = ki + 1) begin : covers
        reg signed [2:0] fs, ts; reg signed [11:0] dx; reg signed [9:0] ds, dbb; reg [4:0] bt;
        reg signed [22:0] px, ps, pb;     // full-width products (the sum's width would otherwise truncate them)
        reg signed [10:0] nx; reg [7:0] ns; reg [4:0] nb; reg [10:0] ng; reg nv;
        // final slots: moving right -> -2,-1,0,1 ; moving left -> -1,0,1,2 ; at rest -> -1,0,1 (k = 3 unused)
        ts = (anim && !adir) ? ki - 2 : ki - 1;
        fs = (!anim || (pin0 && ki == 0)) ? ts : (!adir ? ts + 1 : ts - 1);
        dx  = slot_x(ts) - slot_x(fs);
        ds  = $signed({2'b0, slot_s(ts)}) - $signed({2'b0, slot_s(fs)});
        dbb = $signed({5'b0, slot_b(ts)}) - $signed({5'b0, slot_b(fs)});
        px  = dx  * $signed({1'b0, e_now});
        ps  = ds  * $signed({1'b0, e_now});
        pb  = dbb * $signed({1'b0, e_now});
        bt  = $signed({1'b0, slot_b(fs)}) + (pb >>> 8);
        nx = slot_x(fs) + (px >>> 8);
        ns = $signed({1'b0, slot_s(fs)}) + (ps >>> 8);
        nb = (bt > 5'd16) ? 5'd16 : bt;
        // idx + ts, wrapped: candidates 0..4 are offsets 0, +1, -1, +2, -2
        case (ts) 3'sd0: ng = cgame[0]; 3'sd1: ng = cgame[1]; -3'sd1: ng = cgame[2];
                  3'sd2: ng = cgame[3]; default: ng = cgame[4]; endcase
        nv = (rcount > 1 || ts == 0) && (anim || ki != 3) && bt != 0;
        nxr[ki] <= nx; nsr[ki] <= ns; nbr[ki] <= nb; ngr[ki] <= ng; nvr[ki] <= nv;
        if (vt_busy && (ki == 3 || (vt_dir && ki != 1))) begin      // leaving: from the snapshot
            cx[ki] <= gx[ki]; cs[ki] <= gs[ki]; cb[ki] <= gb[ki]; cg[ki] <= gg[ki]; cv[ki] <= gv[ki]; ck[ki] <= gk[ki];
            cy[ki] <= (ki == 3) ? (vt_dir ? um : -um) : ul;
        end else if (lt) begin                                      // the old row, its centre shrinking away
            if (ki == 1) begin cs[1] <= lts; cb[1] <= ltb; cx[1] <= 11'sd160 - $signed({4'b0, lts[7:1]}); cv[1] <= lts != 0; end
            else begin cx[ki] <= gx[ki]; cs[ki] <= gs[ki]; cb[ki] <= gb[ki]; cv[ki] <= gv[ki] && ki != 3; end
            cg[ki] <= gg[ki]; ck[ki] <= gk[ki]; cy[ki] <= 0;
        end else if (use_grid) begin                                // the grid: the pop and, in a morph, the side covers
            case (ki)
            0: begin cx[0] <= 11'sd12; cs[0] <= 8'd80; cb[0] <= side_b; cg[0] <= (fav_mode && live) ? g_prev : vmap(prev); cv[0] <= side_b != 0 && rcount > 1; ck[0] <= 0; cy[0] <= vt_busy ? D - ul : 11'sd0; end
            2: begin cx[2] <= 11'sd228; cs[2] <= 8'd80; cb[2] <= side_b; cg[2] <= (fav_mode && live) ? g_next : vmap(next); cv[2] <= side_b != 0 && rcount > 1; ck[2] <= 0; cy[2] <= vt_busy ? D - ul : 11'sd0; end
            1: begin cx[1] <= p_x; cs[1] <= p_s; cb[1] <= 5'd16; cg[1] <= cur_g; cv[1] <= 1; ck[1] <= 0;
                     cy[1] <= p_y - 11'sd96 + $signed({4'b0, p_s[7:1]}) + (vt_busy ? D - um : 11'sd0); end
            default: begin cv[3] <= 0; cx[3] <= nxr[3]; cs[3] <= nsr[3]; cb[3] <= nbr[3]; cg[3] <= ngr[3]; ck[3] <= 0; cy[3] <= 0; end
            endcase
        end else begin                                              // the live selection
            cx[ki] <= nxr[ki]; cs[ki] <= nsr[ki]; cb[ki] <= nbr[ki]; cg[ki] <= ngr[ki]; cv[ki] <= nvr[ki]; ck[ki] <= (ki == 1) && vsel;
            cy[ki] <= !vt_busy ? 11'sd0 : (ki == 1) ? (vt_dir ? um - D : D - um) : D - ul;
        end
        if (zm && ki == 1) begin                                    // the selected cover grows into the game, or shrinks back
            cs[1] <= zs_r; cx[1] <= zx_r; cy[1] <= zy_r; cb[1] <= 5'd16; cv[1] <= 1;
        end
    end
end

// position bar thumb: idx * 120 / (count - 1), by restoring division over 18 cycles whenever idx changes
reg  [6:0]  pos_bar = 0;
wire [10:0] ridx = idx - rlo;      // position in the range being browsed
reg  [10:0] dv_cnt = 0;
reg  [17:0] dv_num = 0, dv_q = 0; reg [10:0] dv_rem = 0, dv_den = 0; reg [4:0] dv_n = 0; reg [10:0] dv_idx = 11'h7FF;
always @(posedge clk_74a) begin
    if (dv_n == 0) begin
        if ((ridx != dv_idx || rcount != dv_cnt) && rcount > 1) begin
            dv_cnt <= rcount;
            dv_idx <= ridx; dv_num <= {ridx, 7'd0} - {4'd0, ridx, 3'd0};   // position * 120
            dv_den <= rcount - 1'b1; dv_rem <= 0; dv_q <= 0; dv_n <= 5'd18;
        end
    end else begin : dstep
        reg [11:0] r;
        r = {dv_rem, dv_num[17]};
        dv_num <= {dv_num[16:0], 1'b0};
        if (r >= {1'b0, dv_den}) begin dv_rem <= r - {1'b0, dv_den}; dv_q <= {dv_q[16:0], 1'b1}; end
        else begin dv_rem <= r[10:0]; dv_q <= {dv_q[16:0], 1'b0}; end
        dv_n <= dv_n - 1'b1;
        if (dv_n == 1) pos_bar <= (r >= {1'b0, dv_den}) ? {dv_q[5:0], 1'b1} : {dv_q[5:0], 1'b0};
    end
end

// ================================================================== video (clk_vid)
reg [1:0] menu_s = 0; reg [3:0] lvl_s = 0, tl_s = 0; reg [10:0] idx_s = 0, cnt_s = 0; reg [6:0] pos_s = 0;
reg [7:0] tw_s = 0; reg [8:0] htw_s = 0, hsw_s = 0, lgw_s = 0; reg [2:0] gen_s = 0;
always @(posedge clk_vid) begin
    menu_s <= {menu_s[0], menu_active}; lvl_s <= level; tl_s <= tlevel; idx_s <= ridx; cnt_s <= rcount; pos_s <= pos_bar;
    tw_s <= title_w; htw_s <= htw; hsw_s <= hsw; lgw_s <= lgw; gen_s <= {gen_s[1:0], gen};
end
wire menu_v = menu_s[1];
assign hr_mode = menu_v;

reg [1:0] ovl_s = 0; reg psel_v = 0; reg [1:0] pmsg_v = 0; reg [7:0] ec_v = 0; reg [2:0] en_v = 0;
always @(posedge clk_vid) begin ovl_s <= {ovl_s[0], ovl}; psel_v <= psel; pmsg_v <= pmsg; ec_v <= ecode; en_v <= enum_; end
wire ovl_v = ovl_s[1];
always @(posedge clk_74a) ovl_dim <= ovl;

// ---------------------------------------------------------------- pause panel, drawn in the Game Boy's 160x144 frame
reg [8:0] px = 0, py = 0; reg de_1 = 0, vs_1 = 0;
always @(posedge clk_vid) begin
    de_1 <= de; vs_1 <= vs;
    if (vs & ~vs_1) py <= 0;
    else if (de_1 & ~de) begin py <= py + 1'b1; px <= 0; end
    else if (de) px <= px + 1'b1;
end
// panel title marquee: hold 1.5 s, scroll 1 px a frame, wrap with a 24 px gap
reg [8:0] scroll = 0; reg [6:0] mq_hold = 90;
wire [8:0] period = {1'b0, tw_s} + 9'd24;
always @(posedge clk_vid) if (vs & ~vs_1) begin
    if (gen_s[2] != gen_s[1] || !ovl_v) begin scroll <= 0; mq_hold <= 7'd90; end
    else if (mq_hold != 0) mq_hold <= mq_hold - 1'b1;
    else if (tw_s > 8'd92) begin
        if (scroll + 1'b1 >= period) begin scroll <= 0; mq_hold <= 7'd90; end
        else scroll <= scroll + 1'b1;
    end
end
wire [8:0] qx = de ? px + 9'd3 : 9'd2;     // 3-pixel lookahead for the 3-stage pipeline
localparam [8:0] PT1Y = 51;
wire       t1_row   = py >= PT1Y && py < PT1Y + 7;
wire [8:0] t1_start = 9'd80 - (tw_s >> 1);
wire       marquee  = tw_s > 8'd92;
wire [8:0] mx0 = qx - 9'd34 + scroll;
wire [8:0] mx  = (mx0 >= period) ? mx0 - period : mx0;
wire [8:0] t1x = marquee ? mx : qx - t1_start;
wire       t1_ok = t1_row && (marquee ? (qx >= 34 && qx < 126) : qx >= t1_start) && t1x < tw_s;
assign map_ra = {1'b0, t1x[7:0]};
wire [2:0] trow = py - PT1Y;

localparam [8:0] OX0 = 28, OX1 = 132, OY0 = 46, OY1 = 98;
localparam [8:0] R0Y = 64, R1Y = 79, RMY = 71;
wire       o_in  = ovl_v && qx >= OX0 && qx < OX1 && py >= OY0 && py < OY1;
wire [8:0] oax0  = qx - OX0, oax1 = OX1 - 9'd1 - qx, oay0 = py - OY0, oay1 = OY1 - 9'd1 - py;
wire [2:0] oax   = (oax0 < 4) ? oax0[2:0] : (oax1 < 4) ? oax1[2:0] : 3'd4;
wire [2:0] oay   = (oay0 < 4) ? oay0[2:0] : (oay1 < 4) ? oay1[2:0] : 3'd4;
wire       o_cut = ({1'b0, oax} + {1'b0, oay}) < 4'd3;
wire       o_brd = !o_cut && (oax == 0 || oay == 0 || ({1'b0, oax} + {1'b0, oay}) == 4'd3);
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
wire       o_sel = (o_r0 && !psel_v) || (o_r1 && psel_v);
wire [8:0] o_px  = qx - (o_st - 9'd6);
wire [8:0] o_py  = o_r0 ? py - (R0Y - 2) : py - (R1Y - 2);
wire [8:0] o_pw  = o_w + 9'd12;
wire       o_pil = o_sel && qx >= o_st - 9'd6 && o_px < o_pw &&
                   !(((o_px == 0) || (o_px == o_pw - 1)) && ((o_py == 0) || (o_py == 10)));

reg ot1 = 0, t1_1 = 0; reg [6:0] och1 = 0; reg [2:0] ocol1 = 0, orow1 = 0, trow1 = 0;
reg oin1 = 0, ocut1 = 0, obrd1 = 0, opil1 = 0;
always @(posedge clk_vid) begin
    ot1 <= o_in && o_trow; och1 <= o_ch[6:0]; ocol1 <= o_col; orow1 <= o_ty[2:0];
    oin1 <= o_in; ocut1 <= o_cut; obrd1 <= o_brd; opil1 <= o_pil; t1_1 <= t1_ok; trow1 <= trow;
end
wire [7:0] glyph;
font5x7_rom font (.clk(clk_vid), .addr(ot1 ? {och1, orow1} : {map_q[9:3], trow1}), .q(glyph));
reg [2:0] gcol2 = 0; reg gval2 = 0, ot2 = 0, t1_2 = 0, oin2 = 0, ocut2 = 0, obrd2 = 0, opil2 = 0;
always @(posedge clk_vid) begin
    gcol2 <= ot1 ? ocol1 : map_q[2:0]; gval2 <= ot1 ? 1'b1 : map_q[10]; ot2 <= ot1; t1_2 <= t1_1;
    oin2 <= oin1; ocut2 <= ocut1; obrd2 <= obrd1; opil2 <= opil1;
end
wire glyph_on = gval2 && gcol2 < 3'd5 && glyph[gcol2];
always @(posedge clk_vid) begin
    menu_on <= ovl_v && oin2 && !ocut2;
    if (obrd2)                          menu_rgb <= 24'h464E64;
    else if (opil2 && ot2 && glyph_on)  menu_rgb <= 24'h141824;
    else if (opil2)                     menu_rgb <= 24'hE8ECF4;
    else if (ot2 && glyph_on)           menu_rgb <= 24'hD2D6E2;
    else if (t1_2 && glyph_on)          menu_rgb <= 24'h969EB4;
    else                                menu_rgb <= 24'h141824;
end

// ---------------------------------------------------------------- hi-res menu: 320x288 at 6.71 MHz, 374 x 300 total
localparam [8:0] HT = 374, VT = 300, HOFF = 40, VOFF = 6;
localparam [8:0] HR_W = 320, HR_H = 288;
reg [8:0] hc = 0, vc = 0;
always @(posedge clk_vid) begin
    if (hc == HT - 1) begin hc <= 0; vc <= (vc == VT - 1) ? 9'd0 : vc + 1'b1; end
    else hc <= hc + 1'b1;
end
wire       h_act = hc >= HOFF && hc < HOFF + HR_W;
wire       v_act = vc >= VOFF && vc < VOFF + HR_H;
wire [8:0] x = hc - HOFF, y = vc - VOFF;
always @(posedge clk_vid) vs_any <= menu_v ? (vc < 9'd2) : vs;

// cover parameters for this frame, latched in the vertical blank (they change right after the frame tick)
reg signed [10:0] vx [0:3]; reg [7:0] vs_ [0:3]; reg [4:0] vb [0:3]; reg [CB-1:0] vg [0:3]; reg vv [0:3], vl [0:3];
reg signed [10:0] vy [0:3]; reg vkey [0:3];
reg [7:0] glow_v = 0; reg [15:0] acc_v = 0; reg [4:0] rf_v = 5'd31, gf_v = 5'd31;
// the lattice for this frame
reg lv_on = 0; reg signed [10:0] lv_y0 = 0; reg [4:0] lv_b = 0; reg [3:0] lv_skip = 4'd15;
reg [CB-1:0] lv_g [0:11]; reg lv_v [0:11], lv_l [0:11];
integer vk;
always @(posedge clk_vid) if (vc == 9'd3 && hc == 0) begin
    for (vk = 0; vk < 4; vk = vk + 1) begin
        vx[vk] <= cx[vk]; vs_[vk] <= cs[vk]; vb[vk] <= cb[vk]; vg[vk] <= cg[vk][CB-1:0]; vv[vk] <= cv[vk]; vl[vk] <= cl[vk];
        vy[vk] <= cy[vk]; vkey[vk] <= ck[vk];
    end
    for (vk = 0; vk < 12; vk = vk + 1) begin lv_g[vk] <= lat_g[vk][CB-1:0]; lv_v[vk] <= lat_v[vk]; lv_l[vk] <= lat_l[vk]; end
    lv_on <= lat_on; lv_y0 <= lat_y0; lv_b <= lat_b; lv_skip <= lat_skip;
    glow_v <= glow_out[10:3]; acc_v <= glow_acc; rf_v <= rf; gf_v <= gf;
end
localparam [8:0] LAT_W = 9'd72, LAT_H = 9'd87, LAT_CLIP = 9'd192;
// this frame's ring and shine
wire [16:0] rg_r2 = ring_r2(rf_v); wire [11:0] rg_b = (rf_v == 5'd31) ? 12'd0 : ring_b(rf_v); wire [14:0] rg_m = ring_m(rf_v);
wire signed [10:0] gl_p = glint_p(gf_v); wire gl_on = gf_v != 5'd31;

// line requests to the SDRAM fetcher: at the start of each line, fetch the next one
reg       lreq_t = 0; reg [8:0] lreq_y = 0;
always @(posedge clk_vid) if (hc == 0) begin
    if (vc >= VOFF - 1 && vc < VOFF + HR_H - 1) begin lreq_y <= vc - (VOFF - 1); lreq_t <= ~lreq_t; end
end

// ---- stage 0: which cover owns this pixel: a free cover, else a lattice cell
wire [8:0]  l_cx0 = x - 9'd10;
wire [1:0]  l_c   = (l_cx0 >= 9'd228) ? 2'd3 : (l_cx0 >= 9'd152) ? 2'd2 : (l_cx0 >= 9'd76) ? 2'd1 : 2'd0;
wire [8:0]  l_lx  = l_cx0 - ((l_c == 2'd3) ? 9'd228 : (l_c == 2'd2) ? 9'd152 : (l_c == 2'd1) ? 9'd76 : 9'd0);
wire signed [10:0] l_ry0 = $signed({2'b0, y}) - lv_y0;
wire [1:0]  l_r   = (l_ry0 >= 11'sd188) ? 2'd2 : (l_ry0 >= 11'sd94) ? 2'd1 : 2'd0;
wire signed [10:0] l_ly = l_ry0 - ((l_r == 2'd2) ? 11'sd188 : (l_r == 2'd1) ? 11'sd94 : 11'sd0);
wire [3:0]  l_cell = {l_r, l_c};
wire        l_hit = lv_on && x >= 9'd10 && x < 9'd314 && l_lx < LAT_W && y < LAT_CLIP && l_ry0 >= 0 && l_ly < $signed({2'b0, LAT_H})
                    && lv_v[l_cell] && l_cell != lv_skip;
reg        hk_any; reg [1:0] hk; reg [7:0] hlx, hly, hS; reg [7:0] hR; reg [4:0] hB; reg hKey;
integer hi;
always @(*) begin
    hk_any = l_hit; hk = 0; hlx = l_lx[7:0]; hly = l_ly[7:0]; hS = 8'd72; hR = 8'd15; hB = lv_b; hKey = 0;
    for (hi = 3; hi >= 0; hi = hi - 1) begin : own
        reg signed [11:0] lx, ly; reg [7:0] r;
        lx = $signed({3'b0, x}) - vx[hi];
        ly = $signed({3'b0, y}) - ($signed(12'sd96) - $signed({5'b0, vs_[hi][7:1]}) + vy[hi]);
        r  = (vs_[hi] * 7) >> 5;                                   // reflection rows
        if (vv[hi] && lx >= 0 && lx < $signed({4'b0, vs_[hi]}) && ly >= 0 && ly < $signed({4'b0, vs_[hi]}) + $signed({4'b0, r})) begin
            hk_any = 1; hk = hi[1:0]; hlx = lx[7:0]; hly = ly[7:0]; hS = vs_[hi]; hR = r; hB = vb[hi]; hKey = vkey[hi];
        end
    end
end
wire       h_refl = hly >= hS;
wire [7:0] h_ry   = hly - hS;
wire [7:0] h_m    = hS - 1'b1;
wire [7:0] h_ax   = (hlx < 6) ? hlx : (hlx > h_m - 6) ? h_m - hlx : 8'd6;
wire [7:0] h_ay   = (hly < 6) ? hly : (!h_refl && hly > h_m - 6) ? h_m - hly : 8'd6;
wire [3:0] h_cx   = 4'd6 - h_ax[3:0], h_cy = 4'd6 - h_ay[3:0];
wire       h_cut  = !h_refl && h_ax < 6 && h_ay < 6 && ({4'd0, h_cx} * h_cx + {4'd0, h_cy} * h_cy) > 8'd30;
wire [4:0] h_a    = h_refl ? ((hR - 1'b1 - h_ry) >> 2) : 5'd16;         // reflection strength, 0..6

// text: title (16 rows) and platform line, from the hi-res map
localparam [8:0] HT1Y = 200, HT2Y = 222, HDY = 256, HT3Y = 266;
reg [9:0] hscroll = 0; reg [6:0] hmq_hold = 90;
wire [9:0] hperiod = {1'b0, htw_s} + 10'd48;
wire       hmarq = htw_s > 9'd300;
always @(posedge clk_vid) if (vc == 0 && hc == 0) begin
    if (gen_s[2] != gen_s[1]) begin hscroll <= 0; hmq_hold <= 7'd90; end
    else if (hmq_hold != 0) hmq_hold <= hmq_hold - 1'b1;
    else if (hmarq) begin
        if (hscroll + 1'b1 >= hperiod) begin hscroll <= 0; hmq_hold <= 7'd90; end
        else hscroll <= hscroll + 1'b1;
    end
end
wire       ht1_row = y >= HT1Y && y < HT1Y + 16, ht2_row = y >= HT2Y && y < HT2Y + 16;
wire [8:0] ht1_st = 9'd160 - (htw_s >> 1), ht2_st = 9'd160 - (hsw_s >> 1);
wire [9:0] hmx0 = {1'b0, x} - 10'd10 + hscroll;
wire [9:0] hmx  = (hmx0 >= hperiod) ? hmx0 - hperiod : hmx0;
wire [9:0] ht1x = hmarq ? hmx : {1'b0, x - ht1_st};
wire       ht1_ok = ht1_row && (hmarq ? (x >= 10 && x < 310) : x >= ht1_st) && ht1x < {1'b0, htw_s};
wire [8:0] ht2x = x - ht2_st;
wire       ht2_ok = ht2_row && x >= ht2_st && ht2x < hsw_s;
// the button legend: line 3 of the map, the small font, no title fade (only the menu's level)
wire       ht3_row = y >= HT3Y && y < HT3Y + 16;
wire [8:0] ht3_st = 9'd160 - (lgw_s >> 1);
wire [8:0] ht3x = x - ht3_st;
wire       ht3_ok = ht3_row && x >= ht3_st && ht3x < lgw_s;
assign map2_ra = ht3_row ? {2'b10, ht3x} : ht2_row ? {2'b01, ht2x} : {2'b00, ht1x[8:0]};
wire [3:0] htrow = ht3_row ? y - HT3Y : ht2_row ? y - HT2Y : y - HT1Y;

// position: page dots (8 px pitch, 4x4 dots, the current one an 8x4 pill) up to 32 games, beyond that a 128 px
// track with an 8 px thumb
wire       hd_bar = cnt_s > 11'd32;
wire [8:0] hd_st = hd_bar ? 9'd96 : 9'd160 - {cnt_s[5:0], 2'b0};
wire [8:0] hdx = x - hd_st;
wire       hd_row = cnt_s > 11'd1 && y >= HDY && y < HDY + 4 && x >= hd_st && hdx < (hd_bar ? 9'd128 : {cnt_s[5:0], 3'b0});   // none for one item
wire [8:0] hd_thx = hdx - {2'b0, pos_s};
wire       hd_cur = hd_row && (hd_bar ? (hdx >= {2'b0, pos_s} && hd_thx < 9'd8) : hdx[8:3] == idx_s[5:0]);
wire       hd_dim = hd_row && !hd_cur && (hd_bar ? (y == HDY + 1 || y == HDY + 2) : (hdx[2:0] >= 3'd2 && hdx[2:0] < 3'd6));
wire [2:0] hd_px  = hd_bar ? hd_thx[2:0] : hdx[2:0];
wire       hd_rnd = hd_row && (hd_px == 0 || hd_px == 7) && (y == HDY || y == HDY + 3);   // pill corners

// background: black, lit by the cart's glow and the ring that leaves it as it seats (centered on the cover's rest
// position). Distances are squared: d^2 >> 8 indexes the glow falloff, |d^2 - r^2| < B is the ring's band.
wire signed [9:0] gdx = $signed({1'b0, x}) - 10'sd160, gdy = $signed({1'b0, y}) - 10'sd96;
wire [16:0] gd2 = gdx * gdx + gdy * gdy;
wire [7:0]  gidx = gd2[16] ? 8'd255 : gd2[15:8];
wire [16:0] ge  = (gd2 > rg_r2) ? gd2 - rg_r2 : rg_r2 - gd2;
wire [11:0] grm = (ge < {5'd0, rg_b}) ? rg_b - ge[11:0] : 12'd0;
// shine: a band along x + y of the center cover
wire signed [10:0] gl_d0 = $signed({2'b0, hlx} + {2'b0, hly}) - gl_p;
wire [10:0] gl_d = gl_d0[10] ? -gl_d0 : gl_d0;
wire [3:0]  h_gw = (gl_on && hk_any && hk == 2'd1 && !h_refl && gl_d < 11'd16) ? glint_w(gl_d[3:0]) : 4'd0;

// line buffer: written by the fetcher (clk_sys), two lines, indexed by screen x
reg         lb_we = 0; reg [9:0] lb_wa = 0; reg [15:0] lb_wd = 0;
wire [15:0] lb_q;
picker_dpram #(.WIDTH(16), .ADDR(10)) line_buf (
    .wclk(clk_sys), .we(lb_we), .waddr(lb_wa), .wdata(lb_wd),
    .rclk(clk_vid), .raddr({y[0], x}), .q(lb_q));

// ---- stage 1
reg s1_act = 0, s1_c = 0, s1_cut = 0, s1_t1 = 0, s1_t2 = 0, s1_t3 = 0, s1_dc = 0, s1_dd = 0, s1_dr = 0, s1_key = 0;
reg [4:0] s1_a = 0, s1_b = 0; reg [3:0] s1_row = 0; reg [3:0] s1_gw = 0; reg [7:0] s1_gi = 0, s1_bay = 0;
reg [26:0] s1_rp = 0;
reg [2:0] hde = 0, hhs = 0, hvs = 0;
always @(posedge clk_vid) begin
    s1_act <= h_act && v_act; s1_c <= hk_any; s1_cut <= h_cut; s1_a <= h_a; s1_b <= hB;
    s1_t1 <= ht1_ok; s1_t2 <= ht2_ok; s1_t3 <= ht3_ok; s1_row <= htrow; s1_dc <= hd_cur && !hd_rnd; s1_dd <= hd_dim;
    s1_key <= hKey; s1_gw <= h_gw; s1_gi <= glow_i(gidx); s1_rp <= grm * rg_m;
    s1_bay <= {bayer(x[1:0], y[1:0]), 4'd8};
    hde <= {hde[1:0], h_act && v_act};
    hhs <= {hhs[1:0], hc == 9'd8};
    hvs <= {hvs[1:0], vc == 0 && hc == 9'd2};
end
wire [23:0] font2_q, font3_q;
font_hr_rom font2 (.clk(clk_vid), .addr({map2_q[10:4], s1_row}), .q(font2_q));
font_sm_rom font3 (.clk(clk_vid), .addr({map2_q[9:4], s1_row}), .q(font3_q));
// ---- stage 2
reg s2_act = 0, s2_c = 0, s2_cut = 0, s2_t1 = 0, s2_t2 = 0, s2_t3 = 0, s2_dc = 0, s2_dd = 0; reg [3:0] s2_col = 0; reg s2_gv = 0;
reg [4:0] s2_a = 0, s2_b = 0; reg [15:0] s2_pix = 0; reg s2_key = 0; reg [3:0] s2_gw = 0;
reg [15:0] s2_gk = 0; reg [7:0] s2_bay = 0, s2_rw = 0;
always @(posedge clk_vid) begin
    s2_act <= s1_act; s2_c <= s1_c; s2_cut <= s1_cut; s2_a <= s1_a; s2_b <= s1_b; s2_t1 <= s1_t1; s2_t2 <= s1_t2; s2_t3 <= s1_t3;
    s2_dc <= s1_dc; s2_dd <= s1_dd; s2_pix <= lb_q;
    s2_key <= s1_key; s2_gw <= s1_gw; s2_gk <= s1_gi * glow_v; s2_bay <= s1_bay;
    s2_rw <= (s1_rp[26:16] > 11'd255) ? 8'd255 : s1_rp[23:16];
    s2_col <= map2_q[3:0]; s2_gv <= map2_q[11];
end
wire [1:0] galpha = (s2_gv && s2_col < 12) ? (s2_t3 ? font3_q[{s2_col, 1'b0} +: 2] : font2_q[{s2_col, 1'b0} +: 2]) : 2'd0;
// glow color * strength, dithered (4x4 Bayer) to hide banding in the dark falloff; the ring is a lighter tint on top
wire [7:0] ac_r = {acc_v[15:11], acc_v[15:13]}, ac_g = {acc_v[10:5], acc_v[10:9]}, ac_b = {acc_v[4:0], acc_v[4:2]};
wire [7:0] gk8 = s2_gk[15:8];
wire [15:0] gw_r = ac_r * gk8 + s2_bay, gw_g = ac_g * gk8 + s2_bay, gw_b = ac_b * gk8 + s2_bay;
wire [8:0] lt_r = ({1'b0, ac_r} + 9'd255) >> 1, lt_g = ({1'b0, ac_g} + 9'd255) >> 1, lt_b = ({1'b0, ac_b} + 9'd255) >> 1;
wire [15:0] rw_r = lt_r[7:0] * s2_rw, rw_g = lt_g[7:0] * s2_rw, rw_b = lt_b[7:0] * s2_rw;
wire [7:0] s2_br = (rw_r[15:8] > gw_r[15:8]) ? rw_r[15:8] : gw_r[15:8];
wire [7:0] s2_bg = (rw_g[15:8] > gw_g[15:8]) ? rw_g[15:8] : gw_g[15:8];
wire [7:0] s2_bb = (rw_b[15:8] > gw_b[15:8]) ? rw_b[15:8] : gw_b[15:8];
wire [7:0] pr = {s2_pix[15:11], s2_pix[15:13]}, pg = {s2_pix[10:5], s2_pix[10:9]}, pb = {s2_pix[4:0], s2_pix[4:2]};
wire [12:0] br_r = pr * s2_b, br_g = pg * s2_b, br_b = pb * s2_b;        // brightness 0..16
wire [7:0] cr1 = (s2_b == 16) ? pr : br_r[11:4], cg1 = (s2_b == 16) ? pg : br_g[11:4], cb1 = (s2_b == 16) ? pb : br_b[11:4];
wire [7:0] cr2 = mix(cr1, 8'd255, {1'b0, s2_gw}), cg2 = mix(cg1, 8'd255, {1'b0, s2_gw}), cb2 = mix(cb1, 8'd255, {1'b0, s2_gw});
wire       s2_clear = s2_key && s2_pix == 16'd0;   // the default images' transparent black
wire [4:0] hlvl = {lvl_s, 1'b0};
wire [8:0] hwp  = s2_a * hlvl;
wire [4:0] hwc  = hwp[8:4];
wire [4:0] tal  = (galpha == 3) ? 5'd16 : (galpha == 2) ? 5'd11 : (galpha == 1) ? 5'd5 : 5'd0;
wire [8:0] tlp  = tal * {tl_s, 1'b0};
wire [8:0] tlq  = tlp[8:4] * hlvl;
wire [4:0] twc  = tlq[8:4];
wire [8:0] t3p  = tal * hlvl;                       // the legend: the menu's level only, no title fade
wire [4:0] t3c  = t3p[8:4];
reg [31:0] q_samp = 0;   // log: the pixel fetched for (160, 100) with its row base
reg [21:0] dcnt = 0; reg [3:0] dacc = 0, dshow = 0;   // diagnostics: fetcher activity over ~30 ms windows (clk_sys)
// diagnostics: 24 squares (8 px on a 10 px pitch, groups of 4) along the top: green = 1, dark red = 0
reg [23:0] dbg_v0 = 0, dbg_v = 0;
always @(posedge clk_vid) begin dbg_v0 <= {dshow, dbg_art_done, dbg_art_err, hold_gb, menu_active, dbg}; dbg_v <= dbg_v0; end
wire [8:0] dqx = x - 9'd4; wire [4:0] dq_i = dqx / 9'd10; wire [3:0] dq_o = dqx - dq_i * 9'd10;
wire [4:0] dsq = dq_i + dq_i / 3'd4;   // square index skipping one slot after every four
reg  s1_dbg = 0, s1_dbv = 0, s2_dbg = 0, s2_dbv = 0;
always @(posedge clk_vid) begin
    s1_dbg <= DEBUG_SQUARES && x >= 4 && y >= 2 && y < 10 && dq_o < 8 && dq_i < 29 && (dq_i % 5) != 4;
    s1_dbv <= dbg_v[dq_i - dq_i / 3'd5];
    s2_dbg <= s1_dbg; s2_dbv <= s1_dbv;
end
reg [23:0] h_out;
always @(*) begin
    if (s2_dbg)           h_out = s2_dbv ? 24'h20E040 : 24'h601010;
    else if (s2_c && !s2_cut && !s2_clear)  h_out = {mix(s2_br, cr2, hwc), mix(s2_bg, cg2, hwc), mix(s2_bb, cb2, hwc)};
    else if (s2_t1)       h_out = {mix(s2_br, 8'd246, twc), mix(s2_bg, 8'd246, twc), mix(s2_bb, 8'd250, twc)};
    else if (s2_t2)       h_out = {mix(s2_br, 8'd128, twc), mix(s2_bg, 8'd140, twc), mix(s2_bb, 8'd168, twc)};
    else if (s2_t3)       h_out = {mix(s2_br, 8'd128, t3c), mix(s2_bg, 8'd140, t3c), mix(s2_bb, 8'd168, t3c)};
    else if (s2_dc)       h_out = {mix(s2_br, 8'd232, hlvl), mix(s2_bg, 8'd236, hlvl), mix(s2_bb, 8'd244, hlvl)};
    else if (s2_dd)       h_out = {mix(s2_br, 8'd74, hlvl), mix(s2_bg, 8'd82, hlvl), mix(s2_bb, 8'd104, hlvl)};
    else                  h_out = {s2_br, s2_bg, s2_bb};
end
always @(posedge clk_vid) begin
    hr_de <= hde[1]; hr_hs <= hhs[1]; hr_vs <= hvs[1];
    hr_rgb <= s2_act ? h_out : 24'h0;
end

function [3:0] bayer(input [1:0] bx, input [1:0] by);
    case ({by, bx})
    0: bayer = 0;  1: bayer = 8;  2: bayer = 2;  3: bayer = 10; 4: bayer = 12; 5: bayer = 4;  6: bayer = 14; 7: bayer = 6;
    8: bayer = 3;  9: bayer = 11; 10: bayer = 1; 11: bayer = 9; 12: bayer = 15; 13: bayer = 7; 14: bayer = 13; default: bayer = 5;
    endcase
endfunction
function [7:0] mix(input [7:0] a, input [7:0] b, input [4:0] w);   // a*(16-w)/16 + b*w/16
    reg [12:0] t;
    begin
        t = {5'd0, a} * {8'd0, 5'd16 - w} + {5'd0, b} * {8'd0, w};
        mix = t[11:4];
    end
endfunction

// ---------------------------------------------------------------- SDRAM line fetcher (clk_sys)
// One read per SDRAM cycle (sd_ce, ~8.4 MHz). The address is set, and the previous read's data captured, two
// clk_sys cycles after each sd_ce, safely inside the window where the controller's dout holds that read.
// The menu owns the SDRAM whenever the Game Boy is held, except while its own ROM download runs. Art words wait in a
// FIFO and are written in the SDRAM cycles the line fetcher leaves free.
reg [2:0] own_s = 0;
always @(posedge clk_sys) own_s <= {own_s[1:0], hold_gb & ~picker_download};
assign sd_own = own_s[2];
reg  [8:0]  ff_wp = 0, ff_rp = 0, ff_wp1 = 0, ff_wp2 = 0;
wire        ff_empty = ff_wp2 == ff_rp;    // compare with the write pointer two clocks late: the RAM read is registered
wire [39:0] ff_q;
picker_dpram #(.WIDTH(40), .ADDR(8)) art_fifo (
    .wclk(clk_sys), .we(art_wr), .waddr(ff_wp[7:0]), .wdata({art_waddr, art_wdata}),
    .rclk(clk_sys), .raddr(ff_rp[7:0]), .q(ff_q));
always @(posedge clk_sys) begin if (art_wr) ff_wp <= ff_wp + 1'b1; ff_wp1 <= ff_wp; ff_wp2 <= ff_wp1; end
reg [2:0] ffe_s = 0;
always @(posedge clk_74a) ffe_s <= {ffe_s[1:0], ff_empty};
reg [2:0] lq_s = 0; reg [8:0] fy = 0;
reg [1:0] ce_d = 0;
always @(posedge clk_sys) begin lq_s <= {lq_s[1:0], lreq_t}; ce_d <= {ce_d[0], sd_ce}; end
wire tick = ce_d[1];
// frame parameters for the fetcher, latched when line 0 is requested
reg signed [10:0] fx [0:3]; reg [7:0] fs_ [0:3]; reg [CB-1:0] fg [0:3]; reg fv [0:3], fl [0:3]; reg signed [10:0] fyo [0:3];
reg lf_on = 0; reg signed [10:0] lf_y0 = 0; reg [3:0] lf_skip = 4'd15; reg [CB-1:0] lf_g [0:11]; reg lf_v [0:11], lf_l [0:11];
reg [2:0]  fk = 0;          // segment being fetched: 0..3 the lattice row's cells, 4..7 the free covers
reg        fcl = 0;         // its art is in the cache
// the lattice row this line crosses (at most one: rows are 94 apart, a row band is 87 tall)
wire signed [10:0] f_ry0 = $signed({2'b0, fy}) - lf_y0;
wire [1:0]  f_r  = (f_ry0 >= 11'sd188) ? 2'd2 : (f_ry0 >= 11'sd94) ? 2'd1 : 2'd0;
wire signed [10:0] f_ly = f_ry0 - ((f_r == 2'd2) ? 11'sd188 : (f_r == 2'd1) ? 11'sd94 : 11'sd0);
wire        f_row_ok = lf_on && fy < LAT_CLIP && f_ry0 >= 0 && f_ly < $signed({2'b0, LAT_H});
reg [2:0]  fst = 0;         // 0 idle, 1 setup, 2 setup2, 3 run, 4 drain
reg [8:0]  fxc = 0, fxe = 0;  // current / end screen x
reg [17:0] facc = 0;        // source x, 8.8 fixed point (+ guard)
reg [9:0]  fstep = 0;
reg [23:0] fbase = 0;
reg        fpend = 0, fpend2 = 0; reg [8:0] fpx = 0, fpx2 = 0;   // reads in flight: data returns two ticks later
integer fi2;
always @(posedge clk_sys) begin
    lb_we <= 0;
    if (tick) sd_we <= 0;                           // a write lasts one SDRAM cycle
    if (lq_s[2] != lq_s[1]) begin
        fy <= lreq_y; fk <= 0; fst <= 3'd1; fpend <= 0; fpend2 <= 0;
        if (lreq_y == 0) begin
            for (fi2 = 0; fi2 < 4; fi2 = fi2 + 1) begin fx[fi2] <= vx[fi2]; fs_[fi2] <= vs_[fi2]; fg[fi2] <= vg[fi2]; fv[fi2] <= vv[fi2]; fl[fi2] <= vl[fi2]; fyo[fi2] <= vy[fi2]; end
            for (fi2 = 0; fi2 < 12; fi2 = fi2 + 1) begin lf_g[fi2] <= lv_g[fi2]; lf_v[fi2] <= lv_v[fi2]; lf_l[fi2] <= lv_l[fi2]; end
            lf_on <= lv_on; lf_y0 <= lv_y0; lf_skip <= lv_skip;
        end
    end else case (fst)
    3'd1: if (fk < 4) begin : lsetup                  // a lattice cell of the row this line crosses
        reg [3:0] lcl; reg [7:0] row; reg [17:0] rowf;
        lcl = {f_r, fk[1:0]};
        if (!f_row_ok || !lf_v[lcl] || lcl == lf_skip) fk <= fk + 1'b1;
        else begin
            row   = (f_ly < 11'sd72) ? f_ly[7:0] : 8'd143 - f_ly[7:0];   // reflection mirrors
            fstep <= step_lut[72];
            rowf  = row * step_lut[72];
            fbase <= ART_WORD + ({{(24-CB){1'b0}}, lf_g[lcl]} << 15) + 24'd16384 + rowf[15:8] * 24'd80;
            facc  <= 0; fcl <= lf_l[lcl];
            fxc <= 9'd10 + {fk[1:0], 2'b0} * 9'd19; fxe <= 9'd82 + {fk[1:0], 2'b0} * 9'd19;   // 10 + 76 k .. + 72
            fst <= 3'd3;
        end
    end else begin : setup
        reg signed [11:0] ly, xs, xe; reg [7:0] S, r, row; reg [17:0] rowf; reg [1:0] c;
        c  = fk[1:0];
        S  = fs_[c]; r = (S * 7) >> 5;
        ly = $signed({3'b0, fy}) - ($signed(12'sd96) - $signed({5'b0, S[7:1]}) + fyo[c]);
        xs = (fx[c] < 0) ? 12'sd0 : fx[c];
        xe = (fx[c] + $signed({4'b0, S}) > 12'sd320) ? 12'sd320 : fx[c] + $signed({4'b0, S});
        if (!fv[c] || ly < 0 || ly >= $signed({4'b0, S}) + $signed({4'b0, r}) || xs >= xe) begin
            if (fk == 7) fst <= 3'd4; else fk <= fk + 1'b1;
        end else begin
            row   = (ly < $signed({4'b0, S})) ? ly[7:0] : S - 1'b1 - (ly[7:0] - S);   // reflection mirrors
            fstep <= step_lut[S];
            rowf  = row * step_lut[S];
            fbase <= ART_WORD + ({{(24-CB){1'b0}}, fg[c]} << 15) + ((S <= 80) ? 24'd16384 + rowf[15:8] * 24'd80 : {9'd0, rowf[15:8], 7'd0});
            facc  <= (xs - fx[c]) * step_lut[S];
            fxc <= xs[8:0]; fxe <= xe[8:0]; fcl <= fl[c];
            fst <= 3'd3;
        end
    end
    3'd3: if (tick && sd_own) begin
        // the address set at tick t is sampled at the next SDRAM sync and its data is captured at tick t + 2
        if (fpend2) begin lb_we <= 1; lb_wa <= {fy[0], fpx2}; lb_wd <= sd_q; end
        fpend2 <= fpend; fpx2 <= fpx;
        if (fxc < fxe && fcl) begin
            sd_addr <= fbase + facc[17:8]; sd_oe <= 1; fpend <= 1; fpx <= fxc;
            fxc <= fxc + 1'b1; facc <= facc + fstep;
        end else begin
            fpend <= 0;
            if (fxc < fxe) begin                    // cover not in the cache yet: a flat tile, and the cycle is free
                lb_we <= 1; lb_wa <= {fy[0], fxc}; lb_wd <= PLACEHOLDER; fxc <= fxc + 1'b1;
            end else if (!fpend && !fpend2) begin   // drained
                if (fk == 7) fst <= 3'd4; else begin fk <= fk + 1'b1; fst <= 3'd1; end
            end
            if (!ff_empty) begin sd_we <= 1; sd_oe <= 0; sd_addr <= ff_q[39:16]; sd_wd <= ff_q[15:0]; ff_rp <= ff_rp + 1'b1; end
        end
    end
    3'd4: begin sd_oe <= 0; fst <= 3'd0; end
    default: ;
    endcase
    // free SDRAM cycles outside a fetch run go to the art FIFO
    if (tick && sd_own && fst != 3'd3 && !(lq_s[2] != lq_s[1]) && !ff_empty) begin
        sd_we <= 1; sd_oe <= 0; sd_addr <= ff_q[39:16]; sd_wd <= ff_q[15:0]; ff_rp <= ff_rp + 1'b1;
    end
    if (!sd_own) begin sd_oe <= 0; sd_we <= 0; end
    if (lb_we && fy == 9'd100 && lb_wa[8:0] == 9'd160) q_samp <= {fbase[15:0], lb_wd};   // center cover, row 100
    dcnt <= dcnt + 1'b1;
    dacc <= dacc | {lb_we, fst == 3'd3, lq_s[2] != lq_s[1], tick};
    if (dcnt == 0) begin dshow <= dacc; dacc <= 0; end
end


// ================================================================== debug log (clk_74a)
// A ring of 511 eight-byte records, written to /Saves/gbc/common/picker.log (data slot 103) after the menu has sat idle
// for 3 s following boot or Home. Record: tag (S state change, D diagnostic bits changed, Q SDRAM sample), time in
// units of 4096 clk_74a cycles (55 us), 32 bits of data. Record 0 is a header: "PLOG", next write slot, total count.
// tools/read_picker_log.py decodes it.
reg  [35:0] lg_time = 0;
reg  [7:0]  lg_st = S_BOOT;
reg  [23:0] dbg_a0 = 0, dbg_a = 0, lg_dbg = 0;
reg  [31:0] q_a0 = 0, q_a = 0;
reg  [7:0]  lg_wp = 8'd1;
reg  [15:0] lg_n = 0;
reg  [3:0]  qcnt = 0; reg q_pend = 0; reg menu_1 = 0;
reg         lg_we = 0; reg [63:0] lg_wd = 0;
reg  [31:0] lg_cart = 0;
reg  [1:0]  lgh_pend = 0; reg lgh_seen = 0;
wire [63:0] lg_q;
picker_dpram #(.WIDTH(64), .ADDR(8)) log_ram (
    .wclk(clk_74a), .we(lg_we), .waddr(lg_wp), .wdata(lg_wd),
    .rclk(clk_74a), .raddr(bridge_addr[10:3]), .q(lg_q));
reg  [11:0] lr_a = 0;
always @(posedge clk_74a) lr_a <= bridge_addr[11:0];
wire [31:0] log_word = (lr_a[10:3] == 0) ? (lr_a[2] ? {8'd0, lg_wp, lg_n} : "PLOG") : (lr_a[2] ? lg_q[31:0] : lg_q[63:32]);
reg  [9:0]  fr_a = 0;
always @(posedge clk_74a) fr_a <= bridge_addr[11:2];
reg  [31:0] fav_word;
always @(*) begin : favw                             // "FAV2", u16 version 2, u16 n, then 16 byte records:
    reg [7:0] r; reg [1:0] f;                        // u32 crc, u8 state, 3 pad, u16 favorites position, u16 A to Z position, 4 pad
    r = (fr_a - 10'd2) >> 2; f = fr_a[1:0] - 2'd2;
    if (fr_a == 0) fav_word = "FAV2";
    else if (fr_a == 1) fav_word = {8'h02, 8'h00, 4'd0, fv_n, 8'h00};
    else if (r < fv_n && f == 0) fav_word = {fv_crc[r[3:0]][7:0], fv_crc[r[3:0]][15:8], fv_crc[r[3:0]][23:16], fv_crc[r[3:0]][31:24]};
    else if (r < fv_n && f == 1) fav_word = {7'd0, fv_st[r[3:0]], 24'd0};
    else if (r < fv_n && f == 2) fav_word = {5'd0, fv_fp[r[3:0]][10:8], fv_fp[r[3:0]][7:0], 5'd0, fv_ap[r[3:0]][10:8], fv_ap[r[3:0]][7:0]} ;
    else fav_word = 32'd0;
end
reg  [31:0] crl_word;
always @(*) begin : crlw                             // carts.cfg: "CRL1", u16 version 1, u16 n, 8 zero bytes, record:
    reg [2:0] j;                                     // header 0x134..0x14F and 4 zero bytes (served at CRL_ADDR + 16)
    j = fr_a[2:0] - 3'd4;
    if (fr_a == 0) crl_word = "CRL1";
    else if (fr_a == 1) crl_word = {8'h01, 8'h00, 1'b0, crl_n, 8'h00};
    else if (fr_a >= 4 && fr_a <= 10)
        crl_word = {cart_hdr[{j, 5'd0} +: 8], cart_hdr[{j, 5'd0} + 8 +: 8], cart_hdr[{j, 5'd0} + 16 +: 8], cart_hdr[{j, 5'd0} + 24 +: 8]};
    else crl_word = 32'd0;
end
always @(posedge clk_74a) if (bridge_rd) param_rd_data <= (bridge_addr[31:24] == LOG_ADDR[31:24]) ? log_word :
                                                       (bridge_addr[31:24] == FAV_ADDR[31:24]) ? fav_word :
                                                       (bridge_addr[31:24] == CRL_ADDR[31:24]) ? crl_word : param_q;
always @(posedge clk_74a) begin
    lg_time <= lg_time + 1'b1;
    dbg_a0 <= {dshow, dbg_art_done, dbg_art_err, hold_gb, menu_active, dbg}; dbg_a <= dbg_a0;
    q_a0 <= q_samp; q_a <= q_a0;
    menu_1 <= menu_active;
    if (menu_active & ~menu_1) qcnt <= 4'd8;                        // eight samples after each menu entry
    else if (frame_tick && menu_active && qcnt != 0) begin qcnt <= qcnt - 1'b1; q_pend <= 1; end
    lg_we <= 0;
    if (lgh_req != lgh_seen) begin lgh_seen <= lgh_req; lgh_pend <= 2'd2; end
    if (lgh_pend != 0) begin                         // H: the cart header, then T: its title CRC
        lgh_pend <= lgh_pend - 1'b1; lg_we <= 1;
        lg_wd <= (lgh_pend == 2'd2) ? {"H", lg_time[35:12], cart_hdr[26*8 +: 8], cart_hdr[27*8 +: 8], cart_hdr[25*8 +: 8], cart_hdr[24*8 +: 8]}
                                    : {"T", lg_time[35:12], tcrc};
    end else if (cart_notify != lg_cart) begin      // C: APF 0x00B1 (cartridge adapter / power) changed
        lg_cart <= cart_notify; lg_we <= 1;
        lg_wd <= {"C", lg_time[35:12], cart_notify};
    end else if (state != lg_st) begin
        lg_st <= state;
        lg_we <= !(state >= S_MAP_FETCH && state <= S_MAP_DONE);   // the per-character layout steps are noise
        lg_wd <= {"S", lg_time[35:12], state, lg_st, target_dataslot_err[1:0], oerr, idx};   // 8 + 24 + 8 + 8 + 2 + 3 + 11
    end else if (dbg_a != lg_dbg) begin
        lg_dbg <= dbg_a; lg_we <= 1;
        lg_wd <= {"D", lg_time[35:12], 8'd0, dbg_a};
    end else if (q_pend) begin
        q_pend <= 0; lg_we <= 1;
        lg_wd <= {"Q", lg_time[35:12], q_a};
    end
    if (lg_we) begin lg_wp <= (lg_wp == 8'd255) ? 8'd65 : lg_wp + 1'b1; lg_n <= lg_n + 1'b1; end   // 1..64 keep the boot
end

endmodule

// hi-res menu font: Inter SemiBold 13 px (OFL), 2-bit antialiased, 12 px x 16 rows per glyph (tools/make_font.py)
module font_hr_rom (input wire clk, input wire [10:0] addr, output reg [23:0] q);
    reg [23:0] rom [0:2047];
    initial $readmemh("font_hr.hex", rom);
    always @(posedge clk) q <= rom[addr];
endmodule

// the legend's font: Inter 9 px with the button pictures in codes 1 to 14 (tools/make_legend_font.py), same format
module font_sm_rom (input wire clk, input wire [9:0] addr, output reg [23:0] q);
    reg [23:0] rom [0:1023];
    initial $readmemh("font_sm.hex", rom);
    always @(posedge clk) q <= rom[addr];
endmodule

// 5x7 font ROM (Adafruit GFX glcdfont, BSD), row-major: addr = {char[6:0], row[2:0]}, bit x = column x from the left.
module font5x7_rom (input wire clk, input wire [9:0] addr, output reg [7:0] q);
    reg [7:0] rom [0:1023];
    initial $readmemh("font5x7.hex", rom);
    always @(posedge clk) q <= rom[addr];
endmodule

// Pause menu chime: two short triangle-wave notes with an exponential decay, up (E6, B6) on open, down on close.
// A cart seating adds a click (a short burst of filtered noise) before a softer rising pair; a cart leaving, a softer
// click and the falling pair. Runs on the audio clock; the inputs are toggles from the 74 MHz domain. Output is mixed
// into the game audio.
module ui_chime #(parameter CLK_HZ = 33_554_430) (
    input  wire        clk,
    input  wire        t_open, t_close,
    input  wire        t_ins, t_rem,
    output reg  signed [15:0] out = 0
);
localparam [23:0] INC_LO = 24'd660, INC_HI = 24'd988;    // 1319 Hz and 1976 Hz at 33.55 MHz with a 24-bit phase
reg [2:0] so = 0, sc = 0, si = 0, sr = 0;
reg [7:0]  ck_amp = 0;       // click envelope
reg [15:0] lfsr = 16'hACE1; reg signed [15:0] nz = 0;
reg [7:0]  peak = 255;       // the notes' starting level
reg [23:0] phase = 0, inc = 0;
reg [7:0]  amp = 0;
reg [13:0] div = 0;
reg [7:0]  ticks = 0;        // envelope ticks (488 us) into the current note
reg        note2 = 0, down = 0;
always @(posedge clk) begin
    so <= {so[1:0], t_open}; sc <= {sc[1:0], t_close}; si <= {si[1:0], t_ins}; sr <= {sr[1:0], t_rem};
    phase <= phase + inc;
    div <= div + 1'b1;
    if (div[8:0] == 0) begin                     // noise at 65 kHz, smoothed (one pole) so the click is a soft tick
        lfsr <= {lfsr[14:0], lfsr[15] ^ lfsr[13] ^ lfsr[12] ^ lfsr[10]};
        nz <= nz + (($signed({lfsr[15:4], 4'd0}) - nz) >>> 2);
    end
    if (so[2] != so[1] || sc[2] != sc[1] || si[2] != si[1] || sr[2] != sr[1]) begin
        down <= sc[2] != sc[1] || sr[2] != sr[1]; note2 <= 0; ticks <= 0;
        peak <= (si[2] != si[1]) ? 8'd190 : (sr[2] != sr[1]) ? 8'd140 : 8'd255;
        amp <= (si[2] != si[1]) ? 8'd190 : (sr[2] != sr[1]) ? 8'd140 : 8'd255;
        inc <= (sc[2] != sc[1] || sr[2] != sr[1]) ? INC_HI : INC_LO;
        if (si[2] != si[1]) ck_amp <= 8'd255; else if (sr[2] != sr[1]) ck_amp <= 8'd150;
    end else if (div == 0) begin
        if (ticks != 8'd255) ticks <= ticks + 1'b1;
        if (ck_amp != 0) ck_amp <= (ck_amp > 8'd4) ? ck_amp - (ck_amp >> 3) - 1'b1 : 8'd0;   // ~6 ms
        if (!note2 && ticks == 8'd90) begin      // second note after ~44 ms
            note2 <= 1; amp <= peak; inc <= down ? INC_LO : INC_HI;
        end else if (amp != 0)
            amp <= (amp > 8'd6) ? amp - (note2 ? (amp >> 5) : (amp >> 4)) - 1'b1 : 8'd0;   // ~8 / 15 ms decay
    end
end
// triangle, +-16383
wire [14:0] ramp = phase[22:8];
wire signed [15:0] tri_w = phase[23] ? $signed({1'b0, ~ramp}) - 16'sd16384 : $signed({1'b0, ramp}) - 16'sd16384;
wire signed [24:0] prod = tri_w * $signed({1'b0, amp});
wire signed [24:0] prod_s = prod >>> 10;
wire signed [24:0] ckp = nz * $signed({1'b0, ck_amp});
wire signed [16:0] sum = (amp == 0 ? 17'sd0 : $signed(prod_s[16:0])) + (ck_amp == 0 ? 17'sd0 : $signed(ckp[24:11]));
always @(posedge clk) out <= (sum > 17'sd32767) ? 16'sd32767 : (sum < -17'sd32768) ? -16'sd32768 : sum[15:0];   // peak about +-4k
endmodule
