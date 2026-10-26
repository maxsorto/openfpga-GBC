module picker_dpram #(parameter WIDTH = 16, parameter ADDR = 8, parameter DEPTH = (1 << ADDR), parameter INIT = "UNUSED") (
    input wire wclk, input wire we, input wire [ADDR-1:0] waddr, input wire [WIDTH-1:0] wdata,
    input wire rclk, input wire [ADDR-1:0] raddr, output reg [WIDTH-1:0] q);
  reg [WIDTH-1:0] m [0:DEPTH-1];
  always @(posedge wclk) if (we) m[waddr] <= wdata;
  always @(posedge rclk) q <= m[raddr];
endmodule
