import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MARKETS, orderStatusKo } from './config.js';
import { query } from './db.js';
import { encryptSecret } from './tokenCrypto.js';
import { fetchFxSnapshot } from './services/fx.js';
import {
  buildAuthorizationUrl,
  diagnosePartnerCredentialHosts,
  exchangeAuthorizationCode,
  getShopeeConfigStatus,
  getShopApi,
  postShopApi,
  postShopApiFile,
  ShopeePaths
} from './services/shopee.js';
import {
  calculateProfit,
  getValidAccessToken,
  syncAllForShop,
  syncOrders,
  syncProductList,
  syncSettlement
} from './services/sync.js';
import {
  getInventoryList,
  getInventoryMovements,
  getInventorySummary,
  receiveInventory,
  setInventoryItem
} from './services/inventory.js';
import candidateRouter from './routes/candidates.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const allowedOrigins = String(process.env.ALLOWED_ORIGIN || 'http://localhost:3000')
  .split(',').map(v => v.trim()).filter(Boolean);
const sellerOsApiKey = String(process.env.SELLER_OS_API_KEY || '').trim();

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('허용되지 않은 Origin입니다.'));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

function hasDb() { return Boolean(process.env.DATABASE_URL); }
function shopeeEnvironment(){ return String(process.env.SHOPEE_ENV || 'sandbox').trim().toLowerCase(); }
function shopeeReadOnly(){ return String(process.env.SHOPEE_READ_ONLY || '').trim().toLowerCase() === 'true'; }
function safeError(error) { return { error: true, message: error?.message || '알 수 없는 오류가 발생했습니다.' }; }
function requireDb(res) {
  if (hasDb()) return true;
  res.status(503).json({ error: true, message: 'DATABASE_URL 설정이 필요합니다.' });
  return false;
}
function isPublicApiPath(req) {
  return req.path === '/health'
    || req.path === '/shopee/callback'
    || req.path === '/shopee/authorize'
    || req.path === '/shopee/authorize-url';
}

app.use('/api', (req, res, next) => {
  if (!sellerOsApiKey || isPublicApiPath(req)) return next();
  if (String(req.get('x-seller-os-key') || '') === sellerOsApiKey) return next();
  return res.status(401).json({ error: true, message: 'Seller OS API 인증이 필요합니다.' });
});

async function loadLogisticsOrder(orderSn) {
  const result = await query(
    `select order_sn, shop_id, market_code, order_status, shipping_carrier,
            package_number, logistics_status, raw_json
     from orders where order_sn=$1`,
    [String(orderSn)]
  );
  return result.rows[0] || null;
}
function orderRef(order, { shippingDocumentType, trackingNumber } = {}) {
  return {
    order_sn: String(order.order_sn),
    ...(order.package_number ? { package_number: String(order.package_number) } : {}),
    ...(trackingNumber ? { tracking_number: String(trackingNumber) } : {}),
    ...(shippingDocumentType ? { shipping_document_type: String(shippingDocumentType) } : {})
  };
}
function extractTrackingNumber(data) {
  const root = data?.response || data || {};
  return root.tracking_number || root.tracking_no || root.first_mile_tracking_number || root.last_mile_tracking_number || null;
}

app.get('/api/health', async (_req, res) => {
  let db = '미설정';
  if (hasDb()) {
    try { await query('select 1'); db = '정상'; } catch { db = '오류'; }
  }
  res.json({
    service: 'JAPANOVA Seller OS Backend',
    version: '2.3.0',
    status: '정상',
    database: db,
    shopeeEnvironment: shopeeEnvironment(),
    shopeeReadOnly: shopeeReadOnly(),
    apiAuthEnabled: Boolean(sellerOsApiKey),
    markets: Object.keys(MARKETS),
    now: new Date().toISOString()
  });
});

