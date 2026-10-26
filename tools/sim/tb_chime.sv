`timescale 1ns/1ps
module tb_chime; reg clk=0; always #14.9 clk=~clk; reg o=0,c=0; wire signed [15:0] out;
ui_chime u(.clk(clk),.t_open(o),.t_close(c),.out(out)); integer f,n;
initial begin f=$fopen("chime.raw","wb"); #1000 o=1; for(n=0;n<12000*700;n=n+1) begin @(posedge clk); if(n%700==0) $fwrite(f,"%c%c",out[7:0],out[15:8]); end $fclose(f); $finish; end endmodule
