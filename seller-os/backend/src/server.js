import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MARKETS, orderStatusKo } from './config.js';
import { query } from './db.js';
import { encryptSecret, decryptSecret } from './tokenCrypto.js';
import { fetchFxSnapshot } from './services/fx.js';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  getShopApi,
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

const app = express();
const port = Number(process.env.PORT || 8787);
const allowedOrigins = String(process.env.ALLOWED_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('허용되지 않은 Origin입니다.'));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

function hasDb() {
  return Boolean(process.env.DATABASE_URL);
}

function safeError(error) {
  return {
    error: true,
    message: error?.message || '알 수 없는 오류가 발생했습니다.'
  };
}

function requireDb(res) {
  if (hasDb()) return true;
  res.status(503).json({ error: true, message: 'DATABASE_URL 설정이 필요합니다.' });
  return false;
}

app.get('/api/health', async (_req, res) => {
  let db = '미설정';
  if (hasDb()) {
    try {
      await query('select 1');
      db = '정상';
    } catch {
      db = '오류';
    }
  }
  res.json({
    service: 'JAPANOVA Seller OS Backend',
    version: '0.2.0',
    status: '정상',
    database: db,
    shopeeEnvironment: process.env.SHOPEE_ENV || 'sandbox',
    markets: Object.keys(MARKETS),
    now: new Date().toISOString()
  });
});

app.get('/api/markets', async (_req, res) => {
  let connectionMap = {};
  if (hasDb()) {
    const result = await query(
      `select market_code, count(*)::int as shops,
              max(last_sync_at) as last_sync_at
       from shopee_connections
       where status='CONNECTED'
       group by market_code`
    );
    connectionMap = Object.fromEntries(result.rows.map((r) => [r.market_code, r]));
  }

  res.json(
    Object.entries(MARKETS).map(([code, market]) => ({
      code,
      ...market,
      connectionStatus: connectionMap[code] ? '연결됨' : (market.futureMarket ? '향후 입점' : '미연동'),
      connectedShops: connectionMap[code]?.shops || 0,
      lastSyncAt: connectionMap[code]?.last_sync_at || null
    }))
  );
});

app.get('/api/fx', async (req, res) => {
  try {
    const buffer = req.query.buffer === undefined ? undefined : Number(req.query.buffer);
    const snapshot = await fetchFxSnapshot({ buffer });
    res.json(snapshot);
  } catch (error) {
    res.status(502).json(safeError(error));
  }
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
  } catch (error) {
    res.status(502).json(safeError(error));
  }
});

