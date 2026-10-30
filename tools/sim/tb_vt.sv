// Cartridge transitions. vt.hex (mk_vt_pack.py): 8 real covers, the CRT1 block with the default cartridge images,
// a carts.cfg path. Scenario A (default): boot with a known cart (title match on game 5): it drops in onto an empty
// screen and seats (ring, shine, bloom, insert sound). Scenario B (-DSCEN_B): boot with no cart, step right, insert a
// cart the pack doesn't know: the list is pushed out, the gray default image drops in with the header title, carts.cfg
// gets the record; then pull it: the list comes back at the same place. Frames go to vt_a/ or vt_b/f_NNN.ppm.
`timescale 1ns/1ps
module tb_vt;
  reg clk = 0; always #6.757 clk = ~clk;          // 74.25 MHz
  reg clk_vid = 0; always #74.5 clk_vid = ~clk_vid; // 6.71 MHz
  reg clk_sys = 0; always #14.9 clk_sys = ~clk_sys; // 33.55 MHz
  reg [31:0] cont1_key = 0; reg core_ready = 0;
  reg [7:0] pack [0:1048575];
  initial $readmemh("vt.hex", pack);
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
`ifdef SCEN_D
  `define SCEN_B
`endif
`ifdef SCEN_E
  `define SCEN_B
