import crypto from 'node:crypto';

const PARTNER_ID = Number(String(process.env.SHOPEE_PARTNER_ID || '').trim() || 0);
const RAW_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || '';
const PARTNER_KEY = String(RAW_PARTNER_KEY).trim();
const ENV = String(process.env.SHOPEE_ENV || 'sandbox').trim();
const REDIRECT_URI = String(process.env.SHOPEE_REDIRECT_URI || '').trim();

const BASE_URL = ENV === 'production'
  ? 'https://partner.shopeemobile.com'
  : 'https://openplatform.sandbox.test-stable.shopee.sg';

const AUTH_BASE_URL = ENV === 'production'
  ? 'https://partner.shopeemobile.com'
  : 'https://openplatform.sandbox.test-stable.shopee.sg';

function requireSecrets() {
  if (!PARTNER_ID || !PARTNER_KEY) {
    throw new Error('SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY 환경변수가 필요합니다.');
  }
}

function hmac(baseString) {
  requireSecrets();
  return crypto
    .createHmac('sha256', PARTNER_KEY)
    .update(baseString)
    .digest('hex');
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

export function signPublicApi(path, timestamp = nowTs()) {
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  return { timestamp, sign: hmac(baseString) };
}

export function signShopApi(path, accessToken, shopId, timestamp = nowTs()) {
  const baseString = `${PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`;
  return { timestamp, sign: hmac(baseString) };
}

export function signMerchantApi(path, accessToken, merchantId, timestamp = nowTs()) {
  const baseString = `${PARTNER_ID}${path}${timestamp}${accessToken}${merchantId}`;
  return { timestamp, sign: hmac(baseString) };
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export function getShopeeConfigStatus() {
  return {
    environment: ENV,
    partnerId: PARTNER_ID,
    partnerKeyConfigured: Boolean(PARTNER_KEY),
    partnerKeyLength: PARTNER_KEY.length,
    partnerKeyHadOuterWhitespace: RAW_PARTNER_KEY !== PARTNER_KEY,
    redirectUri: REDIRECT_URI,
    apiBaseUrl: BASE_URL,
    authBaseUrl: AUTH_BASE_URL
  };
}

export function buildAuthorizationUrl({ redirectUri = REDIRECT_URI } = {}) {
  requireSecrets();
  const cleanRedirectUri = String(redirectUri || '').trim();
  if (!cleanRedirectUri) {
    throw new Error('SHOPEE_REDIRECT_URI 환경변수가 필요합니다.');
  }
  const path = '/api/v2/shop/auth_partner';
  const { timestamp, sign } = signPublicApi(path);
  const qs = queryString({
    partner_id: PARTNER_ID,
    timestamp,
    sign,
    redirect: cleanRedirectUri
  });
  return `${AUTH_BASE_URL}${path}?${qs}`;
}

async function parseShopeeResponse(response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Shopee HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  if (body.error) {
    throw new Error(`Shopee API 오류 ${body.error}: ${body.message || ''}`.trim());
  }
  return body;
}

export async function getShopApi(path, { shopId, accessToken, params = {} }) {
  const { timestamp, sign } = signShopApi(path, accessToken, shopId);
  const qs = queryString({
    partner_id: PARTNER_ID,
    timestamp,
    access_token: accessToken,
    shop_id: shopId,
    sign,
    ...params
  });
  const response = await fetch(`${BASE_URL}${path}?${qs}`);
  return parseShopeeResponse(response);
}

export async function getMerchantApi(path, { merchantId, accessToken, params = {} }) {
  const { timestamp, sign } = signMerchantApi(path, accessToken, merchantId);
  const qs = queryString({
    partner_id: PARTNER_ID,
    timestamp,
    access_token: accessToken,
    merchant_id: merchantId,
    sign,
    ...params
  });
  const response = await fetch(`${BASE_URL}${path}?${qs}`);
  return parseShopeeResponse(response);
}

export async function postShopApi(path, { shopId, accessToken, body = {} }) {
  const { timestamp, sign } = signShopApi(path, accessToken, shopId);
  const qs = queryString({
    partner_id: PARTNER_ID,
    timestamp,
    access_token: accessToken,
    shop_id: shopId,
    sign
  });
  const response = await fetch(`${BASE_URL}${path}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return parseShopeeResponse(response);
}

async function enrichMainAccountShopIds(token) {
  const existingShopIds = Array.isArray(token.shop_id_list) ? token.shop_id_list : [];
  if (existingShopIds.length > 0) return token;

  const merchantIds = Array.isArray(token.merchant_id_list) ? token.merchant_id_list : [];
  if (!merchantIds.length || !token.access_token) return token;

  const discovered = new Set();
  for (const merchantId of merchantIds) {
    for (let pageNo = 1; pageNo <= 20; pageNo += 1) {
      const data = await getMerchantApi('/api/v2/merchant/get_shop_list_by_merchant', {
        merchantId: Number(merchantId),
        accessToken: token.access_token,
        params: { page_no: pageNo, page_size: 500 }
      });
      const shopList = Array.isArray(data.shop_list)
        ? data.shop_list
        : (Array.isArray(data.response?.shop_list) ? data.response.shop_list : []);
      for (const row of shopList) {
        if (row?.shop_id) discovered.add(Number(row.shop_id));
        for (const affi of row?.sip_affi_shops || []) {
          if (affi?.affi_shop_id) discovered.add(Number(affi.affi_shop_id));
        }
      }
      const more = Boolean(data.more ?? data.response?.more);
      if (!more || shopList.length === 0) break;
    }
  }

  if (discovered.size > 0) {
    token.shop_id_list = [...discovered];
  }
  return token;
}

export async function exchangeAuthorizationCode({ code, shopId, mainAccountId }) {
  const path = '/api/v2/auth/token/get';
  const { timestamp, sign } = signPublicApi(path);
  const qs = queryString({ partner_id: PARTNER_ID, timestamp, sign });
  const body = {
    code,
    partner_id: PARTNER_ID,
    ...(mainAccountId ? { main_account_id: Number(mainAccountId) } : { shop_id: Number(shopId) })
  };
  const response = await fetch(`${BASE_URL}${path}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const token = await parseShopeeResponse(response);
  if (mainAccountId) {
    try {
      await enrichMainAccountShopIds(token);
    } catch (error) {
      console.warn('Main-account shop discovery failed:', error.message);
    }
  }
  return token;
}

export async function refreshAccessToken({ refreshToken, shopId, merchantId }) {
  const path = '/api/v2/auth/access_token/get';
  const { timestamp, sign } = signPublicApi(path);
  const qs = queryString({ partner_id: PARTNER_ID, timestamp, sign });
  const body = {
    refresh_token: refreshToken,
    partner_id: PARTNER_ID,
    ...(shopId ? { shop_id: Number(shopId) } : { merchant_id: Number(merchantId) })
  };
  const response = await fetch(`${BASE_URL}${path}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return parseShopeeResponse(response);
}

export const ShopeePaths = Object.freeze({
  shopInfo: '/api/v2/shop/get_shop_info',
  itemList: '/api/v2/product/get_item_list',
  orderList: '/api/v2/order/get_order_list',
  orderDetail: '/api/v2/order/get_order_detail',
  escrowDetail: '/api/v2/payment/get_escrow_detail',
  shippingParameter: '/api/v2/logistics/get_shipping_parameter',
  shipOrder: '/api/v2/logistics/ship_order',
  shopListByMerchant: '/api/v2/merchant/get_shop_list_by_merchant'
});
