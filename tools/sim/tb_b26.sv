`timescale 1ns/1ps
// Build 26 (b26.hex from mk_vt_pack.py --b26: the fav pack plus CRT1 flag 16, the gear, REC1 [Dr. Mario, Kirby's
// Dream Land 2], recent.cfg and settings.cfg paths). Default: a card with neither file: the ring (Favorites, All,
// Settings, the empty slot, Recent), the settings and their file, a launch into Recent and recent.cfg, last used.
// -DSCEN_R: both files on the card (start in grid, opens on Recent, one launch since the sync). -DSCEN_N: no pack:
// the first run screen. Frames the test names land in b26/.

module tb_b26;
  reg clk = 0; always #6.757 clk = ~clk;          // 74.25 MHz
  reg clk_vid = 0; always #74.5 clk_vid = ~clk_vid; // 6.71 MHz
  reg clk_sys = 0; always #14.9 clk_sys = ~clk_sys; // 33.55 MHz
  reg [31:0] cont1_key = 0; reg core_ready = 0;
  reg [7:0] pack [0:2097151];
  initial $readmemh("b26.hex", pack);
  reg pack_wr = 0; reg [27:0] pack_addr = 0; reg [15:0] pack_data = 0;
  wire t_read, t_open, t_write; wire [15:0] t_id; wire [31:0] t_off, t_bridge, t_len;
  reg t_done = 0; reg [2:0] t_err = 0;
  reg b_rd = 0, b_wr = 0; reg [31:0] b_addr = 0, b_wdata = 0;
  wire [31:0] param_rd; wire hold_gb, menu_on, ovl_dim, art_load, sd_own, sd_oe, hr_mode, hr_de, hr_hs, hr_vs;
  wire [23:0] sd_addr, hr_rgb, menu_rgb; reg [15:0] sd_q = 0;
  wire sd_we; wire [15:0] sd_wd; reg art_wr = 0; reg [23:0] art_waddr = 0; reg [15:0] art_wdata = 0;
  reg sd_ce = 0; integer cdiv = 0;
  always @(posedge clk_sys) begin cdiv <= (cdiv + 1) % 4; sd_ce <= (cdiv == 0); end
  wire cprobe_req, cart_mode, snd_ins, snd_rem; reg cprobe_done = 0; reg [223:0] cart_hdr;
  cover_picker #(.CB(7)) dut (.clk_74a(clk), .enable(1'b1), .core_ready(core_ready), .cont1_key(cont1_key),
    .pack_wr(pack_wr), .pack_addr(pack_addr), .pack_data(pack_data),
    .target_dataslot_read(t_read), .target_dataslot_openfile(t_open), .target_dataslot_write(t_write),
    .target_dataslot_id(t_id), .target_dataslot_slotoffset(t_off), .target_dataslot_bridgeaddr(t_bridge),
    .target_dataslot_length(t_len), .target_dataslot_done(t_done), .target_dataslot_err(t_err),
    .bridge_rd(b_rd), .bridge_wr(b_wr), .bridge_wr_data(b_wdata), .bridge_addr(b_addr), .bridge_endian_little(1'b0),
    .param_rd_data(param_rd), .menu_active(), .hold_gb(hold_gb), .pause_gb(), .ss_start(), .ss_load(),
    .ss_start_ok(1'b0), .ss_load_ok(1'b0), .sav_bytes(32'd0), .ss_bytes(32'd0), .ovl_dim(ovl_dim),
    .snd_open(), .snd_close(), .snd_ins(snd_ins), .snd_rem(snd_rem), .picker_download(), .picker_reset(),
    .clk_sys(clk_sys), .sd_ce(sd_ce), .sd_own(sd_own), .sd_addr(sd_addr), .sd_oe(sd_oe), .sd_we(sd_we), .sd_wd(sd_wd), .sd_q(sd_q),
    .art_wr(art_wr), .art_waddr(art_waddr), .art_wdata(art_wdata), .dbg(16'hA5C3), .cart_notify(32'h01000000), .cart_play(1'b0), .cart_mode(cart_mode), .cprobe_req(cprobe_req), .cprobe_done(cprobe_done), .cart_hdr(cart_hdr),
    .art_load(art_load), .hr_mode(hr_mode), .hr_de(hr_de), .hr_hs(hr_hs), .hr_vs(hr_vs), .hr_rgb(hr_rgb),
    .clk_vid(clk_vid), .de(1'b0), .hs(1'b0), .vs(1'b0), .menu_rgb(menu_rgb), .menu_on(menu_on));

  // SDRAM: 8M words; address sampled one clk_sys after sync, data out three cycles later (like the controller)
  reg [15:0] mem [0:8388607];
  reg [23:0] la; reg lo, lw; reg [15:0] lwd; integer ph = 9; integer nwr = 0, nrd = 0, collide = 0;
  always @(posedge clk_sys) begin
    if (sd_ce) ph <= 0; else if (ph < 9) ph <= ph + 1;
    if (ph == 0) begin la <= sd_addr; lo <= sd_oe; lw <= sd_we; lwd <= sd_wd; if (sd_oe && sd_we) collide = collide + 1; end
    if (ph == 1 && lw) begin mem[la[22:0]] <= lwd; nwr = nwr + 1; end
    if (ph == 2 && lo && !lw) begin sd_q <= mem[la[22:0]]; nrd = nrd + 1; end
  end

  // host: serve slot 100 reads into the pack regions, the 0xF3 param struct, and the art path into "SDRAM"
  // a cart whose header is valid (checksum 0xE7 over zero bytes) with global checksum 12 34: game 5 in the table
  function [223:0] mkhdr(input [87:0] t, input integer n, input [7:0] cgb);
    reg [7:0] x; integer k; reg [223:0] h;
    begin
      h = 0;
      for (k = 0; k < n; k = k + 1) h[k*8 +: 8] = t[(n - 1 - k) * 8 +: 8];
      h[15*8 +: 8] = cgb;
      x = 0; for (k = 0; k < 25; k = k + 1) x = x - h[k*8 +: 8] - 8'd1;
      h[25*8 +: 8] = x; h[26*8 +: 8] = 8'hAB; h[27*8 +: 8] = 8'hCD;
      mkhdr = h;
    end
  endfunction
  reg [223:0] crystal, klax;
  initial begin
    crystal = mkhdr("PM_CRYSTAL", 10, 8'h00);
    klax = mkhdr("KLAX", 4, 8'h00);
`ifdef SCEN_C
  `define SCEN_B
`endif
`ifdef SCEN_B
    cart_hdr = {224{1'b1}};
`else
    cart_hdr = crystal;