app.get('/api/markets', async (_req, res) => {
  try {
    let connectionMap = {};
    if (hasDb()) {
      const result = await query(
        `select market_code, count(*)::int as shops, max(last_sync_at) as last_sync_at
         from shopee_connections where environment=$1 and status='CONNECTED' group by market_code`,
        [shopeeEnvironment()]
      );
      connectionMap = Object.fromEntries(result.rows.map(r => [r.market_code, r]));
    }
    res.json(Object.entries(MARKETS).map(([code, market]) => ({
      code,
      ...market,
      connectionStatus: connectionMap[code] ? '연결됨' : (market.futureMarket ? '향후 입점' : '미연동'),
      connectedShops: connectionMap[code]?.shops || 0,
      lastSyncAt: connectionMap[code]?.last_sync_at || null
    })));
  } catch (error) { res.status(500).json(safeError(error)); }
});

app.get('/api/fx', async (req, res) => {
  try {
    const buffer = req.query.buffer === undefined ? undefined : Number(req.query.buffer);
    res.json(await fetchFxSnapshot({ buffer }));
  } catch (error) { res.status(502).json(safeError(error)); }
});
app.post('/api/fx/refresh', async (req, res) => {
  try {
    const snapshot = await fetchFxSnapshot({
      buffer: req.body?.buffer === undefined ? undefined : Number(req.body.buffer)
    });
    if (hasDb()) {
      for (const [currency, jpyPer] of Object.entries(snapshot.jpyPer)) {
        await query(
          `insert into fx_rates(currency, jpy_per, provider, source_date, status)
           values ($1,$2,$3,$4,$5)`,
          [currency, jpyPer, snapshot.provider, snapshot.sourceDate, snapshot.status]
        );
      }
    }
    res.json({ message: '환율을 새로 갱신했습니다.', ...snapshot });
  } catch (error) { res.status(502).json(safeError(error)); }
});

app.get('/api/shopee/diagnostics', async (_req, res) => {
  try {
    const diagnostics = await diagnosePartnerCredentialHosts();
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({
      ...safeError(error),
      config: getShopeeConfigStatus()
    });
  }
});

app.get('/api/shopee/authorize-url', (_req, res) => {
  try {
    res.json({
      message: 'Shopee 인증 URL을 생성했습니다.',
      environment: shopeeEnvironment(),
      redirectUri: process.env.SHOPEE_REDIRECT_URI || null,
      url: buildAuthorizationUrl()
    });
  } catch (error) { res.status(500).json(safeError(error)); }
});
app.get('/api/shopee/authorize', (_req, res) => {
  try { res.redirect(buildAuthorizationUrl()); }
  catch (error) { res.status(500).json(safeError(error)); }
});
app.get('/api/shopee/callback', async (req, res) => {
  const { code, shop_id: shopId, main_account_id: mainAccountId } = req.query;
  if (!code || (!shopId && !mainAccountId)) {
    return res.status(400).json({ error: true, message: 'Shopee 인증 code와 shop_id 또는 main_account_id가 필요합니다.' });
  }
  try {
    const token = await exchangeAuthorizationCode({
      code: String(code),
      shopId: shopId ? Number(shopId) : undefined,
      mainAccountId: mainAccountId ? Number(mainAccountId) : undefined
    });
    const shopIds = token.shop_id_list?.length ? token.shop_id_list : (shopId ? [Number(shopId)] : []);
    const accessExpiresAt = new Date(Date.now() + Number(token.expire_in || 14400) * 1000);
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const connected = [];
    for (const id of shopIds) {
      let info = null;
      try {
        info = await getShopApi(ShopeePaths.shopInfo, { shopId: Number(id), accessToken: token.access_token });
      } catch (error) { console.warn('Shop info lookup failed', id, error.message); }
      const region = info?.region || null;
      const marketCode = region && MARKETS[region] ? region : null;
      const shopName = info?.shop_name || null;
      const merchantId = info?.merchant_id || token.merchant_id_list?.[0] || null;
      if (hasDb()) {
        await query(
          `insert into shopee_connections(
             environment, market_code, merchant_id, shop_id, shop_name, main_account_id,
             access_token_encrypted, refresh_token_encrypted,
             access_token_expires_at, refresh_token_expires_at, status, updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CONNECTED',now())
           on conflict (environment, shop_id) do update set
             market_code=excluded.market_code, merchant_id=excluded.merchant_id,
             shop_name=excluded.shop_name, main_account_id=excluded.main_account_id,
             access_token_encrypted=excluded.access_token_encrypted,
             refresh_token_encrypted=excluded.refresh_token_encrypted,
             access_token_expires_at=excluded.access_token_expires_at,
             refresh_token_expires_at=excluded.refresh_token_expires_at,
             status='CONNECTED', updated_at=now()`,
          [
            shopeeEnvironment(), marketCode, merchantId, Number(id), shopName,
            mainAccountId ? Number(mainAccountId) : null,
            encryptSecret(token.access_token), encryptSecret(token.refresh_token),
            accessExpiresAt, refreshExpiresAt
          ]
        );
      }
      connected.push({
        shopId: Number(id), shopName, marketCode,
        marketNameKo: marketCode ? MARKETS[marketCode].nameKo : '미확인', merchantId
      });
    }
    return res.json({
      message: 'Shopee 연결 인증이 완료되었습니다.', connected, tokenStored: hasDb(),
      accessTokenExpiresAt: accessExpiresAt.toISOString(), refreshTokenExpiresAt: refreshExpiresAt.toISOString()
    });
  } catch (error) { return res.status(502).json(safeError(error)); }
});

