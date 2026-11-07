// Type declarations for mcp/mexc-server.mjs (the implementation is plain ESM
// JavaScript and intentionally not part of the tsc program).

export interface MexcMcpServerHandle {
  port: number;
  close(): Promise<void>;
}

export interface MexcMcpServerOptions {
  port?: number;
  client?: unknown;
}

export declare function createMexcMcpServer(
  options?: MexcMcpServerOptions,
): unknown;

export declare function startMexcMcpServer(
  options?: MexcMcpServerOptions,
): Promise<MexcMcpServerHandle>;
