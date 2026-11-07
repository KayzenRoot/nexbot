import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  buildRequestParamString,
  buildSignature,
  createMexcClient,
  encodeRequestParamValue,
  MEXC_BASE_URL,
  MexcApiError,
} from '../mcp/mexc-api.mjs';
import { startMexcMcpServer } from '../mcp/mexc-server.mjs';

const TEST_ACCESS_KEY = 'mxTestKey1234567890';
const TEST_SECRET_KEY = 'unit-test-secret-key';
const FIXED_NOW_MS = 1_700_000_000_000;

// Precomputed independently with node:crypto (HMAC-SHA256 hex over
// `accessKey + reqTime + paramString`), not via the module under test:
//   target = 'mxTestKey1234567890' + '1700000000000' + ''
const EXPECTED_EMPTY_TARGET_SIGNATURE =
  '35431e9b8f4acba18f139a3c40064df13bc1b54e32915df26556421209fa211a';
//   target = 'mxTestKey1234567890' + '1700000000000' + 'limit=20&req_time=1700000000000&symbol=BTC%20USDT'
const EXPECTED_PARAM_TARGET_SIGNATURE =
  '4fda9dc6b612f4287dd1a93e78607767afef7949e6e21e4d88add9e086a257f3';

type MexcRoute = (url: string) => unknown;

const ok = (data: unknown) => ({ success: true, code: 0, data });
const fail = (code: number, message: string) => ({
  success: false,
  code,
  message,
});

const TICKER_DATA = {
  symbol: 'BTC_USDT',
  lastPrice: 75955,
  bid1: 75955,
  ask1: 75955.1,
  volume24: 241229284,
  amount24: 1827284705.43,
  lower24Price: 74808.4,
  high24Price: 76346.3,
  riseFallRate: 0.0016,
  riseFallValue: 122.2,
  indexPrice: 75995.7,
  fairPrice: 75957.9,
  fundingRate: -0.000006,
  timestamp: 1_794_053_611_156,
};

const KLINE_DATA = {
  time: [1_794_045_600, 1_794_049_200, 1_794_052_800],
  open: [75_800.0, 75_962.0, 75_945.1],
  close: [75_962.0, 75_945.1, 75_955.1],
  high: [76_010.0, 76_002.5, 75_974.3],
  low: [75_750.0, 75_890.0, 75_940.2],
  vol: [900_000.0, 3_526_730.0, 555_003.0],
  amount: [683_000.0, 26_784_597.5, 4_215_853.7],
};

const DEPTH_DATA = {
  asks: [
    [75955.1, 21319, 2],
    [75955.2, 6560, 1],
  ],
  bids: [
    [75955, 26194, 5],
    [75954.8, 256425, 1],
  ],
  version: 43_277_933_287,
  timestamp: 1_794_053_613_818,
};

const FUNDING_DATA = {
  symbol: 'BTC_USDT',
  fundingRate: -0.000006,
  maxFundingRate: 0.0018,
  minFundingRate: -0.0018,
  collectCycle: 8,
  nextSettleTime: 1_794_067_200_000,
  timestamp: 1_794_053_615_310,
};

const POSITIONS_DATA = [
  {
    positionId: 1_394_650,
    symbol: 'BTC_USDT',
    positionType: 1,
    openType: 1,
    state: 1,
    holdVol: 1000,
    frozenVol: 0,
    closeVol: 0,
    holdAvgPrice: 75_900.0,
    openAvgPrice: 75_000.0,
    closeAvgPrice: 0,
    liquidatePrice: 70_000.0,
    oim: 60.7,
    im: 60.7,
    holdFee: 0,
    realised: -1.5,
    leverage: 20,
    createTime: 1_794_000_000_000,
    updateTime: 1_794_050_000_000,
    autoAddIm: false,
  },
  {
    positionId: 1_394_651,
    symbol: 'ETH_USDT',
    positionType: 2,
    openType: 2,
    state: 1,
    holdVol: 10,
    frozenVol: 0,
    closeVol: 0,
    holdAvgPrice: 2951.0,
    openAvgPrice: 3000.0,
    closeAvgPrice: 0,
    liquidatePrice: 3400.0,
    oim: 50.0,
    im: 50.0,
    holdFee: 0,
    realised: 2.0,
    leverage: 10,
    createTime: 1_794_000_000_000,
    updateTime: 1_794_050_000_000,
    autoAddIm: false,
  },
];