app.get('/api/shopee/connections', async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    const result = await query(
      `select market_code, merchant_id, shop_id, shop_name, main_account_id,
              authorization_expires_at, access_token_expires_at,
              refresh_token_expires_at, status, last_sync_at, updated_at
       from shopee_connections order by market_code nulls last, shop_id`
    );
    res.json({ connections: result.rows });
  } catch (error) { res.status(500).json(safeError(error)); }
});
app.get('/api/shopee/shop/:shopId', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const id = Number(req.params.shopId);
    const auth = await getValidAccessToken(id);
    const data = await getShopApi(ShopeePaths.shopInfo, { shopId: id, accessToken: auth.accessToken });
    res.json({ ...data, tokenRefreshed: auth.refreshed });
  } catch (error) { res.status(502).json(safeError(error)); }
});
app.post('/api/shopee/refresh-token/:shopId', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const auth = await getValidAccessToken(Number(req.params.shopId));
    res.json({ message: auth.refreshed ? 'Access Token을 갱신했습니다.' : '현재 Access Token이 아직 유효합니다.' });
  } catch (error) { res.status(502).json(safeError(error)); }
});
app.post('/api/shopee/sync/:shopId', async (req, res) => {
  if (!requireDb(res)) return;
  const shopId = Number(req.params.shopId);
  const scope = String(req.body?.scope || 'all');
  const days = Number(req.body?.days || 7);
  try {
    if (scope === 'products') return res.json(await syncProductList(shopId));
    if (scope === 'orders') return res.json(await syncOrders(shopId, { days }));
    if (scope === 'settlement') {
      if (!req.body?.orderSn) return res.status(400).json({ error: true, message: 'orderSn이 필요합니다.' });
      const settlement = await syncSettlement(shopId, String(req.body.orderSn));
      const profit = await calculateProfit(String(req.body.orderSn));
      return res.json({ settlement, profit });
    }
    return res.json(await syncAllForShop(shopId, { days }));
  } catch (error) { return res.status(502).json(safeError(error)); }
});
app.post('/api/shopee/sync-all', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const connections = await query(
      `select shop_id, market_code from shopee_connections where status='CONNECTED' order by market_code`
    );
    const results = [];
    for (const row of connections.rows) {
      try {
        const result = await syncAllForShop(Number(row.shop_id), { days: Number(req.body?.days || 7) });
        results.push({ shopId: row.shop_id, marketCode: row.market_code, ok: true, ...result });
      } catch (error) {
        results.push({ shopId: row.shop_id, marketCode: row.market_code, ok: false, message: error.message });
      }
    }
    res.json({ results });
  } catch (error) { res.status(500).json(safeError(error)); }
});