app.get('/api/shopee/authorize-url', (_req, res) => {
  try {
    const url = buildAuthorizationUrl();
    res.json({
      message: 'Shopee Sandbox 인증 URL을 생성했습니다.',
      environment: process.env.SHOPEE_ENV || 'sandbox',
      redirectUri: process.env.SHOPEE_REDIRECT_URI || null,
      url
    });
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

app.get('/api/shopee/authorize', (_req, res) => {
  try {
    res.redirect(buildAuthorizationUrl());
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

// Shopee Authorization callback. 토큰은 서버에서 교환/암호화 저장하고 브라우저에는 반환하지 않는다.
app.get('/api/shopee/callback', async (req, res) => {
  const { code, shop_id: shopId, main_account_id: mainAccountId } = req.query;
  if (!code || (!shopId && !mainAccountId)) {
    return res.status(400).json({
      error: true,
      message: 'Shopee 인증 code와 shop_id 또는 main_account_id가 필요합니다.'
    });
  }

  try {
    const token = await exchangeAuthorizationCode({
      code: String(code),
      shopId: shopId ? Number(shopId) : undefined,
      mainAccountId: mainAccountId ? Number(mainAccountId) : undefined
    });

    const shopIds = token.shop_id_list?.length
      ? token.shop_id_list
      : (shopId ? [Number(shopId)] : []);

    const accessExpiresAt = new Date(Date.now() + Number(token.expire_in || 14400) * 1000);
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const connected = [];

    for (const id of shopIds) {
      let info = null;
      try {
        info = await getShopApi(ShopeePaths.shopInfo, {
          shopId: Number(id),
          accessToken: token.access_token
        });
      } catch (error) {
        console.warn('Shop info lookup failed', id, error.message);
      }

      const region = info?.region || null;
      const marketCode = region && MARKETS[region] ? region : null;
      const shopName = info?.shop_name || null;
      const merchantId = info?.merchant_id || token.merchant_id_list?.[0] || null;

      if (hasDb()) {
        await query(
          `insert into shopee_connections(
             market_code, merchant_id, shop_id, shop_name, main_account_id,
             access_token_encrypted, refresh_token_encrypted,
             access_token_expires_at, refresh_token_expires_at, status, updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CONNECTED',now())
           on conflict (shop_id) do update set
             market_code=excluded.market_code,
             merchant_id=excluded.merchant_id,
             shop_name=excluded.shop_name,
             main_account_id=excluded.main_account_id,
             access_token_encrypted=excluded.access_token_encrypted,
             refresh_token_encrypted=excluded.refresh_token_encrypted,
             access_token_expires_at=excluded.access_token_expires_at,
             refresh_token_expires_at=excluded.refresh_token_expires_at,
             status='CONNECTED', updated_at=now()`,
          [
            marketCode, merchantId, Number(id), shopName,
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

    res.json({
      message: 'Shopee 연결 인증이 완료되었습니다.',
      connected,
      tokenStored: hasDb(),
      accessTokenExpiresAt: accessExpiresAt.toISOString(),
      refreshTokenExpiresAt: refreshExpiresAt.toISOString()
    });
  } catch (error) {
    res.status(502).json(safeError(error));
  }
});

app.get('/api/shopee/connections', async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    const result = await query(
      `select market_code, merchant_id, shop_id, shop_name, main_account_id,
              authorization_expires_at, access_token_expires_at,
              refresh_token_expires_at, status, last_sync_at, updated_at
       from shopee_connections
       order by market_code nulls last, shop_id`
    );
    res.json({ connections: result.rows });
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

app.get('/api/shopee/shop/:shopId', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const id = Number(req.params.shopId);
    const auth = await getValidAccessToken(id);
    const data = await getShopApi(ShopeePaths.shopInfo, {
      shopId: id,
      accessToken: auth.accessToken
    });
    res.json({ ...data, tokenRefreshed: auth.refreshed });
  } catch (error) {
    res.status(502).json(safeError(error));
  }
});

app.post('/api/shopee/refresh-token/:shopId', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const auth = await getValidAccessToken(Number(req.params.shopId));
    res.json({ message: auth.refreshed ? 'Access Token을 갱신했습니다.' : '현재 Access Token이 아직 유효합니다.' });
  } catch (error) {
    res.status(502).json(safeError(error));
  }
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
  } catch (error) {
    return res.status(502).json(safeError(error));
  }
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
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

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
              pc.domestic_shipping_jpy, pc.other_direct_cost_jpy, pc.packed_weight_g
       from products p left join product_costs pc on pc.item_sku=p.item_sku
       ${sqlWhere}
       order by p.synced_at desc, p.id desc limit 1000`,
      params
    );
    res.json({ products: result.rows });
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

app.put('/api/products/cost/:sku', async (req, res) => {
  if (!requireDb(res)) return;
  const sku = String(req.params.sku);
  const b = req.body || {};
  try {
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
        sku, Number(b.purchaseCostJpy || 0), Number(b.packagingCostJpy || 0),
        Number(b.domesticShippingJpy || 0), Number(b.otherDirectCostJpy || 0),
        b.packedWeightG == null ? null : Number(b.packedWeightG),
        b.supplier || null, b.note || null
      ]
    );
    res.json({ message: '상품 원가를 저장했습니다.', cost: result.rows[0] });
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

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
       order by created_time_shopee desc nulls last, id desc
       limit $${params.length}`,
      params
    );
    res.json({ orders: result.rows });
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

app.get('/api/orders/:orderSn', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const orderSn = String(req.params.orderSn);
    const order = await query(`select * from orders where order_sn=$1`, [orderSn]);
    if (!order.rowCount) return res.status(404).json({ error: true, message: '주문을 찾을 수 없습니다.' });
    const items = await query(`select * from order_items where order_sn=$1 order by id`, [orderSn]);
    const settlement = await query(`select * from settlements where order_sn=$1`, [orderSn]);
    const profit = await query(`select * from profit_snapshots where order_sn=$1 order by calculated_at desc limit 1`, [orderSn]);
    res.json({
      order: { ...order.rows[0], order_status_ko: orderStatusKo(order.rows[0].order_status) },
      items: items.rows,
      settlement: settlement.rows[0] || null,
      profit: profit.rows[0] || null
    });
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

app.get('/api/profits', async (req, res) => {
  if (!requireDb(res)) return;
  const params = [];
  const where = [];
  if (req.query.market) { params.push(String(req.query.market)); where.push(`o.market_code=$${params.length}`); }
  const sqlWhere = where.length ? `where ${where.join(' and ')}` : '';
  try {
    const result = await query(
      `select ps.*, o.market_code, o.currency, o.order_status, o.created_time_shopee
       from profit_snapshots ps join orders o on o.order_sn=ps.order_sn
       ${sqlWhere}
       order by ps.calculated_at desc limit 1000`,
      params
    );
    res.json({ profits: result.rows });
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

app.get('/api/dashboard', async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    const [shops, ordersToday, profit30, markets] = await Promise.all([
      query(`select count(*)::int as n from shopee_connections where status='CONNECTED'`),
      query(`select count(*)::int as orders, coalesce(sum(total_amount*fx_jpy_per),0)::numeric as sales_jpy
             from orders where created_time_shopee >= date_trunc('day',now())`),
      query(`select coalesce(sum(actual_profit_jpy),0)::numeric as profit_jpy
             from profit_snapshots where calculated_at >= now()-interval '30 days'`),
      query(`select market_code, count(*)::int as orders,
                    coalesce(sum(total_amount*fx_jpy_per),0)::numeric as sales_jpy
             from orders group by market_code order by market_code`)
    ]);
    res.json({
      connectedShops: shops.rows[0].n,
      todayOrders: ordersToday.rows[0].orders,
      todaySalesJpy: Number(ordersToday.rows[0].sales_jpy || 0),
      profit30DaysJpy: Number(profit30.rows[0].profit_jpy || 0),
      marketSummary: markets.rows
    });
  } catch (error) {
    res.status(500).json(safeError(error));
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json(safeError(error));
});

app.listen(port, () => {
  console.log(`JAPANOVA Seller OS Backend 시작: http://localhost:${port}`);
});
