// Host model for launch / pause / Home (suspend) / resume: serves 0x0180 reads, 0x0184 writes and 0x0192 opens
// from a fake file system, reading the 0x0192 struct over the bridge with APF's one-transaction read lag.
`timescale 1ns/1ps
module tb_shots;
  reg clk = 0; always #6.757 clk = ~clk;
  reg clk_vid = 0; always #16 clk_vid = ~clk_vid;
  reg [31:0] cont1_key = 0; reg core_ready = 0;
  reg [7:0] pack [0:65535];
  reg pack_wr = 0; reg [27:0] pack_addr = 0; reg [15:0] pack_data = 0;
  wire t_read, t_open, t_write; wire [15:0] t_id; wire [31:0] t_off, t_bridge, t_len;
  reg t_done = 0; reg [2:0] t_err = 0;
  reg b_rd = 0, b_wr = 0; reg [31:0] b_addr = 0, b_wdata = 0;
  wire [31:0] param_rd; wire picker_download, picker_reset, menu_on, hold_gb, pause_gb, ss_start, ss_load, ovl_dim;
  wire [23:0] menu_rgb;
  reg ss_start_ok = 0, ss_load_ok = 0;
  reg de = 0, hs = 0, vs = 0;
  cover_picker dut (.clk_74a(clk), .enable(1'b1), .core_ready(core_ready), .cont1_key(cont1_key),
    .pack_wr(pack_wr), .pack_addr(pack_addr), .pack_data(pack_data),
    .target_dataslot_read(t_read), .target_dataslot_openfile(t_open), .target_dataslot_write(t_write),
    .target_dataslot_id(t_id), .target_dataslot_slotoffset(t_off), .target_dataslot_bridgeaddr(t_bridge),
    .target_dataslot_length(t_len), .target_dataslot_done(t_done), .target_dataslot_err(t_err),
    .bridge_rd(b_rd), .bridge_wr(b_wr), .bridge_wr_data(b_wdata), .bridge_addr(b_addr), .bridge_endian_little(1'b0),
    .param_rd_data(param_rd), .menu_active(), .hold_gb(hold_gb), .pause_gb(pause_gb), .ss_start(ss_start),
    .ss_load(ss_load), .ss_start_ok(ss_start_ok), .ss_load_ok(ss_load_ok), .sav_bytes(32'd32784),
    .ss_bytes(32'd82752), .ovl_dim(ovl_dim), .picker_download(picker_download), .picker_reset(picker_reset),
    .clk_vid(clk_vid), .de(de), .hs(hs), .vs(vs), .menu_rgb(menu_rgb), .menu_on(menu_on));
  initial $readmemh("covers5.hex", pack);

  // fake card: up to 8 files
  reg [8*80-1:0] fname [0:7]; integer fsize [0:7]; integer nf = 0;
  reg [8*80-1:0] slotfile [0:127];   // which file each slot points at
  function integer ffind(input [8*80-1:0] n); integer j; begin ffind = -1; for (j = 0; j < nf; j = j + 1) if (fname[j] == n) ffind = j; end endfunction
  task fadd(input [8*80-1:0] n, input integer sz); begin fname[nf] = n; fsize[nf] = sz; nf = nf + 1; end endtask

  reg [7:0] pbytes [0:263];
  integer i, w, fi, nlen; reg [8*80-1:0] path; reg [31:0] flags, size, word;
  reg rq = 0, oq = 0, wq = 0; reg [15:0] q_id; reg [31:0] q_off, q_br, q_len;
  always @(posedge clk) begin
    if (t_read)  begin rq <= 1; q_id <= t_id; q_off <= t_off; q_br <= t_bridge; q_len <= t_len; end
    if (t_write) begin wq <= 1; q_id <= t_id; q_off <= t_off; q_br <= t_bridge; q_len <= t_len; end
    if (t_open)  begin oq <= 1; q_id <= t_id; end
  end
  task finish_op(input [2:0] e); begin repeat (4) @(posedge clk); t_err <= e; t_done <= 1; end endtask
  task bridge_read_word(input [31:0] a, output [31:0] d); begin
    @(posedge clk); b_addr <= a; repeat (4) @(posedge clk); d = param_rd; b_rd <= 1; @(posedge clk); b_rd <= 0; repeat (2) @(posedge clk);
  end endtask
  initial forever begin
    @(posedge clk);
    if (rq || wq || oq) t_done <= 0;
    if (rq) begin
      rq <= 0;
      if (q_id == 100) begin
        if (q_br[31:24] == 8'hF3) begin
          for (i = 0; i < q_len; i = i + 4) begin
            @(posedge clk); b_wr <= 1; b_addr <= q_br + i; b_wdata <= {pack[q_off+i], pack[q_off+i+1], pack[q_off+i+2], pack[q_off+i+3]};
          end
          @(posedge clk); b_wr <= 0;
        end else begin
          for (i = 0; i < q_len; i = i + 2) begin @(posedge clk); pack_wr <= 1; pack_addr <= q_br[27:0] + i; pack_data <= {pack[q_off+i+1], pack[q_off+i]}; end
          @(posedge clk); pack_wr <= 0;
        end
        finish_op(0);
      end else begin
        fi = ffind(slotfile[q_id]);
        $display("%0t  READ  slot %0d len %0d -> %h   file '%0s' size %0d", $time, q_id, q_len, q_br, slotfile[q_id], (fi >= 0) ? fsize[fi] : -1);
        finish_op((fi < 0 || q_off + q_len > fsize[fi]) ? 3'd5 : 3'd0);
      end
    end else if (wq) begin
      wq <= 0; fi = ffind(slotfile[q_id]);
      $display("%0t  WRITE slot %0d len %0d <- %h   file '%0s'", $time, q_id, q_len, q_br, slotfile[q_id]);
      if (fi >= 0 && q_off + q_len > fsize[fi]) fsize[fi] = q_off + q_len;
      finish_op(fi < 0 ? 3'd5 : 3'd0);
    end else if (oq) begin
      oq <= 0;
      // the host reads the struct: word k's data arrives on transaction k+1
      bridge_read_word(32'hF3000000, word);
      for (w = 0; w < 66; w = w + 1) begin
        bridge_read_word(32'hF3000000 + 4 * (w + 1), word);
        if (w < 64) begin pbytes[4*w] = word[31:24]; pbytes[4*w+1] = word[23:16]; pbytes[4*w+2] = word[15:8]; pbytes[4*w+3] = word[7:0]; end
        if (w == 64) flags = word; if (w == 65) size = word;
      end
      path = 0; nlen = 0; while (nlen < 80 && pbytes[nlen] != 0) begin path = {path[8*79-1:0], pbytes[nlen]}; nlen = nlen + 1; end
      fi = ffind(path);
      if (fi < 0 && flags[0]) begin fadd(path, 0); fi = nf - 1; end
      if (fi >= 0 && flags[1]) fsize[fi] = size;
      $display("%0t  OPEN  slot %0d '%0s' flags %0d size %0d -> %0d", $time, q_id, path, flags, size,
               fi < 0 ? 3 : (ffind(path) == nf - 1 && flags[0] && fsize[fi] == size) ? 1 : 0);
      if (fi >= 0) slotfile[q_id] = path;
      finish_op(fi < 0 ? 3'd3 : 3'd0);
    end
  end
  // save state handshake model
  always @(posedge ss_start) begin ss_start_ok <= 0; #3000 ss_start_ok <= 1; end
  always @(posedge ss_load)  begin ss_load_ok  <= 0; #3000 ss_load_ok  <= 1; end
  // skip the long waits
  initial forever begin
    @(posedge clk);
    if ((dut.state == 56 || dut.state == 50) && dut.tmr == 100) begin
      force dut.tmr = (dut.state == 56) ? 28'd10_999_990 : 28'd73_990; @(posedge clk); #1 release dut.tmr;
    end
  end
  reg [6:0] last_state = 0;
  always @(posedge clk) if (dut.state != last_state) begin last_state <= dut.state;
    if (dut.state >= 23) $display("%0t state %0d  hold=%0d pause=%0d ovl=%0d susp=%b lerr=%0d", $time, dut.state, hold_gb, pause_gb, dut.ovl, dut.susp[7:0], dut.lerr); end

  task press(input integer bit_); begin cont1_key[bit_] = 1; repeat (3) frame_(); cont1_key[bit_] = 0; repeat (3) frame_(); end endtask
  integer x, y, f; reg cap = 0; reg [8*64-1:0] shot = 0;
  task frame_; begin
    @(posedge clk_vid); vs <= 1; @(posedge clk_vid); vs <= 0;
    if (shot != 0) begin f = $fopen(shot, "wb"); $fwrite(f, "P6\n160 144\n255\n"); cap = 1; end
    for (y = 0; y < 144; y = y + 1) begin
      @(posedge clk_vid); hs <= 1; @(posedge clk_vid); hs <= 0; repeat (6) @(posedge clk_vid);
      for (x = 0; x < 160; x = x + 1) begin @(posedge clk_vid); de <= 1; end
      @(posedge clk_vid); de <= 0; repeat (6) @(posedge clk_vid);
    end
    if (shot != 0) begin cap = 0; $fclose(f); shot = 0; end
  end endtask
  // gray checker "game" picture under the overlay
  always @(posedge clk_vid) if (de && cap) begin
    if (menu_on) $fwrite(f, "%c%c%c", menu_rgb[23:16], menu_rgb[15:8], menu_rgb[7:0]);
    else if (ovl_dim) $fwrite(f, "%c%c%c", 8'd40, 8'd60, 8'd50);
    else $fwrite(f, "%c%c%c", 8'd120, 8'd180, 8'd150);
  end
  initial begin
    fadd("/Assets/gbc/common/Gex - Enter the Gecko.gbc", 1048576);
    fadd("/Saves/gbc/common/Gex - Enter the Gecko.sav", 32784);
    force dut.boot_timer = 27'd36_999_990; #100 core_ready = 1; #2000 release dut.boot_timer;
    repeat (40) frame_(); shot = "s_menu0.ppm"; frame_();
    press(3); repeat (30) frame_(); shot = "s_menu1.ppm"; frame_();
    press(3); repeat (30) frame_(); shot = "s_menu2.ppm"; frame_();
    press(3); repeat (30) frame_(); shot = "s_menu3.ppm"; frame_();
    press(3); repeat (30) frame_(); shot = "s_menu4.ppm"; frame_();
    press(3); repeat (30) frame_(); shot = "s_menu5.ppm"; frame_();
    press(3); repeat (30) frame_(); shot = "s_menu6.ppm"; frame_();
    press(3); repeat (30) frame_(); shot = "s_menu7.ppm"; frame_();
    press(3); repeat (8) frame_(); shot = "s_fade.ppm"; frame_();
    $finish;
  end
endmodule