`endif
  end
  always @(cprobe_req) if ($time > 0) begin #5000; cprobe_done = ~cprobe_done; $display("cart header read requested"); end
  integer i; reg rq = 0, oq = 0, wq = 0; reg [15:0] o_id = 0, w_id = 0; reg [31:0] w_br = 0, w_len = 0; reg [31:0] wcap [0:68]; integer nwrites = 0; reg [31:0] w_off = 0;
  reg [223:0] crl_rec = 0; reg [63:0] crl_head = 0; integer crl_recs = 0, crl_heads = 0; reg [15:0] q_id; reg [31:0] q_off, q_br, q_len;
  always @(posedge clk) begin
    if (t_read) begin rq <= 1; q_id <= t_id; q_off <= t_off; q_br <= t_bridge; q_len <= t_len; end
    if (t_open) begin oq <= 1; o_id <= t_id; end
    if (t_write) begin wq <= 1; w_br <= t_bridge; w_len <= t_len; w_id <= t_id; w_off <= t_off; end
  end
  initial forever begin
    @(posedge clk);
    if (rq || oq || wq) t_done <= 0;
    if (rq) begin
      rq <= 0;
      if (q_id == 100 && q_br[31:28] == 4'h1) begin
        if (!art_load) $display("ERROR: art arrived without art_load");
        $display("art read: pack offset %0d -> word %h (%0d bytes) at %0t", q_off, (q_br[27:0]) >> 1, q_len, $time);
        for (i = 0; i < q_len; i = i + 2) begin
          repeat (19) @(posedge clk_sys);
          art_waddr <= (q_br[27:0] + i) >> 1; art_wdata <= {pack[q_off+i+1], pack[q_off+i]}; art_wr <= 1;
          @(posedge clk_sys); art_wr <= 0;
        end
        repeat (20) @(posedge clk);
      end else if (q_id == 100 && q_br[31:24] == 8'hF3) begin
        for (i = 0; i < q_len; i = i + 4) begin @(posedge clk); b_wr <= 1; b_addr <= q_br + i;
          b_wdata <= {pack[q_off+i], pack[q_off+i+1], pack[q_off+i+2], pack[q_off+i+3]}; end
        @(posedge clk); b_wr <= 0;
      end else if (q_id == 104 || q_id == 105) begin
        for (i = 0; i < q_len; i = i + 2) begin @(posedge clk); pack_wr <= 1; pack_addr <= q_br[27:0] + i; pack_data <= 16'h0000; end
        @(posedge clk); pack_wr <= 0;
      end else if (q_id == 106 || q_id == 107) begin             // recent.cfg / settings.cfg from the "card"
        for (i = 0; i < q_len; i = i + 2) begin @(posedge clk); pack_wr <= 1; pack_addr <= q_br[27:0] + i;
          pack_data <= (q_id == 106) ? {rcf[i + 1], rcf[i]} : {scf[(i + 1) % 16], scf[i % 16]}; end
        @(posedge clk); pack_wr <= 0;
        $display("READ slot %0d (%0d bytes)", q_id, q_len);
      end else if (q_id == 100) begin
        for (i = 0; i < q_len; i = i + 2) begin @(posedge clk); pack_wr <= 1; pack_addr <= q_br[27:0] + i; pack_data <= {pack[q_off+i+1], pack[q_off+i]}; end
        @(posedge clk); pack_wr <= 0;
      end
      repeat (4) @(posedge clk); t_err <= (q_id == 102) ? 3'd5 : (q_id == 100 && nopack_host) ? 3'd4 : 3'd0; t_done <= 1;
    end else if (oq) begin
      oq <= 0; repeat (40) @(posedge clk);
      if (o_id == 16'd106 && dut.pflags[1:0] == 2'd3) rc_exists = 1;   // created
      if (o_id == 16'd107 && dut.pflags[1:0] == 2'd3) sc_exists = 1;
      t_err <= (o_id == 16'd104 || o_id == 16'd105 || (o_id == 16'd106 && rc_exists) || (o_id == 16'd107 && sc_exists)) ? 3'd0 : 3'd3;
      t_done <= 1;
    end
    else if (wq) begin
      wq <= 0; nwrites = nwrites + 1;
      for (i = 0; i <= 68; i = i + 1) begin                   // read up to 68 words; data for read i arrives with read i + 1
        if (i * 4 <= w_len) begin
          @(posedge clk); b_addr <= w_br + i * 4; b_rd <= 1; @(posedge clk); b_rd <= 0;
          repeat (3) @(posedge clk); if (i > 0) wcap[i - 1] = param_rd;
        end
      end
      $display("WRITE slot %0d off %0d len %0d: %h %h %h %h %h %h %h %h", w_id, w_off, w_len, wcap[0], wcap[1], wcap[2], wcap[3], wcap[4], wcap[5], wcap[6], wcap[7]);
      if (w_id == 104) begin fav_head = wcap[0]; fav_writes = fav_writes + 1; end
      if (w_id == 106) begin rc_writes = rc_writes + 1; for (i = 0; i < 68; i = i + 1) {rcf[4*i], rcf[4*i+1], rcf[4*i+2], rcf[4*i+3]} = wcap[i]; end
      if (w_id == 107) begin sc_writes = sc_writes + 1; for (i = 0; i < 4; i = i + 1) {scf[4*i], scf[4*i+1], scf[4*i+2], scf[4*i+3]} = wcap[i]; end
      repeat (4) @(posedge clk); t_err <= 3'd0; t_done <= 1;
    end
  end

  // the files on the "card"
  reg [7:0] rcf [0:271]; reg [7:0] scf [0:15]; reg rc_exists = 0, sc_exists = 0; integer rc_writes = 0, sc_writes = 0;
  reg nopack_host = 0;
  integer fi;
  initial begin
    for (fi = 0; fi < 272; fi = fi + 1) rcf[fi] = 0;
    for (fi = 0; fi < 16; fi = fi + 1) scf[fi] = 0;
`ifdef SCEN_R
    // settings.cfg: start in grid, opens on Recent, legend on, sounds on
    {scf[0], scf[1], scf[2], scf[3]} = "SET1"; scf[4] = 1; scf[8] = 1; scf[9] = 1; scf[10] = 1; scf[11] = 1; sc_exists = 1;
    // recent.cfg: one launch since the sync, Pokemon Gold (A to Z position 9)
    {rcf[0], rcf[1], rcf[2], rcf[3]} = "RCN1"; rcf[4] = 1; rcf[6] = 1;
    {rcf[19], rcf[18], rcf[17], rcf[16]} = 32'hDEADBEEF; rcf[20] = 9; rc_exists = 1;