app.get('/api/shopee/shipping-parameter/:orderSn', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const order = await loadLogisticsOrder(req.params.orderSn);
    if (!order) return res.status(404).json({ error: true, message: '주문을 찾을 수 없습니다.' });
    const auth = await getValidAccessToken(Number(order.shop_id));
    const data = await getShopApi(ShopeePaths.shippingParameter, {
      shopId: Number(order.shop_id), accessToken: auth.accessToken,
      params: { order_sn: order.order_sn, ...(order.package_number ? { package_number: order.package_number } : {}) }
    });
    return res.json({
      order: { ...order, order_status_ko: orderStatusKo(order.order_status) },
      shippingParameter: data.response || data,
      tokenRefreshed: auth.refreshed
    });
  } catch (error) { return res.status(502).json(safeError(error)); }
});
app.post('/api/shopee/ship/:orderSn', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const orderSn = String(req.params.orderSn);
    const method = String(req.body?.method || '');
    if (!['pickup', 'dropoff', 'non_integrated'].includes(method)) {
      return res.status(400).json({ error: true, message: 'method는 pickup, dropoff, non_integrated 중 하나여야 합니다.' });
    }
    const order = await loadLogisticsOrder(orderSn);
    if (!order) return res.status(404).json({ error: true, message: '주문을 찾을 수 없습니다.' });
    if (order.order_status !== 'READY_TO_SHIP') {
      return res.status(409).json({ error: true, message: `출고 가능한 READY_TO_SHIP 주문이 아닙니다. 현재 상태: ${orderStatusKo(order.order_status)}` });
    }
    const methodPayload = req.body?.[method];
    if (!methodPayload || typeof methodPayload !== 'object') {
      return res.status(400).json({ error: true, message: `${method} 출고 파라미터가 필요합니다.` });
    }
    if (process.env.SHOPEE_ENV === 'production' && req.body?.confirm !== 'SHIP') {
      return res.status(400).json({ error: true, message: 'Production 실제 출고에는 confirm="SHIP" 확인값이 필요합니다.' });
    }
    const auth = await getValidAccessToken(Number(order.shop_id));
    const data = await postShopApi(ShopeePaths.shipOrder, {
      shopId: Number(order.shop_id), accessToken: auth.accessToken,
      body: { order_sn: orderSn, ...(order.package_number ? { package_number: order.package_number } : {}), [method]: methodPayload }
    });
    let sync = null;
    try { sync = await syncOrders(Number(order.shop_id), { days: 15 }); }
    catch (error) { console.warn('출고 후 주문 재동기화 실패:', error.message); }
    return res.json({ message: 'Shopee 출고 요청을 전송했습니다.', orderSn, method, response: data.response || data, orderResync: sync });
  } catch (error) { return res.status(502).json(safeError(error)); }
});
app.get('/api/shopee/tracking/:orderSn', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const order = await loadLogisticsOrder(req.params.orderSn);
    if (!order) return res.status(404).json({ error: true, message: '주문을 찾을 수 없습니다.' });
    const auth = await getValidAccessToken(Number(order.shop_id));
    const data = await getShopApi(ShopeePaths.trackingNumber, {
      shopId: Number(order.shop_id), accessToken: auth.accessToken,
      params: {
        order_sn: order.order_sn,
        ...(order.package_number ? { package_number: order.package_number } : {}),
        response_optional_fields: 'plp_number,first_mile_tracking_number,last_mile_tracking_number'
      }
    });
    return res.json({ orderSn: order.order_sn, packageNumber: order.package_number || null, trackingNumber: extractTrackingNumber(data), tracking: data.response || data });
  } catch (error) { return res.status(502).json(safeError(error)); }
});
app.get('/api/shopee/shipping-document/parameter/:orderSn', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const order = await loadLogisticsOrder(req.params.orderSn);
    if (!order) return res.status(404).json({ error: true, message: '주문을 찾을 수 없습니다.' });
    const auth = await getValidAccessToken(Number(order.shop_id));
    const data = await postShopApi(ShopeePaths.shippingDocumentParameter, {
      shopId: Number(order.shop_id), accessToken: auth.accessToken,
      body: { order_list: [orderRef(order)] }
    });
    return res.json({ orderSn: order.order_sn, packageNumber: order.package_number || null, parameter: data.response || data });
  } catch (error) { return res.status(502).json(safeError(error)); }
});
app.post('/api/shopee/shipping-document/create/:orderSn', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const order = await loadLogisticsOrder(req.params.orderSn);
    if (!order) return res.status(404).json({ error: true, message: '주문을 찾을 수 없습니다.' });
    const shippingDocumentType = String(req.body?.shippingDocumentType || '').trim();
    if (!shippingDocumentType) return res.status(400).json({ error: true, message: 'shippingDocumentType이 필요합니다.' });
    const auth = await getValidAccessToken(Number(order.shop_id));
    let trackingNumber = String(req.body?.trackingNumber || '').trim() || null;
    if (!trackingNumber) {
      try {
        const tracking = await getShopApi(ShopeePaths.trackingNumber, {
          shopId: Number(order.shop_id), accessToken: auth.accessToken,
          params: { order_sn: order.order_sn, ...(order.package_number ? { package_number: order.package_number } : {}) }
        });
        trackingNumber = extractTrackingNumber(tracking);
      } catch (error) { console.warn('라벨 생성 전 Tracking Number 조회 실패:', error.message); }
    }
    const data = await postShopApi(ShopeePaths.createShippingDocument, {
      shopId: Number(order.shop_id), accessToken: auth.accessToken,
      body: { order_list: [orderRef(order, { shippingDocumentType, trackingNumber })] }
    });
    return res.json({
      message: '배송라벨 생성 작업을 요청했습니다.', orderSn: order.order_sn,
      packageNumber: order.package_number || null, shippingDocumentType, trackingNumber,
      response: data.response || data
    });
  } catch (error) { return res.status(502).json(safeError(error)); }
});
app.get('/api/shopee/shipping-document/result/:orderSn', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const order = await loadLogisticsOrder(req.params.orderSn);
    if (!order) return res.status(404).json({ error: true, message: '주문을 찾을 수 없습니다.' });
    const shippingDocumentType = String(req.query.type || '').trim();
    const auth = await getValidAccessToken(Number(order.shop_id));
    const data = await postShopApi(ShopeePaths.shippingDocumentResult, {
      shopId: Number(order.shop_id), accessToken: auth.accessToken,
      body: { order_list: [orderRef(order, { shippingDocumentType: shippingDocumentType || undefined })] }
    });
    const result = data.response || data;
    const first = Array.isArray(result.result_list) ? result.result_list[0] : null;
    return res.json({
      orderSn: order.order_sn, packageNumber: order.package_number || null,
      shippingDocumentType: shippingDocumentType || null, status: first?.status || null, result
    });
  } catch (error) { return res.status(502).json(safeError(error)); }
});
app.get('/api/shopee/shipping-document/download/:orderSn', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const order = await loadLogisticsOrder(req.params.orderSn);
    if (!order) return res.status(404).json({ error: true, message: '주문을 찾을 수 없습니다.' });
    const shippingDocumentType = String(req.query.type || '').trim();
    if (!shippingDocumentType) return res.status(400).json({ error: true, message: 'type 쿼리값이 필요합니다.' });
    const auth = await getValidAccessToken(Number(order.shop_id));
    const ref = orderRef(order, { shippingDocumentType });
    const statusData = await postShopApi(ShopeePaths.shippingDocumentResult, {
      shopId: Number(order.shop_id), accessToken: auth.accessToken, body: { order_list: [ref] }
    });
    const statusRoot = statusData.response || statusData;
    const first = Array.isArray(statusRoot.result_list) ? statusRoot.result_list[0] : null;
    if (first?.status !== 'READY') {
      return res.status(409).json({
        error: true,
        message: first?.status === 'FAILED'
          ? `배송라벨 생성 실패: ${first.fail_message || first.fail_error || 'Shopee 오류'}`
          : `배송라벨이 아직 준비되지 않았습니다. 현재 상태: ${first?.status || '확인 중'}`,
        status: first?.status || null
      });
    }
    const file = await postShopApiFile(ShopeePaths.downloadShippingDocument, {
      shopId: Number(order.shop_id), accessToken: auth.accessToken, body: { order_list: [ref] }
    });
    const safeSn = String(order.order_sn).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `JAPANOVA_${safeSn}_${shippingDocumentType}.pdf`;
    res.setHeader('Content-Type', file.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', file.disposition || `attachment; filename="${filename}"`);
    return res.send(file.bytes);
  } catch (error) { return res.status(502).json(safeError(error)); }
});

