// Smoke test for cover_picker: a fake APF host answers data slot reads by streaming bytes from a covers.bin image,
// answers 0x0192 open-file by checking the path struct, and reports what the FSM does.
`timescale 1ns/1ps
module tb;
  reg clk = 0; always #6.757 clk = ~clk;        // 74 MHz
  reg clk_vid = 0; always #16 clk_vid = ~clk_vid;
  reg [31:0] cont1_key = 0;
  reg core_ready = 0;
  // pack image loaded from the real covers.bin
  reg [7:0] pack [0:262143];
  integer pack_len;
  // loader-side writes (what data_loader would produce): 16-bit words, low byte first
  reg pack_wr = 0; reg [27:0] pack_addr = 0; reg [15:0] pack_data = 0;
  // target command handshake
  wire        t_read, t_open; wire [15:0] t_id; wire [31:0] t_off, t_bridge, t_len;
  reg         t_done = 0; reg [2:0] t_err = 0;
  // param struct reads
  reg bridge_rd = 0; reg [31:0] bridge_addr = 0; wire [31:0] param_rd;
  wire menu_active, picker_download, picker_reset, menu_on; wire [23:0] menu_rgb;
  reg de = 0, hs = 0, vs = 0;

  cover_picker dut (.clk_74a(clk), .enable(1'b1), .core_ready(core_ready), .cont1_key(cont1_key),
    .pack_wr(pack_wr), .pack_addr(pack_addr), .pack_data(pack_data),
    .target_dataslot_read(t_read), .target_dataslot_openfile(t_open), .target_dataslot_id(t_id),
    .target_dataslot_slotoffset(t_off), .target_dataslot_bridgeaddr(t_bridge), .target_dataslot_length(t_len),
    .target_dataslot_done(t_done), .target_dataslot_err(t_err),
    .bridge_rd(bridge_rd), .bridge_addr(bridge_addr), .bridge_endian_little(1'b0), .param_rd_data(param_rd),
    .menu_active(menu_active), .picker_download(picker_download), .picker_reset(picker_reset),
    .clk_vid(clk_vid), .de(de), .hs(hs), .vs(vs), .menu_rgb(menu_rgb), .menu_on(menu_on));

  // speed up the boot timer for simulation
  initial begin
    $readmemh("covers.hex", pack);
  end

  integer i, cart_bytes;
  reg [7:0] path [0:263]; reg [31:0] w;
  task host_serve_read; begin
      $display("[%0t] READ slot=%0d off=%0d bridge=%08x len=%0d", $time, t_id, t_off, t_bridge, t_len);
      if (t_id == 100) begin
        for (i = 0; i < t_len; i = i + 2) begin
          @(posedge clk); pack_wr <= 1; pack_addr <= t_bridge[27:0] + i;
          pack_data <= {pack[t_off + i + 1], pack[t_off + i]};
        end
        @(posedge clk); pack_wr <= 0;
      end else if (t_id == 1) begin
        cart_bytes = t_len;
      end
      repeat (4) @(posedge clk); t_err <= 0; t_done <= 1; repeat (3) @(posedge clk); t_done <= 0;
  end endtask
  task host_serve_open; begin
      // read the 0x108-byte struct through the bridge: 66 words at 0xF3000000
      for (i = 0; i < 66; i = i + 1) begin
        @(posedge clk); bridge_rd <= 1; bridge_addr <= 32'hF3000000 + i*4;
        @(posedge clk); bridge_rd <= 0; @(posedge clk); @(posedge clk);
        w = param_rd; path[i*4] = w[31:24]; path[i*4+1] = w[23:16]; path[i*4+2] = w[15:8]; path[i*4+3] = w[7:0];
      end
      $write("[%0t] OPEN slot=%0d path=\"", $time, t_id);
      for (i = 0; i < 80 && path[i] != 0; i = i + 1) $write("%c", path[i]);
      $display("\" flags=%02x%02x%02x%02x", path[256], path[257], path[258], path[259]);
      repeat (4) @(posedge clk); t_err <= 0; t_done <= 1; repeat (3) @(posedge clk); t_done <= 0;
  end endtask

  reg menu_active_1 = 0;
  // host responder
  always @(posedge clk) begin
    if (t_read) host_serve_read;
    if (t_open) host_serve_open;
  end
  always @(posedge clk) if (picker_reset) $display("[%0t] RESET pulse, cart bytes pulled = %0d", $time, cart_bytes);
  always @(posedge clk) if (menu_active !== menu_active_1) begin menu_active_1 = menu_active; $display("[%0t] menu_active=%0d idx=%0d count=%0d state=%0d", $time, menu_active, dut.idx, dut.count, dut.state); end


  initial begin
    force dut.boot_timer = 27'd36_999_990;  // skip most of the 0.5 s boot wait
    #100 core_ready = 1;
    #2000 release dut.boot_timer;
    wait (menu_active == 1); #500;
    $display("--- press RIGHT twice ---");
    cont1_key[3] = 1; #200 cont1_key[3] = 0; #2000; wait (dut.state == 8); #500;
    cont1_key[3] = 1; #200 cont1_key[3] = 0; #2000; wait (dut.state == 8); #500;
    $display("--- press LEFT ---");
    cont1_key[2] = 1; #200 cont1_key[2] = 0; #2000; wait (dut.state == 8); #500;
    $display("--- press A (idx should be 1 -> Pokemon - Cock 2) ---");
    cont1_key[4] = 1; #200 cont1_key[4] = 0;
    wait (picker_reset == 1); #2000;
    $display("final: menu_active=%0d state=%0d idx=%0d", menu_active, dut.state, dut.idx);
    $finish;
  end
  initial begin #20_000_000 $display("TIMEOUT state=%0d", dut.state); $finish; end
endmodule
