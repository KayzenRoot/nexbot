// Type declarations for mcp/mexc-api.mjs (the implementation is plain ESM
// JavaScript and intentionally not part of the tsc program).

export declare const MEXC_BASE_URL: string;
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const RECV_WINDOW_SECONDS: number;
export declare const KLINE_INTERVALS: readonly [
  'Min1',
  'Min5',
  'Min15',
  'Min30',
  'Hour1',
  'Hour4',
  'Hour8',
  'Day1',
];

export declare class MexcApiError extends Error {
  code: number | null;
  kind: 'mexc' | 'http' | 'timeout' | 'network' | 'config';
  constructor(
    message: string,
    options?: {
      code?: number | null;
      kind?: 'mexc' | 'http' | 'timeout' | 'network' | 'config';
    },
  );
}

export declare function encodeRequestParamValue(value: string | number): string;
export declare function buildRequestParamString(
  params?: Record<string, string | number>,
): string;
export declare function buildSignature(args: {
  accessKey: string;
  secretKey: string;
  reqTime: string | number;
  paramString?: string;
}): string;

export interface MexcTicker {
  symbol: string;
  lastPrice: number | null;
  change24h: number | null;
  change24hValue: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  turnover24h: number | null;
  indexPrice: number | null;
  fairPrice: number | null;
  fundingRate: number | null;
  timestamp: number | null;
}

export interface MexcCandle {
  time: number;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume: number;
}

export interface MexcOrderBook {
  symbol: string;
  bids: Array<{ price: number | null; volume: number | null }>;
  asks: Array<{ price: number | null; volume: number | null }>;
  timestamp: number | null;
}

export interface MexcFunding {
  symbol: string;
  rate: number | null;
  nextSettleTime: number | null;
  collectCycleHours: number | null;
  timestamp: number | null;
}

export interface MexcPosition {
  positionId: number | string | null;
  symbol: string | null;
  side: 'long' | 'short' | 'unknown';
  marginMode: 'isolated' | 'cross' | 'unknown';
  holdVolume: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  liquidationPrice: number | null;
  leverage: number | null;
  initialMargin: number | null;
  realisedPnl: number | null;
  estimatedUnrealisedPnl: number | null;
  updateTime: number | null;
}

export interface MexcAsset {
  currency: string;
  available: number | null;
  frozen: number | null;
  equity: number | null;
  unrealised: number | null;
}

export interface MexcClient {
  ticker(symbol: string): Promise<MexcTicker>;
  klines(args: {
    symbol: string;
    interval:
      | 'Min1'
      | 'Min5'
      | 'Min15'
      | 'Min30'
      | 'Hour1'
      | 'Hour4'
      | 'Hour8'
      | 'Day1';
    limit: number;
  }): Promise<MexcCandle[]>;
  orderbook(args: { symbol: string; limit: number }): Promise<MexcOrderBook>;
  funding(symbol: string): Promise<MexcFunding>;
  positions(): Promise<MexcPosition[]>;
  assets(): Promise<MexcAsset[]>;
}

export interface MexcClientOptions {
  apiKey?: string;
  secretKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export declare function createMexcClient(
  options?: MexcClientOptions,
): MexcClient;