/* Candidate products: Shopee registration is not required. */
app.use('/api/candidates', candidateRouter);

/* Inventory */
app.get('/api/inventory', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const items = await getInventoryList({ search: req.query.search || '', lowOnly: String(req.query.lowOnly || '') === 'true' });
    const summary = await getInventorySummary();
    res.json({ items, summary });
  } catch (error) { res.status(500).json(safeError(error)); }
});
app.get('/api/inventory/summary', async (_req, res) => {
  if (!requireDb(res)) return;
  try { res.json(await getInventorySummary()); }
  catch (error) { res.status(500).json(safeError(error)); }
});
app.get('/api/inventory/:sku/movements', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const movements = await getInventoryMovements(req.params.sku, { limit: req.query.limit });
    res.json({ sku: String(req.params.sku), movements });
  } catch (error) { res.status(400).json(safeError(error)); }
});
app.put('/api/inventory/:sku', async (req, res) => {
  if (!requireDb(res)) return;
  try { res.json({ message: '재고 설정을 저장했습니다.', ...(await setInventoryItem(req.params.sku, req.body || {})) }); }
  catch (error) { res.status(400).json(safeError(error)); }
});
app.post('/api/inventory/:sku/receive', async (req, res) => {
  if (!requireDb(res)) return;
  try { res.json({ message: '입고를 반영했습니다.', ...(await receiveInventory(req.params.sku, req.body || {})) }); }
  catch (error) { res.status(400).json(safeError(error)); }
});

