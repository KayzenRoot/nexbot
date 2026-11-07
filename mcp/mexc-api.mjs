// MEXC futures (contract) API client.
//
// Signing format follows the official MEXC contract API docs (verified 2026-11):
//   https://mexcdevelop.github.io/apidocs/contract_v1_en/  (integration guide)
//   https://www.mexc.com/api-docs/futures/integration-guide
//
// Private endpoints authenticate with HTTP headers (not query params):
//   ApiKey:        the API access key
//   Request-Time:  millisecond timestamp, must be within the recv window
//   Signature:     hex HMAC-SHA256(secretKey, accessKey + reqTime + paramString)
//   Recv-Window:   optional, seconds (docs recommend <= 30)
// paramString is the sorted "key=value&key2=value2" string of business params
// (values URL-encoded) for GET requests, or the JSON body string for POST.
// The endpoints used here take no business params, so the signed target is
// simply `accessKey + reqTime`.

import { createHmac } from 'node:crypto';

export const MEXC_BASE_URL = 'https://contract.mexc.com';
export const DEFAULT_TIMEOUT_MS = 10_000;
// Docs: recv-window is in seconds, max 60, and values above 30 are not
// recommended. (The spot-API style 5000 ms value does not apply here.)
export const RECV_WINDOW_SECONDS = 30;

export const KLINE_INTERVALS = [
  'Min1',
  'Min5',
  'Min15',
  'Min30',
  'Hour1',
  'Hour4',
  'Hour8',
  'Day1',
];

// MEXC's wire name for the 1-hour interval is "Min60" ("Hour1" is rejected
// with error code 600, verified against the live API on 2026-11).
const WIRE_INTERVAL = {
  Min1: 'Min1',
  Min5: 'Min5',
  Min15: 'Min15',
  Min30: 'Min30',
  Hour1: 'Min60',
  Hour4: 'Hour4',
  Hour8: 'Hour8',
  Day1: 'Day1',
};

const INTERVAL_SECONDS = {
  Min1: 60,
  Min5: 300,
  Min15: 900,
  Min30: 1800,
  Hour1: 3600,
  Hour4: 14_400,
  Hour8: 28_800,
  Day1: 86_400,
};

export class MexcApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number | null, kind?: 'mexc' | 'http' | 'timeout' | 'network' | 'config' }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'MexcApiError';
    /** MEXC error code when the API answered with success:false. */
    this.code = options.code ?? null;
    /** Error class, used by callers to distinguish failure modes. */
    this.kind = options.kind ?? 'mexc';
  }
}

/** URL-encodes one value the way MEXC's reference implementation does. */
export function encodeRequestParamValue(value) {
  return encodeURIComponent(String(value)).replaceAll('+', '%20');
}

/**
 * Builds the request parameter string to sign: params sorted in dictionary
 * order, joined as "key=value&key2=value2", values URL-encoded.
 * @param {Record<string, string | number>} [params]
 */