`endif
`ifdef SCEN_N
    nopack_host = 1;
`endif
  end

  // capture hi-res frames on request
  integer f = 0, frame = 0; reg cap = 0; reg [8*40-1:0] snap_name; reg snap_req = 0;
  always @(posedge clk_vid) begin
    if (hr_vs) begin
      if (cap) begin $fclose(f); cap = 0; $display("SNAP %0s", snap_name); end
      if (snap_req) begin snap_req = 0; cap = 1; f = $fopen(snap_name, "wb"); $fwrite(f, "P6\n320 288\n255\n"); end
      frame = frame + 1;
    end
    if (hr_de && cap) $fwrite(f, "%c%c%c", hr_rgb[23:16], hr_rgb[15:8], hr_rgb[7:0]);
  end
  task snap(input [8*40-1:0] n); begin snap_name = n; snap_req = 1; repeat (3) @(posedge hr_vs); end endtask
  integer errs = 0, fav_writes = 0; reg [31:0] fav_head = 0;
  task frames(input integer n); begin repeat (n) @(posedge hr_vs); end endtask
  task tap(input integer b); begin cont1_key[b] = 1; frames(2); cont1_key[b] = 0; frames(12); end endtask
  task settle; begin wait (!dut.vt_busy && !dut.anim && !dut.g_anim && dut.state == 23); frames(6); end endtask
  task show(input [8*14-1:0] what);
    $display("%s: st %0d fav %0d rec %0d set %0d cart %0d/%0d idx %0d rlo %0d rcount %0d cg1 %0d pmode %0d label %0d/%0d row %0d legctx %0d next %0d rn %0d rs %0d %0d %0d",
             what, dut.state, dut.fav_mode, dut.rec_mode, dut.set_view, dut.cart_view, dut.cart_none, dut.idx, dut.rlo, dut.rcount, dut.cg[1],
             dut.pmode, dut.lbl_on, dut.lbl_sec, dut.st_row, dut.leg_ctx, dut.leg_next, dut.rn, dut.rs_ram.m[0], dut.rs_ram.m[1], dut.rs_ram.m[2]);
  endtask
  task want(input c); begin if (!c) begin errs = errs + 1; $display("  FAIL"); end end endtask
  integer w;
  initial begin
    cart_hdr = {224{1'b1}};
    force dut.boot_timer = 27'd36_999_990; #100 core_ready = 1; #2000 release dut.boot_timer;
`ifdef SCEN_N
    wait (dut.state == 23 && dut.level == 8); frames(4);
    show("first run");   want(dut.nopack && dut.menu_active && dut.pmode == 4 && !dut.cv[0] && !dut.cv[1] && !dut.cv[2] && dut.leg_ctx == 10);
    snap("b26/firstrun.ppm");
    tap(4); wait (dut.state == 39); frames(2);
    $display("after A: state %0d hold_gb %0d menu_active %0d", dut.state, hold_gb, dut.menu_active); want(dut.state == 39 && !hold_gb && !dut.menu_active);