/* Product / Cost */
app.get('/api/products', async (req, res) => {
  if (!requireDb(res)) return;
  const params = [];
  const where = [];
  if (req.query.market) { params.push(String(req.query.market)); where.push(`p.market_code=$${params.length}`); }
  if (req.query.shopId) { params.push(Number(req.query.shopId)); where.push(`p.shop_id=$${params.length}`); }
  const sqlWhere = where.length ? `where ${where.join(' and ')}` : '';
  try {
    const result = await query(
      `select p.*, pc.purchase_cost_jpy, pc.packaging_cost_jpy,
              pc.domestic_shipping_jpy, pc.other_direct_cost_jpy,
              pc.packed_weight_g, pc.supplier, pc.note as cost_note
       from products p left join product_costs pc on pc.item_sku=p.item_sku
       ${sqlWhere} order by p.synced_at desc, p.id desc limit 1000`,
      params
    );
    res.json({ products: result.rows });
  } catch (error) { res.status(500).json(safeError(error)); }
});
app.put('/api/products/cost/:sku', async (req, res) => {
  if (!requireDb(res)) return;
  const sku = String(req.params.sku);
  const b = req.body || {};
  try {
    const purchase = b.purchaseCostJpy;
    if (purchase === undefined || purchase === null || purchase === '') {
      return res.status(400).json({ error: true, message: '매입원가를 입력해야 합니다.' });
    }
    if (!Number.isFinite(Number(purchase)) || Number(purchase) < 0) {
      return res.status(400).json({ error: true, message: '매입원가는 0 이상의 숫자여야 합니다.' });
    }
    const result = await query(
      `insert into product_costs(
         item_sku,purchase_cost_jpy,packaging_cost_jpy,domestic_shipping_jpy,
         other_direct_cost_jpy,packed_weight_g,supplier,note,updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
       on conflict (item_sku) do update set
         purchase_cost_jpy=excluded.purchase_cost_jpy,
         packaging_cost_jpy=excluded.packaging_cost_jpy,
         domestic_shipping_jpy=excluded.domestic_shipping_jpy,
         other_direct_cost_jpy=excluded.other_direct_cost_jpy,
         packed_weight_g=excluded.packed_weight_g,
         supplier=excluded.supplier,note=excluded.note,updated_at=now()
       returning *`,
      [
        sku, Number(b.purchaseCostJpy), Number(b.packagingCostJpy || 0),
        Number(b.domesticShippingJpy || 0), Number(b.otherDirectCostJpy || 0),
        b.packedWeightG == null || b.packedWeightG === '' ? null : Number(b.packedWeightG),
        b.supplier || null, b.note || null
      ]
    );
    const affected = await query(
      `select distinct oi.order_sn from order_items oi
       join settlements s on s.order_sn=oi.order_sn where oi.item_sku=$1 order by oi.order_sn`,
      [sku]
    );
    const recalculated = [];
    for (const row of affected.rows) {
      try {
        const profit = await calculateProfit(String(row.order_sn));
        recalculated.push({ orderSn: row.order_sn, ok: true, costComplete: profit.missingCostSkus.length === 0, missingCostSkus: profit.missingCostSkus });
      } catch (error) { recalculated.push({ orderSn: row.order_sn, ok: false, message: error.message }); }
    }
    res.json({
      message: '상품 원가를 저장하고 관련 주문 수익을 다시 계산했습니다.',
      cost: result.rows[0],
      recalculation: {
        affectedOrders: affected.rowCount,
        recalculated: recalculated.length,
        complete: recalculated.filter(x => x.ok && x.costComplete).length,
        pending: recalculated.filter(x => x.ok && !x.costComplete).length,
        errors: recalculated.filter(x => !x.ok).length,
        orders: recalculated
      }
    });
  } catch (error) { res.status(500).json(safeError(error)); }
});

