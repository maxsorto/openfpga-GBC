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
    parameter [31:0] BRIDGE_SAVE  = 32'h20000000,
    parameter [31:0] BRIDGE_STATE = 32'h40000000,
    parameter [31:0] BRIDGE_PACK = 32'h30000000,
    parameter [31:0] BRIDGE_CART = 32'h10000000,
    parameter [31:0] PARAM_ADDR  = 32'hF3000000,
    parameter [31:0] LOG_ADDR    = 32'hF4000000
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

wire        ent_we = pack_wr && region == 0 && roff[15:12] == 0;

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

// hi-res layout map (title at 0, platform at 512): {valid, char[6:0], col[3:0]}
reg         map2_we = 0;
reg  [9:0]  map2_wa = 0;
reg  [11:0] map2_wd = 0;
wire [9:0]  map2_ra;
wire [15:0] map2_q;
picker_dpram #(.WIDTH(16), .ADDR(10)) map2_ram (
    .wclk(clk_74a), .we(map2_we), .waddr(map2_wa), .wdata({4'd0, map2_wd}),
    .rclk(clk_vid), .raddr(map2_ra), .q(map2_q));

// glyph widths for layout: 5x7 (pause panel) and the hi-res font
reg [3:0] wrom [0:127];
initial $readmemh("font5x7_width.hex", wrom);
reg [3:0] wrom2 [0:127];
initial $readmemh("font_hr_width.hex", wrom2);

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
        if (rep == 6'd24) begin rep <= 6'd16; step_l <= btn_left; step_r <= btn_right & ~btn_left; end
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
    S_H4 = 68, S_H5 = 69, S_H6 = 70, S_PROBE1 = 71, S_PROBE2 = 72, S_LOAD2 = 73, S_AF0 = 74, S_AF1 = 75, S_AF2 = 76, S_LG2 = 77,
    S_HDR_C = 78, S_LOADE = 79, S_LOADK = 80, S_AFRT = 81, S_HDR_D = 82, S_HDR_E = 83, S_HDR_F = 84, S_AF0W = 85;
localparam [1:0] PK_ROM = 0, PK_SAV = 1, PK_SUS = 2;
localparam [12:0] LOG_BYTES = 13'd4096;   // debug log file size

reg  [6:0]  state = S_BOOT, op_ret = S_BOOT;
reg  [1:0]  pk = 0;                // path struct kind for the open subroutine
reg  [31:0] pflags = 0, psize = 0;
reg  [15:0] op_slot = 0;
reg  [2:0]  oerr = 0, xerr = 0;    // result of the last open / transfer
reg  [27:0] tmr = 0;
reg  [27:0] mt = 0;                // time idle in the menu (log flush after 3 s)
reg         plog = 0, lflush_req = 0; // path struct = the log file's; a log flush is due
reg  [31:0] sv = 0, ssz = 0;       // latched save / state sizes of the running game
reg         cur_susp = 0, cur_known = 0;   // the selected game: has a suspend file / probed (cache: ks_ram)
reg         lerr = 0;              // last launch failed: show the error on line 2
reg  [7:0]  ecode = 0; reg [2:0] enum_ = 0;
reg         ovl = 0, psel = 0;     // pause overlay, selected option (0 Resume, 1 Home)
reg  [1:0]  pmsg = 0;              // 0 options, 1 saving, 2 error
reg         ago = 0, ago_dir = 0;  // start a cover flow step (pulse) and its direction
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
reg         line2 = 0;             // laying out line 2 (platform) instead of the title
reg  [7:0]  ch = 0;
reg  [3:0]  gw = 0, col = 0;
reg  [9:0]  mp = 0;
reg  [7:0]  title_w = 0;
reg  [8:0]  htw = 0, hsw = 0;      // hi-res title / platform widths
reg         lf = 0;                // layout pass for the hi-res font
reg  [10:0] af_g = 0;              // art loader: game being fetched
reg  [6:0]  af_ret = 0;            // art loader: state to return to
reg  [1:0]  art_try = 0;           // art loader: retries left for this game
reg         pend_l = 0, pend_r = 0, pend_a = 0;   // presses that arrived while the loader was busy
reg         dbg_art_err = 0, dbg_art_done = 0;   // diagnostics: a refused art read; the art stream finished
reg         is_gb = 0;
reg         gen = 0;               // toggles on every new selection (marquee restart)
wire        done_rise = target_dataslot_done & ~done_1;

wire [10:0] ebase = 11'd8;          // the selected game's entry is read to word 8 (after the 16 byte header)
wire [10:0] prev = (idx == 0) ? count - 1'b1 : idx - 1'b1;
wire [10:0] next = (idx == count - 1'b1) ? 11'd0 : idx + 1'b1;
// pack layout, computed once after the header is read (registered: these feed 32-bit offsets)
reg  [31:0] stride = 0;            // v7 pads every cover to 64 KB, v6 packs them at 45568 B
reg  [31:0] blob0 = 0, paths0 = 0, lay_t = 0;
reg  [31:0] art_mul = 0, art_off = 0;   // offset of af_g's cover, two cycles behind af_g
always @(posedge clk_74a) begin art_mul <= af_g * stride; art_off <= blob0 + art_mul; end
wire [12:0] pslot   = plog ? {1'b0, count, 1'b0} + {2'd0, count}            // after every game's: the log path
                           : {1'b0, idx, 1'b0} + {2'd0, idx} + {11'd0, pk};  // idx*3 + kind
wire [31:0] pstruct = paths0 + {11'd0, pslot, 8'd0};

// per game: suspend file known / present (bit 0 probed, bit 1 present), read at the selected game
reg         ks_we = 0; reg [1:0] ks_wd = 0; reg [10:0] ks_wa = 0;
wire [1:0]  ks_q;
picker_dpram #(.WIDTH(2), .ADDR(11)) ks_ram (
    .wclk(clk_74a), .we(ks_we), .waddr(ks_wa), .wdata(ks_wd),
    .rclk(clk_74a), .raddr(idx), .q(ks_q));

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
reg  [2:0]  tph = 0, tph_1 = 0, tph_2 = 0;
reg  [3:0]  cand = 0, cand_1 = 0, cand_2 = 0;    // prefetch candidate number
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
// the direction or the count changes: one add, then one wrap per cycle until in range (several for tiny libraries)
reg  [10:0] cgame [0:10];
reg  [3:0]  cj = 0; reg cph = 0; reg signed [12:0] cgv = 0;
reg  [10:0] c_idx = 11'h7FF, c_cnt = 0; reg c_left = 0;
reg         c_valid = 0;           // every candidate matches the current selection (one full pass since the change)
always @(posedge clk_74a) begin
    if (idx != c_idx || count != c_cnt || last_left != c_left) begin
        c_idx <= idx; c_cnt <= count; c_left <= last_left; cj <= 0; cph <= 0; c_valid <= 0;
    end else if (count != 0) begin
        if (!cph) begin cgv <= $signed({2'b0, idx}) + cand_off(cj, last_left); cph <= 1; end
        else if (cgv < 0) cgv <= cgv + $signed({2'b0, count});
        else if (cgv >= $signed({2'b0, count})) cgv <= cgv - $signed({2'b0, count});
        else begin
            cgame[cj] <= cgv[10:0]; cph <= 0;
            cj <= (cj == 4'd10) ? 4'd0 : cj + 1'b1;
            if (cj == 4'd10) c_valid <= 1;
        end
    end
end
wire [10:0] tg_now = (tph < 4) ? cg[tph[1:0]] : cgame[cand];
// a published miss is usable only for the selection it was computed for
wire        need_ok = need_v && !need_clr && c_valid && idx == c_idx && count == c_cnt && last_left == c_left;
always @(posedge clk_74a) begin
    tph <= tph + 1'b1;
    tag_ra <= tg_now[CB-1:0];
    tph_1 <= tph; tg_1 <= tg_now; cand_1 <= cand;
    tph_2 <= tph_1; tg_2 <= tg_1; cand_2 <= cand_1;
    if (tph >= 4) cand <= (cand == 4'd10) ? 4'd0 : cand + 1'b1;
    // tag_q holds the tag read two cycles ago (address registered, then the RAM's own register)
    if (tph_2 < 4) cl[tph_2[1:0]] <= tag_q[11] && tag_q[10:0] == tg_2;
    else if (count != 0) begin : sweep
        reg miss, keep; integer oj;
        // the slot's current game may only be evicted by a nearer candidate: if it is itself a candidate of equal or
        // higher priority (or on screen), leave it, so two games that share a slot never take turns evicting each other
        keep = tag_q[11] && (tag_q[10:0] == cg[0] || tag_q[10:0] == cg[1] || tag_q[10:0] == cg[2] || tag_q[10:0] == cg[3]);
        for (oj = 0; oj < 11; oj = oj + 1)
            if (oj <= cand_2 && tag_q[11] && tag_q[10:0] == cgame[oj]) keep = 1;
        miss = !(tag_q[11] && tag_q[10:0] == tg_2) && !keep;
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
wire [1:0] pmode = lerr ? 2'd3 : cur_susp ? 2'd2 : is_gb ? 2'd1 : 2'd0;

always @(posedge clk_74a) begin
    done_1                   <= target_dataslot_done;
    target_dataslot_read     <= 0;
    target_dataslot_openfile <= 0;
    target_dataslot_write    <= 0;
    picker_reset             <= 0;
    param_we                 <= 0;
    map_we                   <= 0;
    map2_we                  <= 0;
    ago                      <= 0;
    ks_we                    <= 0;
    tag_we                   <= 0;
    need_clr                 <= 0;
    ks_wa                    <= idx;
    if (step_l) pend_l <= 1;
    if (step_r) pend_r <= 1;
    if (press_a) pend_a <= 1;

    if (state == S_MENU && cont1_key[15:0] == 0) begin if (mt != 28'd250_000_000) mt <= mt + 1'b1; end else mt <= 0;

    case (state)
    S_BOOT: begin
        // hold the Game Boy explicitly: the power-up value of hold_gb is not reliable on hardware (seen low in build 14)
        menu_active <= 0; picker_download <= 0; game_loaded <= 0; idx <= 0; level_target <= 0; hold_gb <= 1;
        art_load <= 0;
        // clear the per-game suspend table and the cover cache tags (power-up contents are not trusted)
        if (clr != 12'd2048) begin
            ks_we <= 1; ks_wa <= clr[10:0]; ks_wd <= 2'b00;
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
    S_HDR_F: begin paths0 <= blob0 + lay_t; state <= S_LOAD; end

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
    S_LOAD: begin
        target_dataslot_id <= COVER_SLOT; target_dataslot_slotoffset <= ENT_OFF + {14'd0, idx, 7'd0};
        target_dataslot_bridgeaddr <= BRIDGE_PACK + 32'd16; target_dataslot_length <= 32'd128;
        target_dataslot_read <= 1; state <= S_LOADE;
    end
    S_LOADE: if (done_rise) state <= S_LOADK;       // ks_q follows idx; it is long valid by now
    S_LOADK: begin
        cur_known <= ks_q[0]; cur_susp <= ks_q[1];
        ent_raddr <= ebase + 11'd20;                // flags word, read by the layout as it starts (S_MAP_FETCH)
        if (!ks_q[0]) begin pk <= PK_SUS; pflags <= 0; psize <= 0; op_slot <= SUS_SLOT; op_ret <= S_PROBE1; state <= S_PREAD; end
        else state <= S_LOAD2;
    end
    S_PROBE1: if (oerr != 0) begin cur_known <= 1; cur_susp <= 0; ks_we <= 1; ks_wd <= 2'b01; state <= S_LOAD2; end
              else begin
                  target_dataslot_id <= SUS_SLOT; target_dataslot_slotoffset <= 0;
                  target_dataslot_bridgeaddr <= PARAM_ADDR + 32'h190; target_dataslot_length <= 32'd4;
                  target_dataslot_read <= 1; op_ret <= S_PROBE2; state <= S_XFER_W;
              end
    S_PROBE2: begin cur_known <= 1; cur_susp <= (xerr == 0); ks_we <= 1; ks_wd <= {xerr == 0, 1'b1}; state <= S_LOAD2; end
    S_LOAD2: begin
        k <= 0; line2 <= 0; lf <= 1; mp <= 10'd0; state <= S_MAP_FETCH;
        ent_raddr <= ebase + 11'd20; // flags byte (byte 40) for the platform line
    end
    S_MAP_FETCH: begin
        if (line2) state <= S_MAP_CHAR;
        else begin ent_raddr <= ebase + k[5:1]; state <= S_MAP_WAIT; end
        if (k == 0 && !line2 && lf) is_gb <= ent_q[0];   // ent_q holds word 20 here (set in S_LOAD2)
    end
    S_MAP_WAIT:  state <= S_MAP_WAIT2;
    S_MAP_WAIT2: state <= S_MAP_CHAR;
    S_MAP_CHAR: begin
        ch = line2 ? plat_char(pmode, ecode, enum_, k) : (k[0] ? ent_q[15:8] : ent_q[7:0]);
        gw = lf ? wrom2[ch[6:0]] : wrom[ch[6:0]];
        if (ch == 0 || k == (line2 ? 6'd14 : 6'd40) || (lf ? mp[8:0] >= 9'd500 : mp[7:0] >= 8'd250)) state <= S_MAP_DONE;
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
        if (lf && !line2) begin htw <= mp[8:0]; line2 <= 1; k <= 0; mp <= 10'd512; state <= S_MAP_FETCH; end
        else if (lf) begin hsw <= mp[8:0]; lf <= 0; line2 <= 0; k <= 0; mp <= 10'd0; state <= S_MAP_FETCH; end
        else begin
            title_w <= (mp[7:0] == 0) ? 8'd0 : mp[7:0] - 1'b1;   // drop the trailing gap
            if (!menu_active) lflush_req <= 1;          // fresh menu (boot or Home): write the log once it is idle
            if (!menu_active) begin pend_l <= 0; pend_r <= 0; pend_a <= 0; end   // presses from before the menu showed
            gen <= ~gen; menu_active <= 1; level_target <= 4'd8; tl_target <= 4'd8; state <= S_MENU;
        end
    end

    S_MENU: begin
        if (!menu_active) begin gen <= ~gen; menu_active <= 1; level_target <= 4'd8; tl_target <= 4'd8; end
        if (!anim && pend_r && count > 1) begin
            pend_r <= 0; idx <= next; last_left <= 0; lerr <= 0; ago <= 1; ago_dir <= 0; tl_target <= 0; state <= S_FADE;
        end else if (!anim && pend_l && count > 1) begin
            pend_l <= 0; idx <= prev; last_left <= 1; lerr <= 0; ago <= 1; ago_dir <= 1; tl_target <= 0; state <= S_FADE;
        end else if (pend_a) begin pend_a <= 0; pend_l <= 0; pend_r <= 0; level_target <= 0; state <= S_LAUNCH_FADE; end
        else if (lflush_req && mt == 28'd222_000_000) begin   // 3 s idle: write the debug log to its file
            lflush_req <= 0; plog <= 1; pflags <= 32'd3; psize <= {19'd0, LOG_BYTES}; op_slot <= LOG_SLOT; op_ret <= S_LG2; state <= S_PREAD;
        end else if (need_ok) begin af_ret <= S_MENU; state <= S_AF0; end
        if (count <= 1) begin pend_l <= 0; pend_r <= 0; end
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
    S_L11: begin cur_susp <= 0; ks_we <= 1; ks_wd <= 2'b01; state <= S_LRUN; end
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
              cur_susp <= 1; cur_known <= 1; ks_we <= 1; ks_wd <= 2'b11; ovl <= 0; pmsg <= 0; pause_gb <= 0; hold_gb <= 1;
              game_loaded <= 0; level_target <= 0; state <= S_LOAD;
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
    if (ago) begin anim <= 1; af <= 0; adir <= ago_dir; end
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

wire [8:0] e_now = anim ? ease(af) : 9'd256;
// cover k (0..3, left to right) parameters
reg  signed [10:0] cx [0:3]; reg [7:0] cs [0:3]; reg [4:0] cb [0:3]; reg cv [0:3];
integer ki;
always @(posedge clk_74a) begin   // registered: these cross into clk_vid
    for (ki = 0; ki < 4; ki = ki + 1) begin : covers
        reg signed [2:0] fs, ts; reg signed [11:0] dx; reg signed [9:0] ds, dbb; reg [4:0] bt;
        reg signed [22:0] px, ps, pb;     // full-width products (the sum's width would otherwise truncate them)
        // final slots: moving right -> -2,-1,0,1 ; moving left -> -1,0,1,2 ; at rest -> -1,0,1 (k = 3 unused)
        ts = (anim && !adir) ? ki - 2 : ki - 1;
        fs = !anim ? ts : (!adir ? ts + 1 : ts - 1);
        dx  = slot_x(ts) - slot_x(fs);
        ds  = $signed({2'b0, slot_s(ts)}) - $signed({2'b0, slot_s(fs)});
        dbb = $signed({5'b0, slot_b(ts)}) - $signed({5'b0, slot_b(fs)});
        px  = dx  * $signed({1'b0, e_now});
        ps  = ds  * $signed({1'b0, e_now});
        pb  = dbb * $signed({1'b0, e_now});
        bt  = $signed({1'b0, slot_b(fs)}) + (pb >>> 8);
        cx[ki] <= slot_x(fs) + (px >>> 8);
        cs[ki] <= $signed({1'b0, slot_s(fs)}) + (ps >>> 8);
        cb[ki] <= (bt > 5'd16) ? 5'd16 : bt;
        // idx + ts, wrapped: candidates 0..4 are offsets 0, +1, -1, +2, -2
        case (ts) 3'sd0: cg[ki] <= cgame[0]; 3'sd1: cg[ki] <= cgame[1]; -3'sd1: cg[ki] <= cgame[2];
                  3'sd2: cg[ki] <= cgame[3]; default: cg[ki] <= cgame[4]; endcase
        cv[ki] <= (count > 1 || ts == 0) && (anim || ki != 3) && bt != 0;
    end
end

// position bar thumb: idx * 120 / (count - 1), by restoring division over 18 cycles whenever idx changes
reg  [6:0]  pos_bar = 0;
reg  [17:0] dv_num = 0, dv_q = 0; reg [10:0] dv_rem = 0, dv_den = 0; reg [4:0] dv_n = 0; reg [10:0] dv_idx = 11'h7FF;
always @(posedge clk_74a) begin
    if (dv_n == 0) begin
        if (idx != dv_idx && count > 1) begin
            dv_idx <= idx; dv_num <= {idx, 7'd0} - {4'd0, idx, 3'd0};   // idx * 120
            dv_den <= count - 1'b1; dv_rem <= 0; dv_q <= 0; dv_n <= 5'd18;
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
reg [7:0] tw_s = 0; reg [8:0] htw_s = 0, hsw_s = 0; reg [2:0] gen_s = 0;
always @(posedge clk_vid) begin
    menu_s <= {menu_s[0], menu_active}; lvl_s <= level; tl_s <= tlevel; idx_s <= idx; cnt_s <= count; pos_s <= pos_bar;
    tw_s <= title_w; htw_s <= htw; hsw_s <= hsw; gen_s <= {gen_s[1:0], gen};
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
integer vk;
always @(posedge clk_vid) if (vc == 9'd3 && hc == 0)
    for (vk = 0; vk < 4; vk = vk + 1) begin vx[vk] <= cx[vk]; vs_[vk] <= cs[vk]; vb[vk] <= cb[vk]; vg[vk] <= cg[vk][CB-1:0]; vv[vk] <= cv[vk]; vl[vk] <= cl[vk]; end

// line requests to the SDRAM fetcher: at the start of each line, fetch the next one
reg       lreq_t = 0; reg [8:0] lreq_y = 0;
always @(posedge clk_vid) if (hc == 0) begin
    if (vc >= VOFF - 1 && vc < VOFF + HR_H - 1) begin lreq_y <= vc - (VOFF - 1); lreq_t <= ~lreq_t; end
end

// ---- stage 0: which cover owns this pixel
reg        hk_any; reg [1:0] hk; reg [7:0] hlx, hly, hS; reg [7:0] hR; reg [4:0] hB;
integer hi;
always @(*) begin
    hk_any = 0; hk = 0; hlx = 0; hly = 0; hS = 0; hR = 0; hB = 0;
    for (hi = 3; hi >= 0; hi = hi - 1) begin : own
        reg signed [11:0] lx, ly; reg [7:0] r;
        lx = $signed({3'b0, x}) - vx[hi];
        ly = $signed({3'b0, y}) - ($signed(12'sd96) - $signed({5'b0, vs_[hi][7:1]}));
        r  = (vs_[hi] * 7) >> 5;                                   // reflection rows
        if (vv[hi] && lx >= 0 && lx < $signed({4'b0, vs_[hi]}) && ly >= 0 && ly < $signed({4'b0, vs_[hi]}) + $signed({4'b0, r})) begin
            hk_any = 1; hk = hi[1:0]; hlx = lx[7:0]; hly = ly[7:0]; hS = vs_[hi]; hR = r; hB = vb[hi];
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
localparam [8:0] HT1Y = 200, HT2Y = 222, HDY = 256;
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
assign map2_ra = ht2_row ? {1'b1, ht2x} : {1'b0, ht1x[8:0]};
wire [3:0] htrow = ht2_row ? y - HT2Y : y - HT1Y;

// position: page dots (8 px pitch, 4x4 dots, the current one an 8x4 pill) up to 32 games, beyond that a 128 px
// track with an 8 px thumb
wire       hd_bar = cnt_s > 11'd32;
wire [8:0] hd_st = hd_bar ? 9'd96 : 9'd160 - {cnt_s[5:0], 2'b0};
wire [8:0] hdx = x - hd_st;
wire       hd_row = y >= HDY && y < HDY + 4 && x >= hd_st && hdx < (hd_bar ? 9'd128 : {cnt_s[5:0], 3'b0});
wire [8:0] hd_thx = hdx - {2'b0, pos_s};
wire       hd_cur = hd_row && (hd_bar ? (hdx >= {2'b0, pos_s} && hd_thx < 9'd8) : hdx[8:3] == idx_s[5:0]);
wire       hd_dim = hd_row && !hd_cur && (hd_bar ? (y == HDY + 1 || y == HDY + 2) : (hdx[2:0] >= 3'd2 && hdx[2:0] < 3'd6));
wire [2:0] hd_px  = hd_bar ? hd_thx[2:0] : hdx[2:0];
wire       hd_rnd = hd_row && (hd_px == 0 || hd_px == 7) && (y == HDY || y == HDY + 3);   // pill corners

// background: solid black
wire [7:0] hbg_r = 8'd0, hbg_g = 8'd0, hbg_b = 8'd0;

// line buffer: written by the fetcher (clk_sys), two lines, indexed by screen x
reg         lb_we = 0; reg [9:0] lb_wa = 0; reg [15:0] lb_wd = 0;
wire [15:0] lb_q;
picker_dpram #(.WIDTH(16), .ADDR(10)) line_buf (
    .wclk(clk_sys), .we(lb_we), .waddr(lb_wa), .wdata(lb_wd),
    .rclk(clk_vid), .raddr({y[0], x}), .q(lb_q));

// ---- stage 1
reg s1_act = 0, s1_c = 0, s1_cut = 0, s1_t1 = 0, s1_t2 = 0, s1_dc = 0, s1_dd = 0, s1_dr = 0;
reg [4:0] s1_a = 0, s1_b = 0; reg [3:0] s1_row = 0; reg [7:0] s1_br = 0, s1_bg = 0, s1_bb = 0;
reg [2:0] hde = 0, hhs = 0, hvs = 0;
always @(posedge clk_vid) begin
    s1_act <= h_act && v_act; s1_c <= hk_any; s1_cut <= h_cut; s1_a <= h_a; s1_b <= hB;
    s1_t1 <= ht1_ok; s1_t2 <= ht2_ok; s1_row <= htrow; s1_dc <= hd_cur && !hd_rnd; s1_dd <= hd_dim;
    s1_br <= hbg_r; s1_bg <= hbg_g; s1_bb <= hbg_b;
    hde <= {hde[1:0], h_act && v_act};
    hhs <= {hhs[1:0], hc == 9'd8};
    hvs <= {hvs[1:0], vc == 0 && hc == 9'd2};
end
wire [23:0] font2_q;
font_hr_rom font2 (.clk(clk_vid), .addr({map2_q[10:4], s1_row}), .q(font2_q));
// ---- stage 2
reg s2_act = 0, s2_c = 0, s2_cut = 0, s2_t1 = 0, s2_t2 = 0, s2_dc = 0, s2_dd = 0; reg [3:0] s2_col = 0; reg s2_gv = 0;
reg [4:0] s2_a = 0, s2_b = 0; reg [7:0] s2_br = 0, s2_bg = 0, s2_bb = 0; reg [15:0] s2_pix = 0;
always @(posedge clk_vid) begin
    s2_act <= s1_act; s2_c <= s1_c; s2_cut <= s1_cut; s2_a <= s1_a; s2_b <= s1_b; s2_t1 <= s1_t1; s2_t2 <= s1_t2;
    s2_dc <= s1_dc; s2_dd <= s1_dd; s2_br <= s1_br; s2_bg <= s1_bg; s2_bb <= s1_bb; s2_pix <= lb_q;
    s2_col <= map2_q[3:0]; s2_gv <= map2_q[11];
end
wire [1:0] galpha = (s2_gv && s2_col < 12) ? font2_q[{s2_col, 1'b0} +: 2] : 2'd0;
wire [7:0] pr = {s2_pix[15:11], s2_pix[15:13]}, pg = {s2_pix[10:5], s2_pix[10:9]}, pb = {s2_pix[4:0], s2_pix[4:2]};
wire [12:0] br_r = pr * s2_b, br_g = pg * s2_b, br_b = pb * s2_b;        // brightness 0..16
wire [7:0] cr2 = (s2_b == 16) ? pr : br_r[11:4], cg2 = (s2_b == 16) ? pg : br_g[11:4], cb2 = (s2_b == 16) ? pb : br_b[11:4];
wire [4:0] hlvl = {lvl_s, 1'b0};
wire [8:0] hwp  = s2_a * hlvl;
wire [4:0] hwc  = hwp[8:4];
wire [4:0] tal  = (galpha == 3) ? 5'd16 : (galpha == 2) ? 5'd11 : (galpha == 1) ? 5'd5 : 5'd0;
wire [8:0] tlp  = tal * {tl_s, 1'b0};
wire [8:0] tlq  = tlp[8:4] * hlvl;
wire [4:0] twc  = tlq[8:4];
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
    else if (s2_c && !s2_cut)  h_out = {mix(s2_br, cr2, hwc), mix(s2_bg, cg2, hwc), mix(s2_bb, cb2, hwc)};
    else if (s2_t1)       h_out = {mix(s2_br, 8'd246, twc), mix(s2_bg, 8'd246, twc), mix(s2_bb, 8'd250, twc)};
    else if (s2_t2)       h_out = {mix(s2_br, 8'd128, twc), mix(s2_bg, 8'd140, twc), mix(s2_bb, 8'd168, twc)};
    else if (s2_dc)       h_out = {mix(s2_br, 8'd232, hlvl), mix(s2_bg, 8'd236, hlvl), mix(s2_bb, 8'd244, hlvl)};
    else if (s2_dd)       h_out = {mix(s2_br, 8'd74, hlvl), mix(s2_bg, 8'd82, hlvl), mix(s2_bb, 8'd104, hlvl)};
    else                  h_out = {s2_br, s2_bg, s2_bb};
end
always @(posedge clk_vid) begin
    hr_de <= hde[1]; hr_hs <= hhs[1]; hr_vs <= hvs[1];
    hr_rgb <= s2_act ? h_out : 24'h0;
end

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
reg signed [10:0] fx [0:3]; reg [7:0] fs_ [0:3]; reg [CB-1:0] fg [0:3]; reg fv [0:3], fl [0:3];
reg [1:0]  fk = 0;          // cover being fetched
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
        if (lreq_y == 0) for (fi2 = 0; fi2 < 4; fi2 = fi2 + 1) begin fx[fi2] <= vx[fi2]; fs_[fi2] <= vs_[fi2]; fg[fi2] <= vg[fi2]; fv[fi2] <= vv[fi2]; fl[fi2] <= vl[fi2]; end
    end else case (fst)
    3'd1: begin : setup
        reg signed [11:0] ly, xs, xe; reg [7:0] S, r, row; reg [17:0] rowf;
        S  = fs_[fk]; r = (S * 7) >> 5;
        ly = $signed({3'b0, fy}) - ($signed(12'sd96) - $signed({5'b0, S[7:1]}));
        xs = (fx[fk] < 0) ? 12'sd0 : fx[fk];
        xe = (fx[fk] + $signed({4'b0, S}) > 12'sd320) ? 12'sd320 : fx[fk] + $signed({4'b0, S});
        if (!fv[fk] || ly < 0 || ly >= $signed({4'b0, S}) + $signed({4'b0, r}) || xs >= xe) begin
            if (fk == 3) fst <= 3'd4; else fk <= fk + 1'b1;
        end else begin
            row   = (ly < $signed({4'b0, S})) ? ly[7:0] : S - 1'b1 - (ly[7:0] - S);   // reflection mirrors
            fstep <= step_lut[S];
            rowf  = row * step_lut[S];
            fbase <= ART_WORD + ({{(24-CB){1'b0}}, fg[fk]} << 15) + ((S <= 80) ? 24'd16384 + rowf[15:8] * 24'd80 : {9'd0, rowf[15:8], 7'd0});
            facc  <= (xs - fx[fk]) * step_lut[S];
            fxc <= xs[8:0]; fxe <= xe[8:0];
            fst <= 3'd3;
        end
    end
    3'd3: if (tick && sd_own) begin
        // the address set at tick t is sampled at the next SDRAM sync and its data is captured at tick t + 2
        if (fpend2) begin lb_we <= 1; lb_wa <= {fy[0], fpx2}; lb_wd <= sd_q; end
        fpend2 <= fpend; fpx2 <= fpx;
        if (fxc < fxe && fl[fk]) begin
            sd_addr <= fbase + facc[17:8]; sd_oe <= 1; fpend <= 1; fpx <= fxc;
            fxc <= fxc + 1'b1; facc <= facc + fstep;
        end else begin
            fpend <= 0;
            if (fxc < fxe) begin                    // cover not in the cache yet: a flat tile, and the cycle is free
                lb_we <= 1; lb_wa <= {fy[0], fxc}; lb_wd <= PLACEHOLDER; fxc <= fxc + 1'b1;
            end else if (!fpend && !fpend2) begin   // drained
                if (fk == 3) fst <= 3'd4; else begin fk <= fk + 1'b1; fst <= 3'd1; end
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
reg  [6:0]  lg_st = S_BOOT;
reg  [23:0] dbg_a0 = 0, dbg_a = 0, lg_dbg = 0;
reg  [31:0] q_a0 = 0, q_a = 0;
reg  [8:0]  lg_wp = 9'd1;
reg  [15:0] lg_n = 0;
reg  [3:0]  qcnt = 0; reg q_pend = 0; reg menu_1 = 0;
reg         lg_we = 0; reg [63:0] lg_wd = 0;
wire [63:0] lg_q;
picker_dpram #(.WIDTH(64), .ADDR(9)) log_ram (
    .wclk(clk_74a), .we(lg_we), .waddr(lg_wp), .wdata(lg_wd),
    .rclk(clk_74a), .raddr(bridge_addr[11:3]), .q(lg_q));
reg  [11:0] lr_a = 0;
always @(posedge clk_74a) lr_a <= bridge_addr[11:0];
wire [31:0] log_word = (lr_a[11:3] == 0) ? (lr_a[2] ? {7'd0, lg_wp, lg_n} : "PLOG") : (lr_a[2] ? lg_q[31:0] : lg_q[63:32]);
always @(posedge clk_74a) if (bridge_rd) param_rd_data <= (bridge_addr[31:24] == LOG_ADDR[31:24]) ? log_word : param_q;
always @(posedge clk_74a) begin
    lg_time <= lg_time + 1'b1;
    dbg_a0 <= {dshow, dbg_art_done, dbg_art_err, hold_gb, menu_active, dbg}; dbg_a <= dbg_a0;
    q_a0 <= q_samp; q_a <= q_a0;
    menu_1 <= menu_active;
    if (menu_active & ~menu_1) qcnt <= 4'd8;                        // eight samples after each menu entry
    else if (frame_tick && menu_active && qcnt != 0) begin qcnt <= qcnt - 1'b1; q_pend <= 1; end
    lg_we <= 0;
    if (state != lg_st) begin
        lg_st <= state; lg_we <= 1;
        lg_wd <= {"S", lg_time[35:12], state, lg_st, target_dataslot_err, oerr, 1'b0, idx};
    end else if (dbg_a != lg_dbg) begin
        lg_dbg <= dbg_a; lg_we <= 1;
        lg_wd <= {"D", lg_time[35:12], 8'd0, dbg_a};
    end else if (q_pend) begin
        q_pend <= 0; lg_we <= 1;
        lg_wd <= {"Q", lg_time[35:12], q_a};
    end
    if (lg_we) begin lg_wp <= (lg_wp == 9'd511) ? 9'd1 : lg_wp + 1'b1; lg_n <= lg_n + 1'b1; end
end

endmodule

// hi-res menu font: Inter SemiBold 13 px (OFL), 2-bit antialiased, 12 px x 16 rows per glyph (tools/make_font.py)
module font_hr_rom (input wire clk, input wire [10:0] addr, output reg [23:0] q);
    reg [23:0] rom [0:2047];
    initial $readmemh("font_hr.hex", rom);
    always @(posedge clk) q <= rom[addr];
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
