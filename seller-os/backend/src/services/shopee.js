import crypto from 'node:crypto';

const PARTNER_ID = Number(String(process.env.SHOPEE_PARTNER_ID || '').trim() || 0);
const RAW_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || '';
const PARTNER_KEY = String(RAW_PARTNER_KEY).trim();
const ENV = String(process.env.SHOPEE_ENV || 'sandbox').trim();
const REDIRECT_URI = String(process.env.SHOPEE_REDIRECT_URI || '').trim();

const BASE_URL = ENV === 'production'
  ? 'https://partner.shopeemobile.com'
  : ENV === 'sandbox_cn'
    ? 'https://openplatform.test-stable.shopee.cn'
    : 'https://openplatform.sandbox.test-stable.shopee.sg';

const AUTH_BASE_URL = ENV === 'production'
  ? 'https://open.shopee.com'
  : ENV === 'sandbox_cn'
    ? 'https://open.sandbox.test-stable.shopee.cn'
    : 'https://open.sandbox.test-stable.shopee.com';

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

function shopSignedUrl(path, { shopId, accessToken, params = {} }) {
  const { timestamp, sign } = signShopApi(path, accessToken, shopId);
  const qs = queryString({
    partner_id: PARTNER_ID,
    timestamp,
    access_token: accessToken,
    shop_id: shopId,
    sign,
    ...params
  });
  return `${BASE_URL}${path}?${qs}`;
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
  if (!PARTNER_ID) {
    throw new Error('SHOPEE_PARTNER_ID 환경변수가 필요합니다.');
  }
  const cleanRedirectUri = String(redirectUri || '').trim();
  if (!cleanRedirectUri) {
    throw new Error('SHOPEE_REDIRECT_URI 환경변수가 필요합니다.');
  }
  const qs = queryString({
    partner_id: PARTNER_ID,
    auth_type: 'seller',
    redirect_uri: cleanRedirectUri,
    response_type: 'code'
  });
  return `${AUTH_BASE_URL}/auth?${qs}`;
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
  const response = await fetch(shopSignedUrl(path, { shopId, accessToken, params }));
  const data = await parseShopeeResponse(response);
  if (data?.response && typeof data.response === 'object' && !Array.isArray(data.response)) {
    return { ...data, ...data.response };
  }
  return data;
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
  const response = await fetch(shopSignedUrl(path, { shopId, accessToken }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return parseShopeeResponse(response);
}

/*
 * Shopee Media API multipart 업로드.
 * 상품 생성과 분리되어 있으며, 호출자가 파일 업로드를 명시적으로 요청한 경우에만 사용한다.
 */
export async function uploadShopImage({ shopId, accessToken, bytes, filename, contentType = 'image/jpeg' }) {
  if (!bytes?.length) throw new Error('업로드할 이미지 파일이 비어 있습니다.');
  const path = '/api/v2/media/upload_image';
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: contentType }), filename || 'image.jpg');
  const response = await fetch(shopSignedUrl(path, { shopId, accessToken }), {
    method: 'POST',
    body: form
  });
  return parseShopeeResponse(response);
}

// 배송라벨 다운로드 API는 성공 시 JSON이 아니라 waybill 파일을 반환한다.
export async function postShopApiFile(path, { shopId, accessToken, body = {} }) {
  const response = await fetch(shopSignedUrl(path, { shopId, accessToken }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const contentType = String(response.headers.get('content-type') || 'application/octet-stream');
  const disposition = String(response.headers.get('content-disposition') || '');

  if (!response.ok || contentType.includes('application/json')) {
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (parsed?.error) {
      throw new Error(`Shopee API 오류 ${parsed.error}: ${parsed.message || ''}`.trim());
    }
    if (!response.ok) {
      throw new Error(`Shopee HTTP ${response.status}: ${text.slice(0, 1000)}`);
    }
    throw new Error(parsed?.message || 'Shopee가 배송라벨 파일 대신 JSON 응답을 반환했습니다.');
  }

  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType,
    disposition
  };
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

  // 중요: merchant에 속한 Shop 목록과 실제로 이번 인증에서 승인된 Shop 목록은 다르다.
  // Main Account 인증은 Shopee가 token.shop_id_list로 돌려준 Shop만 승인된 Shop으로 취급한다.
  // merchant API로 발견한 Shop을 shop_id_list에 임의로 합치면 refresh_token과 shop_id가 불일치할 수 있다.
  if (mainAccountId) {
    const authorizedShopIds = Array.isArray(token.shop_id_list)
      ? token.shop_id_list.map(Number).filter(Boolean)
      : [];

    if (authorizedShopIds.length === 1 && token.refresh_token) {
      try {
        const scoped = await refreshAccessToken({
          refreshToken: token.refresh_token,
          shopId: authorizedShopIds[0]
        });
        token.access_token = scoped.access_token || token.access_token;
        token.refresh_token = scoped.refresh_token || token.refresh_token;
        token.expire_in = scoped.expire_in || token.expire_in;
        token.scoped_shop_id = authorizedShopIds[0];
      } catch (error) {
        console.warn('Main-account Shop token scoping failed:', error.message);
      }
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
  trackingNumber: '/api/v2/logistics/get_tracking_number',
  shippingDocumentParameter: '/api/v2/logistics/get_shipping_document_parameter',
  createShippingDocument: '/api/v2/logistics/create_shipping_document',
  shippingDocumentResult: '/api/v2/logistics/get_shipping_document_result',
  downloadShippingDocument: '/api/v2/logistics/download_shipping_document',
  shopListByMerchant: '/api/v2/merchant/get_shop_list_by_merchant',
  category: '/api/v2/product/get_category',
  attributeTree: '/api/v2/product/get_attribute_tree',
  logisticsChannelList: '/api/v2/logistics/get_channel_list',
  uploadImage: '/api/v2/media/upload_image',
  addItem: '/api/v2/product/add_item'
});
