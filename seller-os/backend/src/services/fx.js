import { FX_CURRENCIES } from '../config.js';

const PRIMARY = process.env.FX_PRIMARY_URL || 'https://api.frankfurter.dev';
const FALLBACK = process.env.FX_FALLBACK_URL || 'https://open.er-api.com/v6/latest/JPY';
const DEFAULT_BUFFER = Number(process.env.FX_BUFFER_DEFAULT || 0.02);

async function getJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JAPANOVA-Seller-OS/0.1'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function ensureComplete(localPerJpy, provider) {
  const missing = FX_CURRENCIES.filter((c) => !(Number(localPerJpy[c]) > 0));
  if (missing.length) throw new Error(`${provider} 누락 통화: ${missing.join(', ')}`);
  return localPerJpy;
}

async function fetchFrankfurter() {
  const url = `${PRIMARY}/v2/rates?base=JPY&quotes=${FX_CURRENCIES.join(',')}`;
  const rows = await getJson(url);
  const localPerJpy = {};
  const dates = [];
  for (const row of rows) {
    const quote = String(row.quote || '').toUpperCase();
    if (FX_CURRENCIES.includes(quote) && Number(row.rate) > 0) {
      localPerJpy[quote] = Number(row.rate);
      if (row.date) dates.push(row.date);
    }
  }
  return {
    provider: 'Frankfurter v2',
    sourceDate: dates.sort().at(-1) || null,
    localPerJpy: ensureComplete(localPerJpy, 'Frankfurter v2')
  };
}

async function fetchExchangeRateApi() {
  const payload = await getJson(FALLBACK);
  if (payload.result !== 'success') {
    throw new Error(`ExchangeRate-API 오류: ${payload['error-type'] || 'unknown'}`);
  }
  const localPerJpy = Object.fromEntries(
    FX_CURRENCIES.map((c) => [c, Number(payload.rates?.[c] || 0)])
  );
  return {
    provider: 'ExchangeRate-API Open',
    sourceDate: payload.time_last_update_utc || String(payload.time_last_update_unix || ''),
    attribution: 'Rates By Exchange Rate API',
    attributionUrl: 'https://www.exchangerate-api.com',
    localPerJpy: ensureComplete(localPerJpy, 'ExchangeRate-API Open')
  };
}

function convertToJpyPer(localPerJpy) {
  return Object.fromEntries(
    Object.entries(localPerJpy).map(([currency, rate]) => [currency, 1 / Number(rate)])
  );
}

function compareProviders(a, b) {
  const warnings = [];
  if (!a || !b) return warnings;
  const aj = convertToJpyPer(a.localPerJpy);
  const bj = convertToJpyPer(b.localPerJpy);
  for (const c of FX_CURRENCIES) {
    const mid = (aj[c] + bj[c]) / 2;
    const diff = Math.abs(aj[c] - bj[c]) / mid;
    if (diff > 0.03) warnings.push(`${c}: 환율 소스 간 차이 ${(diff * 100).toFixed(2)}%`);
  }
  return warnings;
}

export async function fetchFxSnapshot({ buffer = DEFAULT_BUFFER } = {}) {
  const errors = [];
  let primary = null;
  let fallback = null;

  try {
    primary = await fetchFrankfurter();
  } catch (error) {
    errors.push(`Frankfurter v2: ${error.message}`);
  }

  try {
    fallback = await fetchExchangeRateApi();
  } catch (error) {
    errors.push(`ExchangeRate-API Open: ${error.message}`);
  }

  const selected = primary || fallback;
  if (!selected) {
    const error = new Error('모든 환율 소스 호출에 실패했습니다.');
    error.causes = errors;
    throw error;
  }

  const jpyPer = convertToJpyPer(selected.localPerJpy);
  const priceFx = Object.fromEntries(
    Object.entries(jpyPer).map(([currency, rate]) => [currency, rate * (1 - buffer)])
  );
  const warnings = compareProviders(primary, fallback);

  return {
    baseCurrency: 'JPY',
    provider: selected.provider,
    sourceDate: selected.sourceDate,
    updatedAt: new Date().toISOString(),
    status: warnings.length ? 'warning' : 'ok',
    warnings,
    errors,
    fxBuffer: buffer,
    jpyPer,
    priceFx,
    fallbackAttribution: fallback
      ? { text: fallback.attribution, url: fallback.attributionUrl }
      : null
  };
}
