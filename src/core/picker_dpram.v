// Simple dual-port RAM (write port on wclk, registered read port on rclk), instantiated explicitly as altsyncram so
// synthesis does not have to infer it. Used by the cover picker.
module picker_dpram #(parameter WIDTH = 16, parameter ADDR = 8, parameter DEPTH = (1 << ADDR), parameter INIT = "UNUSED") (
    input  wire             wclk, input wire we, input wire [ADDR-1:0] waddr, input wire [WIDTH-1:0] wdata,
    input  wire             rclk, input wire [ADDR-1:0] raddr, output wire [WIDTH-1:0] q
);
altsyncram #(
    .operation_mode("DUAL_PORT"), .width_a(WIDTH), .widthad_a(ADDR), .numwords_a(DEPTH),
    .width_b(WIDTH), .widthad_b(ADDR), .numwords_b(DEPTH),
    .address_reg_b("CLOCK1"), .outdata_reg_b("UNREGISTERED"), .rdcontrol_reg_b("CLOCK1"),
    .clock_enable_input_a("BYPASS"), .clock_enable_input_b("BYPASS"), .clock_enable_output_b("BYPASS"),
    .intended_device_family("Cyclone V"), .lpm_type("altsyncram"), .ram_block_type("M10K"),
    .power_up_uninitialized("FALSE"), .init_file(INIT), .read_during_write_mode_mixed_ports("DONT_CARE")
) ram (
    .clock0(wclk), .wren_a(we), .address_a(waddr), .data_a(wdata),
    .clock1(rclk), .address_b(raddr), .q_b(q),
    .aclr0(1'b0), .aclr1(1'b0), .addressstall_a(1'b0), .addressstall_b(1'b0), .byteena_a(1'b1), .byteena_b(1'b1),
    .clocken0(1'b1), .clocken1(1'b1), .clocken2(1'b1), .clocken3(1'b1), .data_b({WIDTH{1'b1}}), .eccstatus(),
    .q_a(), .rden_a(1'b1), .rden_b(1'b1), .wren_b(1'b0)
);
endmodule
