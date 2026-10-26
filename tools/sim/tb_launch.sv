// Renders the menu frame by frame (as the core would output it) to movie/f_NNN.ppm, pressing buttons on a schedule.
`timescale 1ns/1ps
module tb_movie;
  reg clk = 0; always #6.757 clk = ~clk;
  reg clk_vid = 0; always #16 clk_vid = ~clk_vid;
  reg [31:0] cont1_key = 0; reg core_ready = 0;
  reg [7:0] pack [0:262143];
  reg pack_wr = 0; reg [27:0] pack_addr = 0; reg [15:0] pack_data = 0;
  wire t_read, t_open; wire [15:0] t_id; wire [31:0] t_off, t_bridge, t_len;
  reg t_done = 0; reg [2:0] t_err = 0;
  wire [31:0] param_rd; wire menu_active, picker_download, picker_reset, menu_on; wire [23:0] menu_rgb;
  reg de = 0, hs = 0, vs = 0;
  cover_picker dut (.clk_74a(clk), .enable(1'b1), .core_ready(core_ready), .cont1_key(cont1_key),
    .pack_wr(pack_wr), .pack_addr(pack_addr), .pack_data(pack_data),
    .target_dataslot_read(t_read), .target_dataslot_openfile(t_open), .target_dataslot_id(t_id),
    .target_dataslot_slotoffset(t_off), .target_dataslot_bridgeaddr(t_bridge), .target_dataslot_length(t_len),
    .target_dataslot_done(t_done), .target_dataslot_err(t_err),
    .bridge_rd(1'b0), .bridge_addr(32'd0), .bridge_endian_little(1'b0), .param_rd_data(param_rd),
    .menu_active(menu_active), .picker_download(picker_download), .picker_reset(picker_reset),
    .clk_vid(clk_vid), .de(de), .hs(hs), .vs(vs), .menu_rgb(menu_rgb), .menu_on(menu_on));
  initial $readmemh("covers.hex", pack);
  integer i; reg rq = 0, oq = 0; reg [15:0] q_id; reg [31:0] q_off, q_br, q_len;
  always @(posedge clk) begin
    if (t_read) begin rq <= 1; q_id <= t_id; q_off <= t_off; q_br <= t_bridge; q_len <= t_len; end
    if (t_open) oq <= 1;
  end
  initial forever begin
    @(posedge clk);
    if (rq) begin
      if (q_id == 100) begin
        for (i = 0; i < q_len; i = i + 2) begin @(posedge clk); pack_wr <= 1; pack_addr <= q_br[27:0] + i; pack_data <= {pack[q_off+i+1], pack[q_off+i]}; end
        @(posedge clk); pack_wr <= 0;
      end
      rq <= 0; repeat (4) @(posedge clk); t_done <= 1; repeat (3) @(posedge clk); t_done <= 0;
    end else if (oq) begin
      oq <= 0; repeat (4) @(posedge clk); t_done <= 1; repeat (3) @(posedge clk); t_done <= 0;
    end
  end
  // button schedule (frame numbers): press for 2 frames
  integer frame = 0;
  always @(frame) begin
    cont1_key[3] = (frame >= 30 && frame < 32); // right, then held
    cont1_key[2] = 0; cont1_key[4] = (frame >= 50 && frame < 52);
  end
  integer x, y, f; reg cap = 0;
  initial begin
    force dut.boot_timer = 27'd36_999_990; #100 core_ready = 1; #2000 release dut.boot_timer;
    for (frame = 0; frame < `FRAMES; frame = frame + 1) begin
      @(posedge clk_vid); vs <= 1; @(posedge clk_vid); vs <= 0; repeat (4) @(posedge clk_vid);
      repeat (8) begin @(posedge clk_vid); hs <= 1; @(posedge clk_vid); hs <= 0; repeat (176) @(posedge clk_vid); end
      f = $fopen("/dev/null", "w"); $fwrite(f, "P6\n160 144\n255\n"); cap = 1;
      for (y = 0; y < 144; y = y + 1) begin
        @(posedge clk_vid); hs <= 1; @(posedge clk_vid); hs <= 0; repeat (8) @(posedge clk_vid);
        for (x = 0; x < 160; x = x + 1) begin @(posedge clk_vid); de <= 1; end
        @(posedge clk_vid); de <= 0; repeat (8) @(posedge clk_vid);
      end
      cap = 0; $fclose(f);
      if (frame % 5 == 0) $display("frame %0d state=%0d idx=%0d level=%0d", frame, dut.state, dut.idx, dut.level);
    end
    $finish;
  end
  always @(posedge clk_vid) if (de && cap) $fwrite(f, "%c%c%c", menu_rgb[23:16], menu_rgb[15:8], menu_rgb[7:0]);
endmodule
