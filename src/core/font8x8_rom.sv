// 8x8 ASCII font ROM (1024 x 8), initialised from font8x8.hex (dhepper/font8x8, public domain).
// addr = {char[6:0], row[2:0]}; row bit 0 is the leftmost pixel.
module font8x8_rom (input wire clk, input wire [9:0] addr, output reg [7:0] q);
  reg [7:0] rom [0:1023];
  initial $readmemh("font8x8.hex", rom);
  always @(posedge clk) q <= rom[addr];
endmodule
