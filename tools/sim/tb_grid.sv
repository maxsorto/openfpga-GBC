// Grid view. grid.hex (mk_vt_pack.py --grid): 14 real covers, no favorites. Boot with no cart, Y into the grid,
// Right across a row end, Down into a scroll, Down past the last row (stops), Right wrapping the list (a far jump),
// Up at the top (stops), Down, R to the next letter, Y back to the flow. Frames go to grid/f_NNN.ppm; MARK lines
// name the rest frames cmp_grid.py checks against tools/grid_model.py. Also counts SDRAM reads per line.
`timescale 1ns/1ps
module tb_grid;
  reg clk = 0; always #6.757 clk = ~clk;          // 74.25 MHz
  reg clk_vid = 0; always #74.5 clk_vid = ~clk_vid; // 6.71 MHz
  reg clk_sys = 0; always #14.9 clk_sys = ~clk_sys; // 33.55 MHz
  reg [31:0] cont1_key = 0; reg core_ready = 0;
  reg [7:0] pack [0:2097151];
  initial $readmemh("grid.hex", pack);
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
  integer line_rd = 0, max_rd = 0; reg hs_1 = 0;
  always @(posedge clk_vid) begin hs_1 <= hr_hs; if (hr_hs && !hs_1) begin if (line_rd > max_rd) max_rd = line_rd; line_rd = 0; end end
  always @(posedge clk_sys) begin
    if (sd_ce) ph <= 0; else if (ph < 9) ph <= ph + 1;
    if (ph == 0) begin la <= sd_addr; lo <= sd_oe; lw <= sd_we; lwd <= sd_wd; if (sd_oe && sd_we) collide = collide + 1; end
    if (ph == 1 && lw) begin mem[la[22:0]] <= lwd; nwr = nwr + 1; end
    if (ph == 2 && lo && !lw) begin sd_q <= mem[la[22:0]]; nrd = nrd + 1; line_rd = line_rd + 1; end
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
    cart_hdr = {224{1'b1}};                      // no cartridge
  end
  always @(cprobe_req) if ($time > 0) begin #5000; cprobe_done = ~cprobe_done; $display("cart header read requested"); end
  integer i; reg rq = 0, oq = 0, wq = 0; reg [15:0] o_id = 0, w_id = 0; reg [31:0] w_br = 0, w_len = 0; reg [31:0] wcap [0:16]; integer nwrites = 0; reg [31:0] w_off = 0;
  reg [223:0] crl_rec = 0; reg [63:0] crl_head = 0; integer crl_recs = 0, crl_heads = 0, log_writes = 0; reg [15:0] q_id; reg [31:0] q_off, q_br, q_len;
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
      end else if (q_id == 100) begin
        for (i = 0; i < q_len; i = i + 2) begin @(posedge clk); pack_wr <= 1; pack_addr <= q_br[27:0] + i; pack_data <= {pack[q_off+i+1], pack[q_off+i]}; end
        @(posedge clk); pack_wr <= 0;
      end
      repeat (4) @(posedge clk); t_err <= (q_id == 102) ? 3'd5 : 3'd0; t_done <= 1;
    end else if (oq) begin oq <= 0; repeat (40) @(posedge clk); t_err <= (o_id == 16'd103 || o_id == 16'd104 || o_id == 16'd105) ? 3'd0 : 3'd3; t_done <= 1; end
    else if (wq) begin
      wq <= 0; nwrites = nwrites + 1;
      for (i = 0; i <= 16; i = i + 1) begin                   // read 16 words; data for read i arrives with read i + 1
        @(posedge clk); b_addr <= w_br + i * 4; b_rd <= 1; @(posedge clk); b_rd <= 0;
        repeat (3) @(posedge clk); if (i > 0) wcap[i - 1] = param_rd;
      end
      $display("WRITE slot %0d off %0d len %0d: %h %h %h %h %h %h %h %h", w_id, w_off, w_len, wcap[0], wcap[1], wcap[2], wcap[3], wcap[4], wcap[5], wcap[6], wcap[7]);
      if (w_id == 105 && w_off == 16) begin crl_rec = {wcap[0], wcap[1], wcap[2], wcap[3], wcap[4], wcap[5], wcap[6]}; crl_recs = crl_recs + 1; end
      if (w_id == 103) log_writes = log_writes + 1;
      if (w_id == 105 && w_off == 0) begin crl_head = {wcap[0], wcap[1]}; crl_heads = crl_heads + 1; end
      repeat (4) @(posedge clk); t_err <= 3'd0; t_done <= 1;
    end
  end

  // capture hi-res frames
  integer f = 0, fx = 0, fy = 0, frame = 0; reg cap = 0; reg hde_1 = 0;
  reg [8*32-1:0] fn;
  always @(posedge clk_vid) begin
    hde_1 <= hr_de;
    if (hr_vs) begin
      if (cap) $fclose(f);
      cap = (frame >= `FIRST);
      if (cap) begin $sformat(fn, "grid/f_%03d.ppm", frame); f = $fopen(fn, "wb"); $fwrite(f, "P6\n320 288\n255\n"); end
      frame = frame + 1; fy = 0;
      $display("frame %0d st %0d idx %0d lvl %0d tl %0d | vt %0d arm %0d dir %0d vf %0d | vy %0d %0d %0d %0d vv %0d%0d%0d%0d key %0d%0d cl %0d%0d%0d%0d | glow %0d acc %h rf %0d gf %0d snd %0d%0d",
        frame, dut.state, dut.idx, dut.level, dut.tlevel, dut.vt, dut.vt_arm, dut.vt_dir, dut.vf,
        dut.vy[0], dut.vy[1], dut.vy[2], dut.vy[3], dut.vv[0], dut.vv[1], dut.vv[2], dut.vv[3], dut.vkey[1], dut.vkey[3],
        dut.cl[0], dut.cl[1], dut.cl[2], dut.cl[3], dut.glow_v, dut.acc_v, dut.rf_v, dut.gf_v, snd_ins, snd_rem);
    end
    if (hr_de && cap) $fwrite(f, "%c%c%c", hr_rgb[23:16], hr_rgb[15:8], hr_rgb[7:0]);
  end
  integer errors = 0;
  // check that every visible cover's cache slot holds exactly that game's art from the pack
  task check_cache;
    integer k2, j, g, sl, bad; reg [31:0] blob0;
    begin
      blob0 = 528 + dut.count * 128;
      for (k2 = 0; k2 < 4; k2 = k2 + 1) if (dut.cv[k2] && dut.cl[k2]) begin
        g = dut.cg[k2]; sl = g % 8; bad = 0;
        for (j = 0; j < 22784; j = j + 1)
          if (mem[24'h400000 + sl * 24'h8000 + j] !== {pack[blob0 + g*65536 + 2*j + 1], pack[blob0 + g*65536 + 2*j]}) bad = bad + 1;
        $display("check: cover %0d game %0d slot %0d mismatched words %0d", k2, g, sl, bad);
        if (bad != 0) errors = errors + 1;
      end else if (dut.cv[k2]) $display("check: cover %0d game %0d not loaded yet", k2, dut.cg[k2]);
    end
  endtask
  task press(input integer bit_);
    begin cont1_key[bit_] = 1; repeat (2) @(posedge hr_vs); cont1_key[bit_] = 0; repeat (8) @(posedge hr_vs);
      $display("JUMP %s -> idx %0d label_on %0d sec %0d state %0d", bit_ == 0 ? "up  " : "down", dut.idx, dut.lbl_on, dut.lbl_sec, dut.state); end
  endtask
  integer errs = 0; integer sins0, srem0;
  task frames(input integer n); begin repeat (n) @(posedge hr_vs); end endtask
  task probe_now; begin force dut.rp_tmr = 28'd74_000_000; @(posedge clk); @(posedge clk); release dut.rp_tmr; end endtask
  task wait_vt; begin wait (dut.vt_busy); wait (!dut.vt_busy); end endtask
  integer dbgn = 0;
  always @(posedge clk) begin
    if (dut.state == 16 && dbgn < 80) begin dbgn = dbgn + 1; $display("MAPDONE frame %0d line2 %0d line3 %0d lonly %0d lf %0d mp %0d htw %0d hsw %0d lgw %0d is_gb %0d k %0d", frame, dut.line2, dut.line3, dut.lonly, dut.lf, dut.mp, dut.htw, dut.hsw, dut.lgw, dut.is_gb, dut.k); end
    if (dut.state == 127 && dbgn < 80) begin dbgn = dbgn + 1; $display("LB0 frame %0d lonly %0d", frame, dut.lonly); end
  end
  task settle; begin wait (!dut.g_anim && !dut.anim && dut.state == 23); frames(10); end endtask
  task key(input integer bit_); begin cont1_key[bit_] = 1; frames(2); cont1_key[bit_] = 0; frames(2); end endtask
  task show(input [8*16-1:0] what);
    begin $display("MARK %0s frame %0d idx %0d grid %0d top %0d pop %0d %0d %0d lat_y %0d skip %0d b %0d/%0d | legend lgw %0d key %h built %h lonly %0d line3 %0d",
                   what, frame, dut.idx, dut.grid, dut.g_top, dut.p_x, dut.p_y, dut.p_s, dut.lat_y, dut.lat_skip, dut.lat_b, dut.side_b,
                   dut.lgw, dut.leg_key, dut.leg_built, dut.lonly, dut.line3);
          $display("  lstr codes: %0d %0d %0d %0d %0d %0d %0d %0d %0d %0d %0d %0d  widths %0d %0d %0d %0d %0d %0d", dut.lstr_m[0], dut.lstr_m[1], dut.lstr_m[2], dut.lstr_m[3], dut.lstr_m[4], dut.lstr_m[5], dut.lstr_m[6], dut.lstr_m[7], dut.lstr_m[8], dut.lstr_m[9], dut.lstr_m[10], dut.lstr_m[11], dut.wrom3[dut.lstr_m[0]], dut.wrom3[dut.lstr_m[1]], dut.wrom3[dut.lstr_m[2]], dut.wrom3[dut.lstr_m[3]], dut.wrom3[dut.lstr_m[4]], dut.wrom3[dut.lstr_m[5]]); end
  endtask
  initial begin
    force dut.boot_timer = 27'd36_999_990; #100 core_ready = 1; #2000 release dut.boot_timer;
    wait (dut.state == 23 && dut.level == 8); frames(4);
    show("flow");
    if (dut.grid || dut.cx[1] != 96 || dut.cs[1] != 128) errs = errs + 1;
    key(7);                                                   // Y: into the grid
    wait (dut.g_morph); $display("morph in started at frame %0d", frame); wait (!dut.g_morph); settle;
    show("grid0");
    if (!dut.grid || dut.g_top != 0 || dut.p_x != 6 || dut.p_y != 4 || dut.p_s != 80 || dut.lat_b != 9 || dut.lat_skip != 0 || dut.cv[0] || dut.cv[2]) errs = errs + 1;
    key(3); settle; show("right1");                           // Right x3: cells 1, 2, 3
    key(3); settle; key(3); settle; show("right3");
    if (dut.idx != 3 || dut.p_x != 6 + 76 * 3 || dut.p_y != 4) errs = errs + 1;
    key(3); settle; show("right4");                           // into row 1 (inside the window)
    if (dut.idx != 4 || dut.g_top != 0 || dut.p_x != 6 || dut.p_y != 98) errs = errs + 1;
    key(1); wait (dut.g_scroll); $display("scroll started at frame %0d", frame); settle; show("down1");   // row 2: the rows scroll
    if (dut.idx != 8 || dut.g_top != 1 || dut.p_y != 98 || dut.lat_y != 0 || dut.g_up) errs = errs + 1;
    key(1); settle; show("down2");                            // row 3 (two cells): scroll again
    if (dut.idx != 12 || dut.g_top != 2 || dut.p_y != 98) errs = errs + 1;
    key(1); settle; show("down3");                            // past the end: nothing
    if (dut.idx != 12 || dut.g_top != 2) errs = errs + 1;
    key(3); settle; key(3); settle; show("wrap");             // 13, then wrap to 0: a far jump, no motion
    if (dut.idx != 0 || dut.g_top != 0 || dut.p_x != 6 || dut.p_y != 4) errs = errs + 1;
    key(0); settle; show("up0");                              // Up at the top: nothing
    if (dut.idx != 0) errs = errs + 1;
    key(1); settle; show("down4");                            // row 1, inside the window
    if (dut.idx != 4 || dut.g_top != 0 || dut.p_y != 98) errs = errs + 1;
    key(0); settle; show("up1");                              // back up
    if (dut.idx != 0 || dut.p_y != 4) errs = errs + 1;
    key(1); settle; key(1); settle; key(0); settle; show("upmove");     // down twice (the second scrolls), up: a move
    if (dut.idx != 4 || dut.g_top != 1 || dut.p_y != 4 || dut.lat_y != 0 || dut.g_up) errs = errs + 1;
    key(0); wait (dut.g_scroll); if (dut.g_sdn || !dut.g_up) errs = errs + 1; settle; show("scrollup");   // up past the top row: a scroll up
    if (dut.idx != 0 || dut.g_top != 0 || dut.p_y != 4 || dut.lat_y != 0 || dut.g_up) errs = errs + 1;
    key(1); settle;                                           // back to row 1 for the letter jump
    key(9); settle; show("letterR");                          // R from 4: the next letter's first game (P: 5)
    if (dut.idx != 5 || !dut.lbl_on) errs = errs + 1;
    key(8); settle; show("letterL");                          // L from 5: the previous letter (D: 3)
    if (dut.idx != 3 || !dut.lbl_on) errs = errs + 1;
    key(7); wait (dut.g_morph); wait (!dut.g_morph); settle; show("flow2");   // Y: back to the flow
    if (dut.grid || dut.grid_draw || dut.cx[1] != 96 || dut.cs[1] != 128 || !dut.cv[0] || !dut.cv[2]) errs = errs + 1;
    key(3); settle; show("flowstep");                         // the flow still steps
    if (dut.idx != 4 || dut.cx[1] != 96) errs = errs + 1;
    $display("SDRAM reads per line: max %0d (budget 468)", max_rd);
    if (max_rd > 440) errs = errs + 1;
    $display("RESULT %s (%0d errors)", errs == 0 ? "PASS" : "FAIL", errs);
    $finish;
  end
endmodule