export function buildRequestParamString(params = {}) {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeRequestParamValue(params[key])}`)
    .join('&');
}

/**
 * Computes the MEXC contract API signature.
 * Target string: accessKey + reqTime + paramString.
 * Returns lowercase hex HMAC-SHA256.
 * @param {{ accessKey: string, secretKey: string, reqTime: string | number, paramString?: string }} args
 */
export function buildSignature({
  accessKey,
  secretKey,
  reqTime,
  paramString = '',
}) {
  const target = `${accessKey}${reqTime}${paramString}`;
  return createHmac('sha256', secretKey).update(target, 'utf8').digest('hex');
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {{
 *   apiKey?: string,
 *   secretKey?: string,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} [options]
 */
export function createMexcClient(options = {}) {
  const {
    apiKey = process.env.MEXC_API_KEY ?? '',
    secretKey = process.env.MEXC_API_SECRET ?? '',
    baseUrl = MEXC_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
  } = options;

  const trimmedBase = baseUrl.replace(/\/+$/, '');

  function requireCredentials() {
    if (!apiKey || !secretKey) {
      throw new MexcApiError(
        'This tool reads private MEXC account data and requires MEXC_API_KEY and MEXC_API_SECRET to be set in the environment. Restart the MCP server with both variables configured.',
        { kind: 'config' },
      );
    }
  }

  /**
   * Performs one MEXC API call and unwraps the `data` field.
   * @param {string} path
   * @param {{ params?: Record<string, string | number>, private?: boolean }} [init]
   */
  async function request(path, init = {}) {
    const { params = {}, private: isPrivate = false } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let url;
    const headers = { 'Content-Type': 'application/json' };
    try {
      if (isPrivate) {
        requireCredentials();
        // Auth goes in headers per the contract API docs. The access key is
        // never placed in the URL, so error messages can safely include URLs.
        const paramString = buildRequestParamString(params);
        const reqTime = String(now());
        const signature = buildSignature({
          accessKey: apiKey,
          secretKey,
          reqTime,
          paramString,
        });
        url = `${trimmedBase}${path}${paramString ? `?${paramString}` : ''}`;
        headers.ApiKey = apiKey;
        headers['Request-Time'] = reqTime;
        headers.Signature = signature;
        headers['Recv-Window'] = String(RECV_WINDOW_SECONDS);
      } else {
        url = trimmedBase + path;
        const search = new URLSearchParams(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        );
        const qs = search.toString();
        if (qs) url += `?${qs}`;
      }
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new MexcApiError(
            `MEXC API request timed out after ${timeoutMs} ms`,
            { kind: 'timeout' },
          );
        }
        throw new MexcApiError(
          `MEXC API request failed: ${error instanceof Error ? error.message : String(error)}`,
          { kind: 'network' },
        );
      }

      let body;
      try {
        body = await response.json();
      } catch {
        throw new MexcApiError(
          `MEXC API returned a non-JSON response (HTTP ${response.status})`,
          { kind: 'http' },
        );
      }

      // MEXC wraps every response as { success, code, data } and reports
      // application-level failures with success:false and a numeric code.
      if (body && typeof body === 'object' && body.success === false) {
        const code = toNumber(body.code, null);
        throw new MexcApiError(
          `MEXC error ${code}: ${typeof body.message === 'string' && body.message ? body.message : 'unknown error'}`,
          { code, kind: 'mexc' },
        );
      }
      if (!response.ok) {
        throw new MexcApiError(`MEXC API returned HTTP ${response.status}`, {
          kind: 'http',
          code: toNumber(body?.code, null),
        });
      }
      return body?.data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Latest price / 24h stats for one futures symbol.
   * @param {string} symbol
   */
  async function ticker(symbol) {
    const data = await request('/api/v1/contract/ticker', {
      params: { symbol },
    });
    return {
      symbol: String(data?.symbol ?? symbol),
      lastPrice: toNumber(data?.lastPrice),
      change24h: toNumber(data?.riseFallRate),
      change24hValue: toNumber(data?.riseFallValue),
      high24h: toNumber(data?.high24Price),
      low24h: toNumber(data?.lower24Price),
      volume24h: toNumber(data?.volume24),
      turnover24h: toNumber(data?.amount24),
      indexPrice: toNumber(data?.indexPrice),
      fairPrice: toNumber(data?.fairPrice),
      fundingRate: toNumber(data?.fundingRate),
      timestamp: toNumber(data?.timestamp),
    };
  }

  /**
   * OHLCV candles, most recent last. MEXC returns columnar arrays; this
   * reshapes them into rows and trims to `limit`.
   * @param {{ symbol: string, interval: string, limit: number }} args
   */
  async function klines({ symbol, interval, limit }) {
    const secondsPerCandle = INTERVAL_SECONDS[interval];
    const endSeconds = Math.floor(now() / 1000);
    const startSeconds = endSeconds - limit * secondsPerCandle;
    const data = await request(`/api/v1/contract/kline/${symbol}`, {
      params: {
        interval: WIRE_INTERVAL[interval],
        start: startSeconds,
        end: endSeconds,
      },
    });
    const time = Array.isArray(data?.time) ? data.time : [];
    const open = Array.isArray(data?.open) ? data.open : [];
    const close = Array.isArray(data?.close) ? data.close : [];
    const high = Array.isArray(data?.high) ? data.high : [];
    const low = Array.isArray(data?.low) ? data.low : [];
    const vol = Array.isArray(data?.vol) ? data.vol : [];
    const rows = time.map((t, i) => ({
      time: toNumber(t, 0),
      open: toNumber(open[i]),
      close: toNumber(close[i]),
      high: toNumber(high[i]),
      low: toNumber(low[i]),
      volume: toNumber(vol[i], 0),
    }));
    return rows.slice(-limit);
  }

  /**
   * Order book snapshot. MEXC levels are [price, volume, orderCount?].
   * @param {{ symbol: string, limit: number }} args
   */
  async function orderbook({ symbol, limit }) {
    const data = await request(`/api/v1/contract/depth/${symbol}`, {
      params: { limit },
    });
    const toLevels = (levels) =>
      (Array.isArray(levels) ? levels : []).map((level) => ({
        price: toNumber(level?.[0]),
        volume: toNumber(level?.[1]),
      }));
    return {
      symbol,
      bids: toLevels(data?.bids),
      asks: toLevels(data?.asks),
      timestamp: toNumber(data?.timestamp),
    };
  }

  /**
   * Current funding rate and next settlement time.
   * @param {string} symbol
   */
  async function funding(symbol) {
    const data = await request(`/api/v1/contract/funding_rate/${symbol}`);
    return {
      symbol: String(data?.symbol ?? symbol),
      rate: toNumber(data?.fundingRate),
      nextSettleTime: toNumber(data?.nextSettleTime),
      collectCycleHours: toNumber(data?.collectCycle),
      timestamp: toNumber(data?.timestamp),
    };
  }

  async function contractDetail(symbol) {
    const data = await request('/api/v1/contract/detail', {
      params: { symbol },
    });
    return data;
  }

  async function fairPrice(symbol) {
    const data = await request(`/api/v1/contract/fair_price/${symbol}`);
    return toNumber(data?.fairPrice);
  }

  /**
   * Open positions. MEXC's open_positions payload has no mark price or
   * unrealised PnL, so this enriches each position with the public fair
   * price and contract size to estimate unrealised PnL; if the auxiliary
   * calls fail those fields degrade to null instead of failing the tool.
   */
  async function positions() {
    const data = await request('/api/v1/private/position/open_positions', {
      private: true,
    });
    const raw = Array.isArray(data) ? data : [];
    const symbols = [...new Set(raw.map((p) => p?.symbol).filter(Boolean))];
    const details = new Map(
      await Promise.all(
        symbols.map(async (sym) => {
          try {
            const [detail, mark] = await Promise.all([
              contractDetail(sym),
              fairPrice(sym),
            ]);
            return [
              sym,
              { contractSize: toNumber(detail?.contractSize), markPrice: mark },
            ];
          } catch {
            return [sym, null];
          }
        }),
      ),
    );
    return raw.map((p) => {
      const side =
        p?.positionType === 1
          ? 'long'
          : p?.positionType === 2
            ? 'short'
            : 'unknown';
      const entryPrice = toNumber(p?.openAvgPrice);
      const holdVolume = toNumber(p?.holdVol);
      const enrichment = details.get(p?.symbol);
      const markPrice = enrichment?.markPrice ?? null;
      let estimatedUnrealisedPnl = null;
      if (markPrice !== null && entryPrice !== null && holdVolume !== null) {
        const direction = side === 'short' ? -1 : 1;
        const contractSize = enrichment?.contractSize ?? 1;
        const pnl =
          direction * (markPrice - entryPrice) * holdVolume * contractSize;
        estimatedUnrealisedPnl = Number(pnl.toFixed(8));
      }
      return {
        positionId: p?.positionId ?? null,
        symbol: p?.symbol ?? null,
        side,
        marginMode:
          p?.openType === 1
            ? 'isolated'
            : p?.openType === 2
              ? 'cross'
              : 'unknown',
        holdVolume,
        entryPrice,
        markPrice,
        liquidationPrice: toNumber(p?.liquidatePrice),
        leverage: toNumber(p?.leverage),
        initialMargin: toNumber(p?.im),
        realisedPnl: toNumber(p?.realised),
        estimatedUnrealisedPnl,
        updateTime: toNumber(p?.updateTime),
      };
    });
  }

  /**
   * Futures account balances per asset.
   */
  async function assets() {
    const data = await request('/api/v1/private/account/assets', {
      private: true,
    });
    const raw = Array.isArray(data) ? data : [];
    return raw.map((a) => ({
      currency: String(a?.currency ?? ''),
      available: toNumber(a?.availableBalance),
      frozen: toNumber(a?.frozenBalance),
      equity: toNumber(a?.equity),
      unrealised: toNumber(a?.unrealized),
    }));
  }

  return { ticker, klines, orderbook, funding, positions, assets };
}