/* Orders / Profit */
app.get('/api/orders', async (req, res) => {
  if (!requireDb(res)) return;
  const params = [];
  const where = [];
  if (req.query.market) { params.push(String(req.query.market)); where.push(`market_code=$${params.length}`); }
  if (req.query.status) { params.push(String(req.query.status)); where.push(`order_status=$${params.length}`); }
  const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);
  params.push(limit);
  const sqlWhere = where.length ? `where ${where.join(' and ')}` : '';
  try {
    const result = await query(
      `select *, case order_status
        when 'UNPAID' then '결제 대기'
        when 'READY_TO_SHIP' then '배송 준비 중'
        when 'PROCESSED' then '출고 처리됨'
        when 'SHIPPED' then '배송 중'
        when 'TO_CONFIRM_RECEIVE' then '수령 확인 대기'
        when 'COMPLETED' then '완료'
        when 'IN_CANCEL' then '취소 처리 중'
        when 'CANCELLED' then '취소'
        else order_status end as order_status_ko
       from orders ${sqlWhere}
       order by created_time_shopee desc nulls last, id desc limit $${params.length}`,
      params
    );
    res.json({ orders: result.rows });
  } catch (error) { res.status(500).json(safeError(error)); }
});
app.get('/api/orders/:orderSn', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const orderSn = String(req.params.orderSn);
    const order = await query(`select * from orders where order_sn=$1`, [orderSn]);
    if (!order.rowCount) return res.status(404).json({ error: true, message: '주문을 찾을 수 없습니다.' });
    const items = await query(
      `select oi.*, pc.purchase_cost_jpy, pc.packaging_cost_jpy,
              pc.domestic_shipping_jpy, pc.other_direct_cost_jpy, pc.packed_weight_g,
              inv.on_hand_qty
       from order_items oi
       left join product_costs pc on pc.item_sku=oi.item_sku
       left join lateral (
         select coalesce(sum(im.quantity_delta),0)::int as on_hand_qty
         from inventory_movements im where im.item_sku=oi.item_sku
       ) inv on true
       where oi.order_sn=$1 order by oi.id`,
      [orderSn]
    );
    const settlement = await query(`select * from settlements where order_sn=$1`, [orderSn]);
    const profit = await query(`select * from profit_snapshots where order_sn=$1 order by calculated_at desc limit 1`, [orderSn]);
    const missingCostSkus = items.rows
      .filter(item => !item.item_sku || item.purchase_cost_jpy === null || item.purchase_cost_jpy === undefined)
      .map(item => item.item_sku || String(item.item_id));
    res.json({
      order: { ...order.rows[0], order_status_ko: orderStatusKo(order.rows[0].order_status) },
      items: items.rows,
      settlement: settlement.rows[0] || null,
      profit: profit.rows[0] || null,
      costComplete: missingCostSkus.length === 0,
      missingCostSkus: [...new Set(missingCostSkus)]
    });
  } catch (error) { res.status(500).json(safeError(error)); }
});
app.get('/api/profits', async (req, res) => {
  if (!requireDb(res)) return;
  const params = [];
  const where = [];
  if (req.query.market) { params.push(String(req.query.market)); where.push(`o.market_code=$${params.length}`); }
  const sqlWhere = where.length ? `where ${where.join(' and ')}` : '';
  try {
    const result = await query(
      `select ps.*, o.market_code, o.currency, o.order_status, o.created_time_shopee,
              not exists (
                select 1 from order_items oi
                left join product_costs pc on pc.item_sku=oi.item_sku
                where oi.order_sn=ps.order_sn and (oi.item_sku is null or pc.purchase_cost_jpy is null)
              ) as cost_complete
       from profit_snapshots ps join orders o on o.order_sn=ps.order_sn
       ${sqlWhere}
       order by o.created_time_shopee desc nulls last, ps.calculated_at desc limit 1000`,
      params
    );
    res.json({ profits: result.rows });
  } catch (error) { res.status(500).json(safeError(error)); }
});
app.get('/api/dashboard', async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    const [shops, ordersToday, profit30, markets, inventory] = await Promise.all([
      query(`select count(*)::int as n from shopee_connections where status='CONNECTED'`),
      query(`select count(*)::int as orders, coalesce(sum(total_amount*fx_jpy_per),0)::numeric as sales_jpy
             from orders where created_time_shopee >= date_trunc('day',now())`),
      query(`select coalesce(sum(ps.actual_profit_jpy),0)::numeric as profit_jpy
             from profit_snapshots ps join orders o on o.order_sn=ps.order_sn
             where o.created_time_shopee >= now()-interval '30 days'
               and not exists (
                 select 1 from order_items oi
                 left join product_costs pc on pc.item_sku=oi.item_sku
                 where oi.order_sn=ps.order_sn and (oi.item_sku is null or pc.purchase_cost_jpy is null)
               )`),
      query(`select market_code, count(*)::int as orders,
                    coalesce(sum(total_amount*fx_jpy_per),0)::numeric as sales_jpy
             from orders group by market_code order by market_code`),
      getInventorySummary()
    ]);
    res.json({
      connectedShops: shops.rows[0].n,
      todayOrders: ordersToday.rows[0].orders,
      todaySalesJpy: Number(ordersToday.rows[0].sales_jpy || 0),
      profit30DaysJpy: Number(profit30.rows[0].profit_jpy || 0),
      profit30DaysBasis: 'order_created_time',
      marketSummary: markets.rows,
      inventory
    });
  } catch (error) { res.status(500).json(safeError(error)); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json(safeError(error));
});


app.listen(port, async () => {
  console.log(`JAPANOVA Seller OS Backend 시작: http://localhost:${port}`);
  try {
    const diag = await diagnosePartnerCredentialHosts();
    console.log('JAPANOVA Shopee partner 진단:', JSON.stringify(diag));
  } catch (error) {
    console.warn('JAPANOVA Shopee partner 진단 실패:', error.message);
  }
});