const ASSETS_DATA = [
  {
    currency: 'USDT',
    positionMargin: 60.7,
    availableBalance: 1000.5,
    frozenBalance: 12.25,
    equity: 1073.45,
    unrealized: 95.59,
    bonus: 0,
  },
];

/** Wraps a MEXC-shaped route handler into a fetch-like mock. */
function mockMexcFetch(route: MexcRoute) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(
    async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
      calls.push({ url: String(url), init });
      const body = route(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response;
    },
  );
  return { calls, impl: impl as unknown as typeof fetch };
}

function publicRoutes(url: string): unknown {
  if (url.includes('/api/v1/contract/ticker')) return ok(TICKER_DATA);
  if (url.includes('/api/v1/contract/kline/')) return ok(KLINE_DATA);
  if (url.includes('/api/v1/contract/depth/')) return ok(DEPTH_DATA);
  if (url.includes('/api/v1/contract/funding_rate/')) return ok(FUNDING_DATA);
  if (url.includes('/api/v1/private/position/open_positions')) {
    return ok(POSITIONS_DATA);
  }
  if (url.includes('/api/v1/private/account/assets')) return ok(ASSETS_DATA);
  if (url.includes('/api/v1/contract/detail')) {
    const symbol = new URL(url).searchParams.get('symbol');
    return ok({
      symbol,
      contractSize: symbol === 'ETH_USDT' ? 10 : 0.0001,
    });
  }
  if (url.includes('/api/v1/contract/fair_price/')) {
    return ok({
      symbol: url.split('/fair_price/')[1],
      fairPrice: url.endsWith('ETH_USDT') ? 2950.0 : 75955.9,
      timestamp: 1_794_053_620_000,
    });
  }
  return fail(511, 'Endpoint inaccessible');
}

describe('mexc-api signing', () => {
  it('produces the documented deterministic hex signature', () => {
    expect(
      buildSignature({
        accessKey: TEST_ACCESS_KEY,
        secretKey: TEST_SECRET_KEY,
        reqTime: '1700000000000',
        paramString: '',
      }),
    ).toBe(EXPECTED_EMPTY_TARGET_SIGNATURE);
    expect(
      buildSignature({
        accessKey: TEST_ACCESS_KEY,
        secretKey: TEST_SECRET_KEY,
        reqTime: '1700000000000',
        paramString: 'limit=20&req_time=1700000000000&symbol=BTC%20USDT',
      }),
    ).toBe(EXPECTED_PARAM_TARGET_SIGNATURE);
  });

  it('builds the request parameter string in sorted dictionary order', () => {
    expect(
      buildRequestParamString({
        symbol: 'BTC USDT',
        limit: 20,
        req_time: 1_700_000_000_000,
      }),
    ).toBe('limit=20&req_time=1700000000000&symbol=BTC%20USDT');
    expect(buildRequestParamString()).toBe('');
  });

  it('encodes like the MEXC reference implementation (space as %20)', () => {
    expect(encodeRequestParamValue('a b+c')).toBe('a%20b%2Bc');
  });
});

