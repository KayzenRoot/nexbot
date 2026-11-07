// MEXC futures market data MCP server.
//
// Exposes six tools (mexc_ticker, mexc_klines, mexc_orderbook, mexc_funding,
// mexc_positions, mexc_balance) over Streamable HTTP so NexBot dots can pull
// real market data through their existing MCP connection flow.
//
// Run: node mcp/mexc-server.mjs
// Env:  MEXC_MCP_PORT   (default 4315)   MEXC_API_KEY / MEXC_API_SECRET
//       (the latter two only gate the private tools; public tools work without)
// URL:  http://127.0.0.1:<port>/mcp   — bound to 127.0.0.1 only.
//
// Secrets: the API key/secret are read from the environment once and used
// exclusively to sign outbound MEXC requests. They and the computed
// signature are never logged or included in tool output.

import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createMexcClient, KLINE_INTERVALS } from './mexc-api.mjs';

const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}_[A-Z0-9]{2,20}$/;
const DEFAULT_PORT = 4315;
const MAX_HTTP_BODY_BYTES = 1_000_000;

const symbolSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(
    SYMBOL_PATTERN,
    'Invalid MEXC futures symbol: use uppercase BASE_QUOTE like BTC_USDT',
  );

const intervalSchema = z.enum(KLINE_INTERVALS);

const klineArgs = z
  .object({
    symbol: symbolSchema,
    interval: intervalSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(100)
      .describe('Number of candles, 1-200'),
  })
  .strict();

const orderbookArgs = z
  .object({
    symbol: symbolSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Depth levels per side, 1-100'),
  })
  .strict();

const tickerArgs = z.object({ symbol: symbolSchema }).strict();
const fundingArgs = z.object({ symbol: symbolSchema }).strict();
const noArgs = z.object({}).strict();

/**
 * Wraps a tool handler so MEXC/API failures come back as clean tool errors
 * (message text only — never stacks, raw bodies or credentials).
 */
function toolHandler(run) {
  return async (args) => {
    let data;
    try {
      data = await run(args);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      throw new Error(message);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
    };
  };
}

/**
 * Builds the MCP server with the six MEXC tools registered.
 * @param {{ client?: ReturnType<typeof import('./mexc-api.mjs').createMexcClient> }} [options]
 */
export function createMexcMcpServer(options = {}) {
  const mexc = options.client ?? createMexcClient();
  const server = new McpServer({
    name: 'mexc-futures',
    version: '1.0.0',
  });

  server.registerTool(
    'mexc_ticker',
    {
      title: 'MEXC futures ticker',
      description:
        'Latest price snapshot for one MEXC futures (perpetual) symbol: last price, 24h change (fraction, e.g. 0.0016 = +0.16%), 24h high/low, 24h volume and turnover. Use for the current market price, momentum and volatility checks. Symbol format: uppercase BASE_QUOTE, e.g. BTC_USDT.',
      inputSchema: tickerArgs,
    },
    toolHandler(async ({ symbol }) => mexc.ticker(symbol)),
  );

  server.registerTool(
    'mexc_klines',
    {
      title: 'MEXC futures klines',
      description:
        'Candlestick (OHLCV) data for a MEXC futures symbol. Use for technical analysis: trends, S/R, indicators. Interval examples: Min15, Hour1, Hour4, Day1. Returns up to `limit` candles in ascending time order; `time` is a unix timestamp in seconds and volume is in contracts.',
      inputSchema: klineArgs,
    },
    toolHandler(async ({ symbol, interval, limit }) =>
      mexc.klines({ symbol, interval, limit }),
    ),
  );

  server.registerTool(
    'mexc_orderbook',
    {
      title: 'MEXC futures order book',
      description:
        'Current order book for a MEXC futures symbol: up to `limit` ranked bid and ask levels with price and volume. Use for liquidity, spread, and immediate support/resistance around the touch. Max 100 levels per side.',
      inputSchema: orderbookArgs,
    },
    toolHandler(async ({ symbol, limit }) => mexc.orderbook({ symbol, limit })),
  );

  server.registerTool(
    'mexc_funding',
    {
      title: 'MEXC futures funding rate',
      description:
        'Current funding rate and next settlement time for a MEXC perpetual futures symbol. Use to gauge long/short crowding and carry: a positive rate means longs pay shorts at settlement (repeats every collectCycleHours, usually 8).',
      inputSchema: fundingArgs,
    },
    toolHandler(async ({ symbol }) => mexc.funding(symbol)),
  );

  server.registerTool(
    'mexc_positions',
    {
      title: 'MEXC futures open positions',
      description:
        'Open MEXC futures positions on the configured account: side, entry price, mark (fair) price, estimated unrealised PnL, realised PnL, leverage, liquidation price and margin mode. Requires MEXC_API_KEY and MEXC_API_SECRET to be configured on the MCP server.',
      inputSchema: noArgs,
    },
    toolHandler(async () => mexc.positions()),
  );

  server.registerTool(
    'mexc_balance',
    {
      title: 'MEXC futures account balance',
      description:
        'MEXC futures account balances per asset: available, frozen and total equity plus unrealised PnL. Requires MEXC_API_KEY and MEXC_API_SECRET to be configured on the MCP server.',
      inputSchema: noArgs,
    },
    toolHandler(async () => mexc.assets()),
  );

  return server;
}