`elsif SCEN_R
    wait (dut.state == 23 && dut.level == 8); frames(30);
    show("boot R");      $display("  grid %0d pref %0d rl_n %0d st %0d/%0d", dut.grid, dut.grid_pref, dut.rl_n, dut.st_start, dut.st_open);
    want(dut.rec_mode && dut.idx == 0 && dut.rn == 3 && dut.rs_ram.m[0] == 9 && dut.rs_ram.m[1] == 6 && dut.rs_ram.m[2] == 4 && dut.rl_n == 1);
    want(dut.cg[1] == 9 && dut.grid && dut.grid_pref);
    snap("b26/boot_recent_grid.ppm");
    tap(3); settle;                                      // the grid: the next cell is Dr. Mario
    show("grid right");  want(dut.idx == 1 && dut.cg[1] == 6);
    tap(4); wait (rc_writes == 1); frames(4);            // launch it: recent.cfg keeps Gold, then Dr. Mario
    $display("recent.cfg n %0d: %h az %0d, %h az %0d", rcf[6], {rcf[19], rcf[18], rcf[17], rcf[16]}, rcf[20], {rcf[27], rcf[26], rcf[25], rcf[24]}, rcf[28]);
    want(rcf[6] == 2 && {rcf[19], rcf[18], rcf[17], rcf[16]} == 32'hDEADBEEF && rcf[20] == 9 && rcf[28] == 6 && dut.rs_ram.m[0] == 6 && dut.rs_ram.m[1] == 9);
`else
    wait (dut.state == 23 && dut.level == 8); frames(4);
    show("boot");        want(dut.fav_mode && dut.v26 && dut.st_ok && dut.rc_ok && dut.rn == 2 && dut.rs_ram.m[0] == 6 && dut.rs_ram.m[1] == 4);
    $display("  fl_ram 2016 %0d 2017 %0d gear %0d count %0d", dut.fl_ram.m[2016], dut.fl_ram.m[2017], dut.gear_g, dut.count);
    want(dut.fl_ram.m[2016] == 6 && dut.fl_ram.m[2017] == 4 && dut.gear_g == dut.count + 5);
    tap(14); settle;
    show("all");         want(!dut.fav_mode && !dut.rec_mode && !dut.set_view && dut.lbl_sec == 28);
    tap(14); settle;
    show("settings");    want(dut.set_view && dut.idx == dut.gear_g && dut.cg[1] == dut.gear_g && dut.pmode == 5 && dut.leg_ctx == 9 && dut.cl[1]);
    snap("b26/settings_start.ppm");
    tap(1); settle;
    show("row 1");       want(dut.st_row == 1);
    tap(3); settle;
    show("opens recent"); want(dut.st_open == 1 && dut.st_dirty);
    snap("b26/settings_opens.ppm");
    w = sc_writes; frames(80);                           // 1 s idle: settings.cfg
    $display("settings.cfg writes %0d: %h %h %h %h", sc_writes, {scf[0], scf[1], scf[2], scf[3]}, {scf[4], scf[5], scf[6], scf[7]}, {scf[8], scf[9], scf[10], scf[11]}, {scf[12], scf[13], scf[14], scf[15]});
    want(sc_writes == w + 1 && {scf[0], scf[1], scf[2], scf[3]} == "SET1" && scf[8] == 0 && scf[9] == 1 && scf[10] == 1 && scf[11] == 1 && !dut.st_dirty);
    tap(1); tap(3); settle;                              // row 2: legend off
    show("legend off");  want(dut.st_row == 2 && !dut.st_leg);
    snap("b26/settings_legend.ppm");
    tap(0); tap(0); tap(3); tap(3); settle;              // row 0: start in last used
    show("last used");   want(dut.st_row == 0 && dut.st_start == 2);
    tap(14); wait (!dut.vt_busy); settle;
    show("slot");        want(dut.cart_view && dut.cart_none && !dut.set_view);
    tap(14); wait (!dut.vt_busy); settle;
    show("recent");      want(dut.rec_mode && dut.idx == 0 && dut.rcount == 2 && dut.cg[1] == 6 && dut.lbl_sec == 30 && dut.leg_s == 0);
    snap("b26/recent.ppm");
    tap(3); settle;
    show("recent 1");    want(dut.idx == 1 && dut.cg[1] == 4);
    tap(14); settle; tap(14); settle;                    // Favorites, then All (where it was left: 3)
    show("all again");   want(!dut.fav_mode && !dut.rec_mode && dut.idx == 3);
    tap(3); tap(3); settle;
    show("all 5");       want(dut.idx == 5 && dut.cur_ap == 5);
    w = rc_writes;
    tap(4); wait (rc_writes == w + 1); frames(2);        // launch: to the front of Recent, and recent.cfg
    $display("launch: rn %0d rs %0d %0d %0d sel_g %0d; recent.cfg %h n %0d crc %h az %0d", dut.rn, dut.rs_ram.m[0], dut.rs_ram.m[1], dut.rs_ram.m[2], dut.sel_g,
             {rcf[0], rcf[1], rcf[2], rcf[3]}, rcf[6], {rcf[19], rcf[18], rcf[17], rcf[16]}, rcf[20]);
    want(dut.rn == 3 && dut.rs_ram.m[0] == 5 && dut.rs_ram.m[1] == 6 && dut.rs_ram.m[2] == 4 && dut.sel_g == 5 && {rcf[0], rcf[1], rcf[2], rcf[3]} == "RCN1" && rcf[6] == 1 && rcf[20] == 5);
    wait (dut.lerr); wait (dut.state == 23); frames(10);  // the test card has no ROM: the launch fails back to the menu
    show("after fail");  want(!dut.rec_mode && dut.idx == 5);
    tap(14); wait (!dut.vt_busy); settle; tap(14); wait (!dut.vt_busy); settle; tap(14); wait (!dut.vt_busy); settle;   // Settings, slot, Recent
    show("recent 2");    want(dut.rec_mode && dut.idx == 0 && dut.rcount == 3 && dut.cg[1] == 5);
    w = sc_writes;
    tap(7); settle;                                      // Y: the grid, and last used remembers it
    show("recent grid"); want(dut.grid && dut.st_last && dut.st_dirty);
    snap("b26/recent_grid.ppm");
    frames(80);
    $display("settings.cfg writes %0d last view %0d start %0d", sc_writes, scf[12], scf[8]); want(sc_writes == w + 1 && scf[12] == 1 && scf[8] == 2);
`endif
    $display("RESULT %s (%0d errors)", errs == 0 ? "PASS" : "FAIL", errs);
    $finish;
  end
endmodule