describe('mexc-api client (mocked fetch)', () => {
  it('maps ticker data to a flat market snapshot', async () => {
    const mock = mockMexcFetch(publicRoutes);
    const client = createMexcClient({
      fetchImpl: mock.impl,
      now: () => FIXED_NOW_MS,
    });
    const snapshot = await client.ticker('BTC_USDT');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe(
      `${MEXC_BASE_URL}/api/v1/contract/ticker?symbol=BTC_USDT`,
    );
    expect(mock.calls[0].init.method).toBe('GET');
    expect(snapshot).toEqual({
      symbol: 'BTC_USDT',
      lastPrice: 75955,
      change24h: 0.0016,
      change24hValue: 122.2,
      high24h: 76346.3,
      low24h: 74808.4,
      volume24h: 241229284,
      turnover24h: 1827284705.43,
      indexPrice: 75995.7,
      fairPrice: 75957.9,
      fundingRate: -0.000006,
      timestamp: 1_794_053_611_156,
    });
  });

  it('maps kline columnar data to OHLCV rows and trims to the limit', async () => {
    const mock = mockMexcFetch(publicRoutes);
    const client = createMexcClient({
      fetchImpl: mock.impl,
      now: () => FIXED_NOW_MS,
    });
    const candles = await client.klines({
      symbol: 'BTC_USDT',
      interval: 'Hour4',
      limit: 2,
    });
    expect(mock.calls[0].url).toBe(
      `${MEXC_BASE_URL}/api/v1/contract/kline/BTC_USDT?interval=Hour4&start=1699971200&end=1700000000`,
    );
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      time: 1_794_049_200,
      open: 75_962.0,
      close: 75_945.1,
      high: 76_002.5,
      low: 75_890.0,
      volume: 3_526_730.0,
    });
    expect(candles[1].time).toBe(1_794_052_800);
  });

  it('sends the documented Min60 wire interval for Hour1', async () => {
    const mock = mockMexcFetch(publicRoutes);
    const client = createMexcClient({
      fetchImpl: mock.impl,
      now: () => FIXED_NOW_MS,
    });
    await client.klines({ symbol: 'BTC_USDT', interval: 'Hour1', limit: 1 });
    expect(mock.calls[0].url).toContain('interval=Min60');
  });

  it('maps order book levels to price/volume pairs', async () => {
    const mock = mockMexcFetch(publicRoutes);
    const client = createMexcClient({
      fetchImpl: mock.impl,
      now: () => FIXED_NOW_MS,
    });
    const book = await client.orderbook({ symbol: 'BTC_USDT', limit: 2 });
    expect(mock.calls[0].url).toBe(
      `${MEXC_BASE_URL}/api/v1/contract/depth/BTC_USDT?limit=2`,
    );
    expect(book.bids).toEqual([
      { price: 75955, volume: 26194 },
      { price: 75954.8, volume: 256425 },
    ]);
    expect(book.asks).toEqual([
      { price: 75955.1, volume: 21319 },
      { price: 75955.2, volume: 6560 },
    ]);
  });

  it('maps funding rate data', async () => {
    const mock = mockMexcFetch(publicRoutes);
    const client = createMexcClient({
      fetchImpl: mock.impl,
      now: () => FIXED_NOW_MS,
    });
    const funding = await client.funding('BTC_USDT');
    expect(mock.calls[0].url).toBe(
      `${MEXC_BASE_URL}/api/v1/contract/funding_rate/BTC_USDT`,
    );
    expect(funding.rate).toBe(-0.000006);
    expect(funding.nextSettleTime).toBe(1_794_067_200_000);
    expect(funding.collectCycleHours).toBe(8);
  });

  it('signs private requests in headers with the deterministic signature', async () => {
    const mock = mockMexcFetch(publicRoutes);
    const client = createMexcClient({
      apiKey: TEST_ACCESS_KEY,
      secretKey: TEST_SECRET_KEY,
      fetchImpl: mock.impl,
      now: () => FIXED_NOW_MS,
    });
    await client.positions();
    // One private call + two public enrichment calls per distinct symbol.
    const call = mock.calls.find((entry) =>
      entry.url.includes('/api/v1/private/position/open_positions'),
    );
    expect(call).toBeDefined();
    expect(call!.url).toBe(
      `${MEXC_BASE_URL}/api/v1/private/position/open_positions`,
    );
    expect(call!.url).not.toContain('signature');
    expect(call!.url).not.toContain(TEST_ACCESS_KEY);
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.ApiKey).toBe(TEST_ACCESS_KEY);
    expect(headers['Request-Time']).toBe(String(FIXED_NOW_MS));
    expect(headers.Signature).toBe(EXPECTED_EMPTY_TARGET_SIGNATURE);
    expect(headers['Recv-Window']).toBe('30');
  });

  it('enriches positions with mark price and estimated unrealised PnL', async () => {
    const mock = mockMexcFetch(publicRoutes);
    const client = createMexcClient({
      apiKey: TEST_ACCESS_KEY,
      secretKey: TEST_SECRET_KEY,
      fetchImpl: mock.impl,
      now: () => FIXED_NOW_MS,
    });
    const positions = await client.positions();
    expect(positions).toHaveLength(2);
    const [btc, eth] = positions;
    expect(btc).toMatchObject({
      symbol: 'BTC_USDT',
      side: 'long',
      marginMode: 'isolated',
      entryPrice: 75_000.0,
      markPrice: 75_955.9,
      holdVolume: 1000,
      leverage: 20,
      realisedPnl: -1.5,
      // (75955.9 - 75000) * 1000 * 0.0001
      estimatedUnrealisedPnl: 95.59,
    });
    expect(eth).toMatchObject({
      symbol: 'ETH_USDT',
      side: 'short',
      marginMode: 'cross',
      entryPrice: 3000.0,
      markPrice: 2950.0,
      // (3000 - 2950) * 10 * 10
      estimatedUnrealisedPnl: 5000,
    });
  });

  it('maps account assets to available/frozen per currency', async () => {
    const mock = mockMexcFetch(publicRoutes);
    const client = createMexcClient({
      apiKey: TEST_ACCESS_KEY,
      secretKey: TEST_SECRET_KEY,
      fetchImpl: mock.impl,
      now: () => FIXED_NOW_MS,
    });
    const assets = await client.assets();
    expect(mock.calls[0].url).toBe(
      `${MEXC_BASE_URL}/api/v1/private/account/assets`,
    );
    expect(assets).toEqual([
      {
        currency: 'USDT',
        available: 1000.5,
        frozen: 12.25,
        equity: 1073.45,
        unrealised: 95.59,
      },
    ]);
  });

  it('turns success:false MEXC responses into errors carrying the code', async () => {
    const publicMock = mockMexcFetch(() => fail(600, 'Parameter error'));
    const publicClient = createMexcClient({
      fetchImpl: publicMock.impl,
      now: () => FIXED_NOW_MS,
    });
    const publicError = await publicClient.ticker('NOPE_USDT').then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );
    expect(publicError).toBeInstanceOf(MexcApiError);
    expect((publicError as MexcApiError).code).toBe(600);
    expect((publicError as MexcApiError).kind).toBe('mexc');
    expect((publicError as Error).message).toContain('MEXC error 600');

    const privateMock = mockMexcFetch(() =>
      fail(602, 'Confirming signature failed'),
    );
    const privateClient = createMexcClient({
      apiKey: TEST_ACCESS_KEY,
      secretKey: TEST_SECRET_KEY,
      fetchImpl: privateMock.impl,
      now: () => FIXED_NOW_MS,
    });
    const privateError = await privateClient.assets().then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );
    expect(privateError).toBeInstanceOf(MexcApiError);
    expect((privateError as MexcApiError).code).toBe(602);
  });

  it('maps HTTP failures and non-JSON bodies to clean errors', async () => {
    const unauthorized = vi.fn(
      async (): Promise<Response> =>
        ({
          ok: false,
          status: 401,
          json: async () => fail(401, 'Not logged in or login has expired'),
        }) as unknown as Response,
    );
    const client = createMexcClient({
      apiKey: TEST_ACCESS_KEY,
      secretKey: TEST_SECRET_KEY,
      fetchImpl: unauthorized as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    await expect(client.assets()).rejects.toMatchObject({
      kind: 'mexc',
      code: 401,
    });

    const garbage = vi.fn(
      async (): Promise<Response> =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('Unexpected token < in JSON');
          },
        }) as unknown as Response,
    );
    const badClient = createMexcClient({
      fetchImpl: garbage as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    await expect(badClient.ticker('BTC_USDT')).rejects.toMatchObject({
      kind: 'http',
    });
  });

  it('surfaces timeouts as MexcApiError (kind timeout)', async () => {
    const hanging = vi.fn(
      (_url: string | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortError = new Error('This operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }),
    );
    const client = createMexcClient({
      fetchImpl: hanging as unknown as typeof fetch,
      timeoutMs: 50,
      now: () => FIXED_NOW_MS,
    });
    await expect(client.ticker('BTC_USDT')).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('surfaces network failures as MexcApiError (kind network)', async () => {
    const broken = vi.fn(async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    const client = createMexcClient({
      fetchImpl: broken as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    await expect(client.ticker('BTC_USDT')).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('fails private tools cleanly when no credentials are configured', async () => {
    const mock = mockMexcFetch(publicRoutes);
    const client = createMexcClient({
      apiKey: '',
      secretKey: '',
      fetchImpl: mock.impl,
      now: () => FIXED_NOW_MS,
    });
    await expect(client.positions()).rejects.toThrow(/MEXC_API_KEY/);
    await expect(client.assets()).rejects.toThrow(/MEXC_API_KEY/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('mexc MCP server over HTTP (mocked MEXC fetch)', () => {
  let server: Awaited<ReturnType<typeof startMexcMcpServer>> | undefined;
  let mcpClient: Client | undefined;

  async function startWithClient(fetchImpl: typeof fetch, credentials = true) {
    const client = createMexcClient({
      apiKey: credentials ? TEST_ACCESS_KEY : '',
      secretKey: credentials ? TEST_SECRET_KEY : '',
      fetchImpl,
      now: () => FIXED_NOW_MS,
    });
    server = await startMexcMcpServer({ port: 0, client });
    mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
    );
    await mcpClient.connect(transport);
  }

  afterEach(async () => {
    if (mcpClient) {
      await mcpClient.close();
      mcpClient = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('lists the six MEXC tools with model-oriented descriptions', async () => {
    await startWithClient(mockMexcFetch(publicRoutes).impl);
    const { tools } = await mcpClient!.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'mexc_balance',
      'mexc_funding',
      'mexc_klines',
      'mexc_orderbook',
      'mexc_positions',
      'mexc_ticker',
    ]);
    const klines = tools.find((tool) => tool.name === 'mexc_klines');
    expect(klines?.description).toContain('technical analysis');
    const positions = tools.find((tool) => tool.name === 'mexc_positions');
    expect(positions?.description).toContain('MEXC_API_KEY');
  });

  it('serves mexc_ticker market data through the MCP protocol', async () => {
    const mock = mockMexcFetch(publicRoutes);
    await startWithClient(mock.impl);
    const result = await mcpClient!.callTool({
      name: 'mexc_ticker',
      arguments: { symbol: 'BTC_USDT' },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      symbol: 'BTC_USDT',
      lastPrice: 75955,
      change24h: 0.0016,
      volume24h: 241229284,
    });
    expect(mock.calls[0].url).toContain('/api/v1/contract/ticker');
  });

  it('serves mexc_klines candle rows through the MCP protocol', async () => {
    const mock = mockMexcFetch(publicRoutes);
    await startWithClient(mock.impl);
    const result = await mcpClient!.callTool({
      name: 'mexc_klines',
      arguments: { symbol: 'BTC_USDT', interval: 'Hour4', limit: 2 },
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    ) as Array<Record<string, number>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toEqual({
      time: 1_794_052_800,
      open: 75_945.1,
      close: 75_955.1,
      high: 75_974.3,
      low: 75_940.2,
      volume: 555_003.0,
    });
  });

  it('serves mexc_orderbook and mexc_funding through the MCP protocol', async () => {
    const mock = mockMexcFetch(publicRoutes);
    await startWithClient(mock.impl);
    const book = await mcpClient!.callTool({
      name: 'mexc_orderbook',
      arguments: { symbol: 'BTC_USDT', limit: 2 },
    });
    const parsedBook = JSON.parse(
      (book.content as Array<{ type: string; text: string }>)[0].text,
    ) as { bids: unknown[]; asks: unknown[] };
    expect(parsedBook.bids).toHaveLength(2);
    expect(parsedBook.asks).toHaveLength(2);

    const funding = await mcpClient!.callTool({
      name: 'mexc_funding',
      arguments: { symbol: 'BTC_USDT' },
    });
    const parsedFunding = JSON.parse(
      (funding.content as Array<{ type: string; text: string }>)[0].text,
    ) as Record<string, unknown>;
    expect(parsedFunding.rate).toBe(-0.000006);
    expect(parsedFunding.nextSettleTime).toBe(1_794_067_200_000);
  });

  it('signs private MCP calls with the deterministic signature', async () => {
    const mock = mockMexcFetch(publicRoutes);
    await startWithClient(mock.impl);
    const result = await mcpClient!.callTool({
      name: 'mexc_balance',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    ) as Array<Record<string, unknown>>;
    expect(parsed[0]).toMatchObject({
      currency: 'USDT',
      available: 1000.5,
      frozen: 12.25,
    });
    const privateCall = mock.calls.find((call) =>
      call.url.includes('/api/v1/private/account/assets'),
    );
    expect(privateCall).toBeDefined();
    expect(privateCall!.url).not.toContain('signature');
    const headers = privateCall!.init.headers as Record<string, string>;
    expect(headers.ApiKey).toBe(TEST_ACCESS_KEY);
    expect(headers['Request-Time']).toBe(String(FIXED_NOW_MS));
    expect(headers.Signature).toBe(EXPECTED_EMPTY_TARGET_SIGNATURE);
  });

  it('serves enriched positions through the MCP protocol', async () => {
    const mock = mockMexcFetch(publicRoutes);
    await startWithClient(mock.impl);
    const result = await mcpClient!.callTool({
      name: 'mexc_positions',
      arguments: {},
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    ) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      symbol: 'BTC_USDT',
      side: 'long',
      entryPrice: 75_000.0,
      markPrice: 75_955.9,
      leverage: 20,
      estimatedUnrealisedPnl: 95.59,
    });
  });

  it('turns MEXC success:false responses into MCP tool errors with the code', async () => {
    const mock = mockMexcFetch((url) =>
      url.includes('/api/v1/contract/ticker')
        ? fail(600, 'Parameter error')
        : publicRoutes(url),
    );
    await startWithClient(mock.impl);
    const result = await mcpClient!.callTool({
      name: 'mexc_ticker',
      arguments: { symbol: 'NOPE_USDT' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain('MEXC error 600');
    expect(text).not.toContain('success');
  });

  it('fails private tools cleanly when the server has no credentials', async () => {
    const mock = mockMexcFetch(publicRoutes);
    await startWithClient(mock.impl, false);
    const result = await mcpClient!.callTool({
      name: 'mexc_positions',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain('MEXC_API_KEY');
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects invalid or oversized inputs before any network call', async () => {
    const mock = mockMexcFetch(publicRoutes);
    await startWithClient(mock.impl);
    const invalidCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }> = [
      // Unknown interval
      {
        name: 'mexc_klines',
        arguments: { symbol: 'BTC_USDT', interval: 'Hour2', limit: 10 },
      },
      // Oversized kline limit
      {
        name: 'mexc_klines',
        arguments: { symbol: 'BTC_USDT', interval: 'Min15', limit: 500 },
      },
      // Malformed symbol
      {
        name: 'mexc_klines',
        arguments: { symbol: 'BTCUSDT!', interval: 'Min15', limit: 10 },
      },
      // Unknown argument (strict schema)
      {
        name: 'mexc_klines',
        arguments: {
          symbol: 'BTC_USDT',
          interval: 'Min15',
          limit: 10,
          leverage: 20,
        },
      },
      // Oversized order book limit
      {
        name: 'mexc_orderbook',
        arguments: { symbol: 'BTC_USDT', limit: 1000 },
      },
      // Missing required symbol
      { name: 'mexc_ticker', arguments: {} },
    ];
    for (const call of invalidCalls) {
      // The SDK surfaces argument validation failures as isError results.
      const result = await mcpClient!.callTool(call);
      expect(result.isError, `expected ${call.name} to be rejected`).toBe(true);
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('answers only POST on /mcp and 404 elsewhere', async () => {
    await startWithClient(mockMexcFetch(publicRoutes).impl);
    const getResponse = await fetch(`http://127.0.0.1:${server!.port}/mcp`);
    expect(getResponse.status).toBe(405);
    const missResponse = await fetch(`http://127.0.0.1:${server!.port}/other`);
    expect(missResponse.status).toBe(404);
  });
});
