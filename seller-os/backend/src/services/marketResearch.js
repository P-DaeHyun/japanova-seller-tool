import crypto from 'node:crypto';

const MARKETS = {
  TW: { nameKo: '대만', currency: 'TWD', shopDomain: 'shopee.tw', affiliateEndpoint: 'https://open-api.affiliate.shopee.tw/graphql' },
  SG: { nameKo: '싱가포르', currency: 'SGD', shopDomain: 'shopee.sg', affiliateEndpoint: 'https://open-api.affiliate.shopee.sg/graphql' },
  MY: { nameKo: '말레이시아', currency: 'MYR', shopDomain: 'shopee.com.my', affiliateEndpoint: 'https://open-api.affiliate.shopee.com.my/graphql' },
  TH: { nameKo: '태국', currency: 'THB', shopDomain: 'shopee.co.th', affiliateEndpoint: 'https://open-api.affiliate.shopee.co.th/graphql' },
  PH: { nameKo: '필리핀', currency: 'PHP', shopDomain: 'shopee.ph', affiliateEndpoint: 'https://open-api.affiliate.shopee.ph/graphql' },
  VN: { nameKo: '베트남', currency: 'VND', shopDomain: 'shopee.vn', affiliateEndpoint: 'https://open-api.affiliate.shopee.vn/graphql' },
  BR: { nameKo: '브라질', currency: 'BRL', shopDomain: 'shopee.com.br', affiliateEndpoint: 'https://open-api.affiliate.shopee.com.br/graphql' }
};

function market(code) {
  const key = String(code || '').toUpperCase();
  const value = MARKETS[key];
  if (!value) throw new Error(`지원하지 않는 Shopee 시장입니다: ${code}`);
  return { code: key, ...value };
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function affiliateCredentials(code) {
  const prefix = `SHOPEE_AFFILIATE_${code}`;
  const appId = String(process.env[`${prefix}_APP_ID`] || '').trim();
  const secret = String(process.env[`${prefix}_SECRET`] || '').trim();
  const endpoint = String(process.env[`${prefix}_ENDPOINT`] || '').trim();
  return { appId, secret, endpoint, configured: Boolean(appId && secret) };
}

export function buildShopeeSearchUrl(marketCode, keyword) {
  const m = market(marketCode);
  return `https://${m.shopDomain}/search?keyword=${encodeURIComponent(String(keyword || '').trim())}`;
}

export function getResearchProviderStatus() {
  return Object.values(MARKETS).map((m0) => {
    const m = market(Object.keys(MARKETS).find((code) => MARKETS[code] === m0));
    const cred = affiliateCredentials(m.code);
    return {
      marketCode: m.code,
      marketNameKo: m.nameKo,
      currency: m.currency,
      automaticSearch: cred.configured,
      provider: cred.configured ? 'SHOPEE_AFFILIATE_OPEN_API' : 'OFFICIAL_SEARCH_ASSISTED',
      searchBaseUrl: `https://${m.shopDomain}/search`,
      credentialKeys: [
        `SHOPEE_AFFILIATE_${m.code}_APP_ID`,
        `SHOPEE_AFFILIATE_${m.code}_SECRET`
      ]
    };
  });
}

function normalizeNode(node, m) {
  const priceMin = optionalNumber(node?.priceMin ?? node?.price);
  const priceMax = optionalNumber(node?.priceMax ?? node?.price);
  const priceLocal = priceMin ?? priceMax;
  return {
    itemId: node?.itemId == null ? null : String(node.itemId),
    shopId: node?.shopId == null ? null : String(node.shopId),
    title: String(node?.productName || node?.name || '').trim(),
    shopName: String(node?.shopName || '').trim(),
    priceLocal,
    priceMinLocal: priceMin,
    priceMaxLocal: priceMax,
    currency: m.currency,
    sales: optionalNumber(node?.sales),
    rating: optionalNumber(node?.ratingStar),
    discountRate: optionalNumber(node?.priceDiscountRate),
    imageUrl: node?.imageUrl || null,
    productUrl: node?.productLink || null,
    source: 'SHOPEE_AFFILIATE_OPEN_API'
  };
}

export async function searchShopeeCompetitors({ marketCode, keyword, page = 1, limit = 12, sortType = 1 }) {
  const m = market(marketCode);
  const q = String(keyword || '').trim();
  if (!q) throw new Error('경쟁상품 검색어가 필요합니다.');

  const searchUrl = buildShopeeSearchUrl(m.code, q);
  const cred = affiliateCredentials(m.code);
  if (!cred.configured) {
    return {
      marketCode: m.code,
      marketNameKo: m.nameKo,
      currency: m.currency,
      keyword: q,
      mode: 'ASSISTED',
      provider: 'OFFICIAL_SEARCH_ASSISTED',
      providerConfigured: false,
      searchUrl,
      results: [],
      message: '이 시장의 Shopee Affiliate Open API 자격정보가 없어 공식 Shopee 검색 보조모드로 동작합니다.'
    };
  }

  const safePage = clampInt(page, 1, 100, 1);
  const safeLimit = clampInt(limit, 1, 50, 12);
  const safeSort = [1, 2, 3, 4, 5].includes(Number(sortType)) ? Number(sortType) : 1;
  const query = `query ProductOfferV2($keyword: String, $sortType: Int, $page: Int, $limit: Int) {
    productOfferV2(keyword: $keyword, sortType: $sortType, page: $page, limit: $limit) {
      nodes {
        itemId shopId productName shopName sales priceMin priceMax ratingStar
        priceDiscountRate imageUrl productLink
      }
      pageInfo { page limit hasNextPage }
    }
  }`;
  const payload = JSON.stringify({
    query,
    variables: { keyword: q, sortType: safeSort, page: safePage, limit: safeLimit }
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHash('sha256')
    .update(`${cred.appId}${timestamp}${payload}${cred.secret}`)
    .digest('hex');
  const endpoint = cred.endpoint || m.affiliateEndpoint;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `SHA256 Credential=${cred.appId},Timestamp=${timestamp},Signature=${signature}`
      },
      body: payload,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Shopee Affiliate API HTTP ${response.status}`);
  }
  if (Array.isArray(body?.errors) && body.errors.length) {
    const first = body.errors[0];
    const code = first?.extensions?.code ? ` (${first.extensions.code})` : '';
    throw new Error(`Shopee Affiliate API 오류${code}: ${first?.message || '알 수 없는 오류'}`);
  }

  const root = body?.data?.productOfferV2 || {};
  const results = Array.isArray(root.nodes)
    ? root.nodes.map((node) => normalizeNode(node, m)).filter((x) => x.title && x.priceLocal !== null)
    : [];

  return {
    marketCode: m.code,
    marketNameKo: m.nameKo,
    currency: m.currency,
    keyword: q,
    mode: 'AUTO',
    provider: 'SHOPEE_AFFILIATE_OPEN_API',
    providerConfigured: true,
    searchUrl,
    pageInfo: root.pageInfo || null,
    results,
    fetchedAt: new Date().toISOString()
  };
}