`endif
`ifdef SCEN_B
    cart_hdr = {224{1'b1}};
`else
    cart_hdr = crystal;
`endif
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
`ifdef SCEN_D
      if (cap) begin $sformat(fn, "vt_d/f_%03d.ppm", frame); f = $fopen(fn, "wb"); $fwrite(f, "P6\n320 288\n255\n"); end
`elsif SCEN_C
      if (cap) begin $sformat(fn, "vt_c/f_%03d.ppm", frame); f = $fopen(fn, "wb"); $fwrite(f, "P6\n320 288\n255\n"); end
`elsif SCEN_B
      if (cap) begin $sformat(fn, "vt_b/f_%03d.ppm", frame); f = $fopen(fn, "wb"); $fwrite(f, "P6\n320 288\n255\n"); end
`else
      if (cap) begin $sformat(fn, "vt_a/f_%03d.ppm", frame); f = $fopen(fn, "wb"); $fwrite(f, "P6\n320 288\n255\n"); end
`endif
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
  initial begin
    force dut.boot_timer = 27'd36_999_990; #100 core_ready = 1; #2000 release dut.boot_timer;
`ifndef SCEN_B
    wait (dut.vt_busy); sins0 = snd_ins;
    $display("A: cart found %0d unk %0d idx %0d view %0d", dut.cart_found, dut.cart_unk, dut.idx, dut.cart_view);
    if (!dut.cart_view || dut.cart_unk || dut.idx != 5) errs = errs + 1;
    wait (!dut.vt_busy); frames(40);
    $display("A: rest glow %0d (want %0d) acc %h vy1 %0d snd_ins toggled %0d tl %0d", dut.glow, dut.GLOW_REST, dut.glow_acc, dut.cy[1], snd_ins != sins0, dut.tlevel);
    if (dut.glow < 80 || dut.glow > 95 || dut.glow_acc != 16'h7D3F || dut.cy[1] != 0 || snd_ins == sins0 || dut.tlevel != 8) errs = errs + 1;
`else
    wait (dut.state == 23 && dut.level == 8); frames(2);
    cont1_key[3] = 1; frames(2); cont1_key[3] = 0; frames(12);
    $display("B: list idx %0d (want 1)", dut.idx); if (dut.idx != 1) errs = errs + 1;
`ifdef SCEN_E
    // A on a seated cart boots it in physical cartridge mode
    cart_hdr = crystal; probe_now; wait (dut.vt_busy); wait (!dut.vt_busy); frames(4);
    $display("E: view %0d idx %0d state %0d busy %0d", dut.cart_view, dut.idx, dut.state, dut.vt_busy);
    cont1_key[4] = 1; frames(2); cont1_key[4] = 0; frames(20);
    $display("E: after A: state %0d (120 = S_CRUN) cart_mode %0d hold_gb %0d menu %0d level %0d", dut.state, cart_mode, hold_gb, dut.menu_active, dut.level);
    if (dut.state != 120 || !cart_mode || hold_gb || dut.menu_active) errs = errs + 1;
    $display("RESULT %s (%0d errors)", errs == 0 ? "PASS" : "FAIL", errs); $finish;
`endif
`ifdef SCEN_D
    // the SMB Deluxe header as a Pocket read it through shorted D6/D7 contacts (from a real carts.cfg)
    cart_hdr = 224'hca3c2d02330102051b003130c0c5d9c8c1d8d5ccc5c420cfc9d2c1cd; probe_now;
    wait (dut.vt_busy); wait (!dut.vt_busy); frames(4);
    $display("D: misread: unk %0d bad %0d idx %0d title width %0d carts.cfg writes %0d", dut.cart_unk, dut.cart_bad, dut.idx, dut.htw, crl_recs);
    if (!dut.cart_unk || !dut.cart_bad || crl_recs != 0 || dut.htw == 0) errs = errs + 1;
    // idle in the menu: the log is written after 3 s even though the live cart check runs every second
    force dut.mt = 28'd221_000_000; @(posedge clk); release dut.mt; frames(40);
    $display("D: log writes %0d", log_writes); if (log_writes == 0) errs = errs + 1;
    $display("RESULT %s (%0d errors)", errs == 0 ? "PASS" : "FAIL", errs); $finish;
`endif
`ifdef SCEN_C
    cart_hdr = crystal; sins0 = snd_ins; probe_now;          // a known cart pushing the list (README animation)
    wait (dut.vt_busy); wait (!dut.vt_busy); frames(40);
    cart_hdr = {224{1'b1}}; probe_now; wait (dut.vt_busy); wait (!dut.vt_busy); frames(20);
    $display("RESULT PASS (0 errors)"); $finish;
`endif
    cart_hdr = klax; sins0 = snd_ins; probe_now;
    wait (dut.vt_busy);
    $display("B: unknown cart: unk %0d type %0d idx %0d (want %0d) lidx %0d", dut.cart_unk, dut.cart_type, dut.idx, dut.count, dut.lidx);
    if (!dut.cart_unk || dut.idx != dut.count || dut.lidx != 1) errs = errs + 1;
    wait (!dut.vt_busy); frames(8);
    $display("B: carts.cfg record writes %0d header writes %0d head %h", crl_recs, crl_heads, crl_head);
    $display("B: record %h", crl_rec);
    $display("B: header  %h", {klax[0 +: 8], klax[8 +: 8], klax[16 +: 8], klax[24 +: 8]});
    if (crl_recs != 1 || crl_heads != 1 || crl_head != 64'h43524C3101000100) errs = errs + 1;
    if (crl_rec[223:192] != {klax[0 +: 8], klax[8 +: 8], klax[16 +: 8], klax[24 +: 8]}) errs = errs + 1;
    $display("B: rest glow %0d acc %h key %0d title width %0d snd_ins toggled %0d", dut.glow, dut.glow_acc, dut.ck[1], dut.htw, snd_ins != sins0);
    if (dut.glow_acc != 16'hA59F || !dut.ck[1] || snd_ins == sins0) errs = errs + 1;
    $fflush();
    // pull it out: back to the list where we were
    srem0 = snd_rem; cart_hdr = {224{1'b1}}; probe_now;
    wait (dut.vt_busy); wait (!dut.vt_busy); frames(2);
    $display("B: removed: view %0d idx %0d label %0d/%0d glow %0d snd_rem toggled %0d", dut.cart_view, dut.idx, dut.lbl_on, dut.lbl_sec, dut.glow, snd_rem != srem0);
    if (dut.cart_view || dut.idx != 1 || dut.lbl_sec != 29 || dut.glow != 0 || snd_rem == srem0) errs = errs + 1;
    // the same cart again: logged once per session
    cart_hdr = klax; probe_now; wait (dut.vt_busy); frames(3);
    $display("B: again: record writes %0d (want 1)", crl_recs); if (crl_recs != 1) errs = errs + 1;
`endif
    $display("RESULT %s (%0d errors)", errs == 0 ? "PASS" : "FAIL", errs);
    $finish;
  end
endmodule
