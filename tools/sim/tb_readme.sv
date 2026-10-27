// Streaming covers: pack v7 with 12 games and an 8-slot cache (CB = 3). Boot, hold right through the library so
// slots are evicted and refilled, then step left. Art words reach the menu's FIFO the way the cart loader delivers
// them (one word every 20 clk_sys). Frames go to st/f_NNN.ppm.
`timescale 1ns/1ps
module tb_readme;
  reg clk = 0; always #6.757 clk = ~clk;          // 74.25 MHz
  reg clk_vid = 0; always #74.5 clk_vid = ~clk_vid; // 6.71 MHz
  reg clk_sys = 0; always #14.9 clk_sys = ~clk_sys; // 33.55 MHz
  reg [31:0] cont1_key = 0; reg core_ready = 0;
  reg [7:0] pack [0:1048575];
  initial $readmemh("readme7.hex", pack);
  reg pack_wr = 0; reg [27:0] pack_addr = 0; reg [15:0] pack_data = 0;
  wire t_read, t_open, t_write; wire [15:0] t_id; wire [31:0] t_off, t_bridge, t_len;
  reg t_done = 0; reg [2:0] t_err = 0;
  reg b_rd = 0, b_wr = 0; reg [31:0] b_addr = 0, b_wdata = 0;
  wire [31:0] param_rd; wire hold_gb, menu_on, ovl_dim, art_load, sd_own, sd_oe, hr_mode, hr_de, hr_hs, hr_vs;
  wire [23:0] sd_addr, hr_rgb, menu_rgb; reg [15:0] sd_q = 0;
  wire sd_we; wire [15:0] sd_wd; reg art_wr = 0; reg [23:0] art_waddr = 0; reg [15:0] art_wdata = 0;
  reg sd_ce = 0; integer cdiv = 0;
  always @(posedge clk_sys) begin cdiv <= (cdiv + 1) % 4; sd_ce <= (cdiv == 0); end
  cover_picker #(.CB(3)) dut (.clk_74a(clk), .enable(1'b1), .core_ready(core_ready), .cont1_key(cont1_key),
    .pack_wr(pack_wr), .pack_addr(pack_addr), .pack_data(pack_data),
    .target_dataslot_read(t_read), .target_dataslot_openfile(t_open), .target_dataslot_write(t_write),
    .target_dataslot_id(t_id), .target_dataslot_slotoffset(t_off), .target_dataslot_bridgeaddr(t_bridge),
    .target_dataslot_length(t_len), .target_dataslot_done(t_done), .target_dataslot_err(t_err),
    .bridge_rd(b_rd), .bridge_wr(b_wr), .bridge_wr_data(b_wdata), .bridge_addr(b_addr), .bridge_endian_little(1'b0),
    .param_rd_data(param_rd), .menu_active(), .hold_gb(hold_gb), .pause_gb(), .ss_start(), .ss_load(),
    .ss_start_ok(1'b0), .ss_load_ok(1'b0), .sav_bytes(32'd0), .ss_bytes(32'd0), .ovl_dim(ovl_dim),
    .snd_open(), .snd_close(), .picker_download(), .picker_reset(),
    .clk_sys(clk_sys), .sd_ce(sd_ce), .sd_own(sd_own), .sd_addr(sd_addr), .sd_oe(sd_oe), .sd_we(sd_we), .sd_wd(sd_wd), .sd_q(sd_q),
    .art_wr(art_wr), .art_waddr(art_waddr), .art_wdata(art_wdata), .dbg(16'hA5C3),
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
  integer i; reg rq = 0, oq = 0; reg [15:0] q_id; reg [31:0] q_off, q_br, q_len;
  always @(posedge clk) begin
    if (t_read) begin rq <= 1; q_id <= t_id; q_off <= t_off; q_br <= t_bridge; q_len <= t_len; end
    if (t_open) oq <= 1;
  end
  initial forever begin
    @(posedge clk);
    if (rq || oq) t_done <= 0;
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
      end else if (q_id == 100) begin
        for (i = 0; i < q_len; i = i + 2) begin @(posedge clk); pack_wr <= 1; pack_addr <= q_br[27:0] + i; pack_data <= {pack[q_off+i+1], pack[q_off+i]}; end
        @(posedge clk); pack_wr <= 0;
      end
      repeat (4) @(posedge clk); t_err <= (q_id == 102) ? 3'd5 : 3'd0; t_done <= 1;
    end else if (oq) begin oq <= 0; repeat (40) @(posedge clk); t_err <= 3'd3; t_done <= 1; end   // no .sus files
  end

  // capture hi-res frames
  integer f = 0, fx = 0, fy = 0, frame = 0; reg cap = 0; reg hde_1 = 0;
  reg [8*32-1:0] fn;
  always @(posedge clk_vid) begin
    hde_1 <= hr_de;
    if (hr_vs) begin
      if (cap) $fclose(f);
      cap = (frame >= `FIRST);
      if (cap) begin $sformat(fn, "rd/f_%03d.ppm", frame); f = $fopen(fn, "wb"); $fwrite(f, "P6\n320 288\n255\n"); end
      frame = frame + 1; fy = 0;
      $display("frame %0d state %0d idx %0d anim %0d af %0d e %0d lvl %0d tl %0d | vx %0d %0d %0d %0d vs %0d %0d %0d %0d vv %0d%0d%0d%0d vg %0d %0d %0d %0d cl %0d%0d%0d%0d need %0d/%0d", frame, dut.state, dut.idx, dut.anim, dut.af, dut.e_now, dut.level, dut.tlevel,
        dut.vx[0], dut.vx[1], dut.vx[2], dut.vx[3], dut.vs_[0], dut.vs_[1], dut.vs_[2], dut.vs_[3], dut.vv[0], dut.vv[1], dut.vv[2], dut.vv[3], dut.vg[0], dut.vg[1], dut.vg[2], dut.vg[3], dut.cl[0], dut.cl[1], dut.cl[2], dut.cl[3], dut.need_v, dut.need_g);
    end
    if (dut.hc == 40 + 156 + 2 && dut.vc == 6 + 92 && frame < 14)
      $display("probe pix %h b %0d a %0d lvl %0d hwc %0d out %h c %0d cut %0d", dut.s2_pix, dut.s2_b, dut.s2_a, dut.lvl_s, dut.hwc, dut.h_out, dut.s2_c, dut.s2_cut);
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
  initial begin
    force dut.boot_timer = 27'd36_999_990; #100 core_ready = 1; #2000 release dut.boot_timer;
    wait (dut.state == 23 && dut.level == 8);
    repeat (12) @(posedge hr_vs);
    $display("=== settled at idx %0d", dut.idx); check_cache;
    $display("=== hold right");
    cont1_key[3] = 1; repeat (66) @(posedge hr_vs); cont1_key[3] = 0;
    repeat (24) @(posedge hr_vs);
    $display("=== settled at idx %0d", dut.idx); check_cache;
    $display("=== left");
    cont1_key[2] = 1; repeat (2) @(posedge hr_vs); cont1_key[2] = 0;
    repeat (20) @(posedge hr_vs);
    $display("=== settled at idx %0d", dut.idx); check_cache;
    $display("sdram writes %0d reads %0d read+write collisions %0d fifo wp %0d rp %0d", nwr, nrd, collide, dut.ff_wp, dut.ff_rp);
    $display("RESULT %s (%0d errors)", errors == 0 ? "PASS" : "FAIL", errors);
    $finish;
  end
endmodule
