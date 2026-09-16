import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MARKETS, orderStatusKo } from './config.js';
import { query } from './db.js';
import { encryptSecret, decryptSecret } from './tokenCrypto.js';
import { fetchFxSnapshot } from './services/fx.js';
import {
  exchangeAuthorizationCode,
  getShopApi,
  ShopeePaths
} from './services/shopee.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

app.use(cors({ origin: allowedOrigin, credentials: true }));
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
    status: '정상',
    database: db,
    shopeeEnvironment: process.env.SHOPEE_ENV || 'sandbox',
    now: new Date().toISOString()
  });
});

app.get('/api/markets', (_req, res) => {
  res.json(
    Object.entries(MARKETS).map(([code, market]) => ({
      code,
      ...market,
      connectionStatus: '미확인'
    }))
  );
});

app.get('/api/fx', async (req, res) => {
  try {
    const buffer = req.query.buffer === undefined
      ? undefined
      : Number(req.query.buffer);
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

    res.json({
      message: '환율을 새로 갱신했습니다.',
      ...snapshot
    });
  } catch (error) {
    res.status(502).json(safeError(error));
  }
});

// Shopee가 authorization 후 code와 shop_id 또는 main_account_id를 전달하는 서버용 callback.
// Production에서는 기존 GitHub Pages callback 대신 이 주소를 Redirect URI로 사용한다.
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

    const accessExpiresAt = new Date(Date.now() + Number(token.expire_in || 0) * 1000);
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
             status='CONNECTED',
             updated_at=now()`,
          [
            marketCode,
            merchantId,
            Number(id),
            shopName,
            mainAccountId ? Number(mainAccountId) : null,
            encryptSecret(token.access_token),
            encryptSecret(token.refresh_token),
            accessExpiresAt,
            refreshExpiresAt
          ]
        );
      }

      connected.push({
        shopId: Number(id),
        shopName,
        marketCode,
        marketNameKo: marketCode ? MARKETS[marketCode].nameKo : '미확인',
        merchantId
      });
    }

    res.json({
      message: 'Shopee 연결 인증이 완료되었습니다.',
      connected,
      tokenStored: hasDb(),
      // 토큰 문자열은 절대 응답하지 않는다.
      accessTokenExpiresAt: accessExpiresAt.toISOString(),
      refreshTokenExpiresAt: refreshExpiresAt.toISOString()
    });
  } catch (error) {
    res.status(502).json(safeError(error));
  }
});

app.get('/api/shopee/connections', async (_req, res) => {
  if (!hasDb()) {
    return res.json({
      message: 'DATABASE_URL이 아직 설정되지 않았습니다.',
      connections: []
    });
  }
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
  if (!hasDb()) {
    return res.status(503).json({ error: true, message: 'DB 설정이 필요합니다.' });
  }
  try {
    const id = Number(req.params.shopId);
    const saved = await query(
      `select shop_id, access_token_encrypted
       from shopee_connections where shop_id=$1`,
      [id]
    );
    if (!saved.rowCount) {
      return res.status(404).json({ error: true, message: '연결된 Shop을 찾을 수 없습니다.' });
    }
    const accessToken = decryptSecret(saved.rows[0].access_token_encrypted);
    const data = await getShopApi(ShopeePaths.shopInfo, { shopId: id, accessToken });
    res.json({
      ...data,
      statusKo: orderStatusKo(data.status)
    });
  } catch (error) {
    res.status(502).json(safeError(error));
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json(safeError(error));
});

app.listen(port, () => {
  console.log(`JAPANOVA Seller OS Backend 시작: http://localhost:${port}`);
});