function writeJsonError(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Starts the MCP HTTP server (Streamable HTTP, stateless: each POST creates
 * a fresh transport and answers with a single JSON response).
 * @param {{
 *   port?: number,
 *   client?: ReturnType<typeof import('./mexc-api.mjs').createMexcClient>,
 * }} [options]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startMexcMcpServer(options = {}) {
  const port =
    options.port ?? (Number(process.env.MEXC_MCP_PORT) || DEFAULT_PORT);
  const host = '127.0.0.1';
  // Filled in once the socket is bound (port may be 0 = ephemeral).
  // host.docker.internal is allowed so the NexBot container can reach this
  // server through Docker Desktop's host alias.
  let allowedHosts = [
    `${host}:${port}`,
    `localhost:${port}`,
    `host.docker.internal:${port}`,
  ];

  const httpServer = createHttpServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
        .pathname;
    } catch {
      writeJsonError(res, 400, 'Bad request URL');
      return;
    }
    if (pathname !== '/mcp') {
      writeJsonError(res, 404, 'Not found: the MCP endpoint is /mcp');
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no session SSE streams or session teardown.
      res.setHeader('Allow', 'POST');
      writeJsonError(res, 405, 'Method not allowed: use POST');
      return;
    }

    let raw = '';
    let overflow = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_HTTP_BODY_BYTES) {
        overflow = true;
        req.destroy();
      }
    });
    req.on('error', () => {
      writeJsonError(res, 400, 'Request stream error');
    });
    req.on('end', async () => {
      if (overflow) {
        writeJsonError(res, 413, 'Request body too large');
        return;
      }
      let parsedBody;
      if (raw.length > 0) {
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          writeJsonError(res, 400, 'Invalid JSON body');
          return;
        }
      }
      // Fresh stateless transport per request (required by the SDK).
      const server = createMexcMcpServer({ client: options.client });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts,
      });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        writeJsonError(res, 500, 'Internal MCP server error');
        transport.close().catch(() => {});
        server.close().catch(() => {});
        // Error details are logged without request bodies or credentials.
        console.error(
          '[mexc-mcp] request handling failed:',
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      const boundPort =
        typeof address === 'object' && address ? address.port : port;
      allowedHosts = [
        `${host}:${boundPort}`,
        `localhost:${boundPort}`,
        `host.docker.internal:${boundPort}`,
      ];
      resolve({
        port: boundPort,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            httpServer.closeAllConnections();
            httpServer.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      });
    });
  });
}

/** Direct invocation: `node mcp/mexc-server.mjs` */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  const port = Number(process.env.MEXC_MCP_PORT) || DEFAULT_PORT;
  const hasCredentials = Boolean(
    process.env.MEXC_API_KEY && process.env.MEXC_API_SECRET,
  );
  startMexcMcpServer({ port })
    .then(({ port: boundPort }) => {
      console.log(
        `[mexc-mcp] MEXC futures MCP server listening on http://127.0.0.1:${boundPort}/mcp`,
      );
      console.log(
        `[mexc-mcp] private tools (mexc_positions, mexc_balance): ${hasCredentials ? 'enabled (credentials configured)' : 'disabled (MEXC_API_KEY / MEXC_API_SECRET not set)'}`,
      );
    })
    .catch((error) => {
      console.error(
        '[mexc-mcp] failed to start:',
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    });
}
