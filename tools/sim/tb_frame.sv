// Renders one 160x144 frame of the menu overlay to menu_frame.ppm after the picker has loaded cover 0.
`timescale 1ns/1ps
module tb_frame;
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
  integer i;
  always @(posedge clk) if (t_read) begin
    if (t_id == 100) begin
      for (i = 0; i < t_len; i = i + 2) begin @(posedge clk); pack_wr <= 1; pack_addr <= t_bridge[27:0] + i; pack_data <= {pack[t_off+i+1], pack[t_off+i]}; end
      @(posedge clk); pack_wr <= 0;
    end
    repeat (4) @(posedge clk); t_done <= 1; repeat (3) @(posedge clk); t_done <= 0;
  end
  // frame generator: vs pulse, then 144 lines of (hs pulse, 8 blank, 160 active, 8 blank)
  integer x, y, f; reg [23:0] px_rgb;
  initial begin
    force dut.boot_timer = 27'd36_999_990; #100 core_ready = 1; #2000 release dut.boot_timer;
    wait (menu_active == 1); #3000;
    f = $fopen("menu_frame.ppm", "w"); $fwrite(f, "P6\n160 144\n255\n");
    @(posedge clk_vid); vs <= 1; @(posedge clk_vid); vs <= 0; repeat (4) @(posedge clk_vid);
    // 16 blank lines after vsync, like the real timing
    repeat (16) begin @(posedge clk_vid); hs <= 1; @(posedge clk_vid); hs <= 0; repeat (176) @(posedge clk_vid); end
    for (y = 0; y < 144; y = y + 1) begin
      @(posedge clk_vid); hs <= 1; @(posedge clk_vid); hs <= 0; repeat (8) @(posedge clk_vid);
      for (x = 0; x < 160; x = x + 1) begin
        @(posedge clk_vid); de <= 1;
        // menu_rgb is registered: pixel x's colour appears 2 clocks after de for that pixel
      end
      @(posedge clk_vid); de <= 0; repeat (8) @(posedge clk_vid);
    end
    $fclose(f); $display("frame done"); $finish;
  end
  // capture: sample menu_rgb with the same 2-cycle lag the real output stage would see
  reg de_d1 = 0, de_d2 = 0, de_d3 = 0;
  always @(posedge clk_vid) begin de_d1 <= de; de_d2 <= de_d1; de_d3 <= de_d2; if (de && f) $fwrite(f, "%c%c%c", menu_rgb[23:16], menu_rgb[15:8], menu_rgb[7:0]); end
  initial begin #400_000_000 $display("TIMEOUT"); $finish; end
endmodule
