import 'dotenv/config';
import { pool, query } from './db.js';
import { MARKETS } from './config.js';
import { decryptSecret, encryptSecret } from './tokenCrypto.js';
import { getShopApi, refreshAccessToken, ShopeePaths } from './services/shopee.js';
import {
  syncOrders,
  syncProductList,
  syncSettlement
} from './services/sync.js';

const enabled = String(process.env.BOOTSTRAP_SYNC_ON_START || '').trim().toLowerCase();
const shouldRun = ['1', 'true', 'yes', 'on'].includes(enabled);

if (!process.env.DATABASE_URL || !shouldRun) {
  console.log('JAPANOVA 시작 동기화 건너뜀');
  await pool.end();
  process.exit(0);
}

async function issueShopScopedToken(shopId) {
  const saved = await query(
    `select refresh_token_encrypted from shopee_connections where shop_id=$1`,
    [shopId]
  );
  if (!saved.rowCount || !saved.rows[0].refresh_token_encrypted) {
    throw new Error('Shop 전용 Access Token 발급에 필요한 Refresh Token이 없습니다.');
  }

  const currentRefreshToken = decryptSecret(saved.rows[0].refresh_token_encrypted);
  const token = await refreshAccessToken({
    refreshToken: currentRefreshToken,
    shopId
  });
  const nextRefreshToken = token.refresh_token || currentRefreshToken;
  const accessExpiresAt = new Date(Date.now() + Number(token.expire_in || 14400) * 1000);
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await query(
    `update shopee_connections
     set access_token_encrypted=$2,
         refresh_token_encrypted=$3,
         access_token_expires_at=$4,
         refresh_token_expires_at=$5,
         status='CONNECTED',
         updated_at=now()
     where shop_id=$1`,
    [
      shopId,
      encryptSecret(token.access_token),
      encryptSecret(nextRefreshToken),
      accessExpiresAt,
      refreshExpiresAt
    ]
  );

  return token.access_token;
}

async function hydrateShopConnection(shopId) {
  const accessToken = await issueShopScopedToken(shopId);
  const raw = await getShopApi(ShopeePaths.shopInfo, {
    shopId,
    accessToken
  });
  const info = raw?.response && typeof raw.response === 'object' ? raw.response : raw;
  const marketCode = info?.region && MARKETS[info.region] ? info.region : null;

  await query(
    `update shopee_connections
     set market_code=coalesce($2, market_code),
         shop_name=coalesce($3, shop_name),
         merchant_id=coalesce($4, merchant_id),
         updated_at=now()
     where shop_id=$1`,
    [
      shopId,
      marketCode,
      info?.shop_name || null,
      info?.merchant_id ? Number(info.merchant_id) : null
    ]
  );

  return {
    accessToken,
    marketCode,
    shopName: info?.shop_name || null,
    merchantId: info?.merchant_id ? Number(info.merchant_id) : null
  };
}

try {
  const connections = await query(
    `select shop_id from shopee_connections
     where status='CONNECTED'
     order by shop_id`
  );

  if (!connections.rowCount) {
    console.log('JAPANOVA 시작 동기화: 연결된 Shopee Shop 없음');
  }

  for (const row of connections.rows) {
    const shopId = Number(row.shop_id);
    try {
      const hydrated = await hydrateShopConnection(shopId);
      console.log(`JAPANOVA Shop 확인 완료: ${shopId} ${hydrated.marketCode || '미확인'} ${hydrated.shopName || ''}`);

      const products = await syncProductList(shopId);
      const orders = await syncOrders(shopId, { days: 15 });

      let settlements = 0;
      for (const orderSn of orders.orderSns || []) {
        try {
          await syncSettlement(shopId, orderSn, hydrated.accessToken);
          settlements += 1;
        } catch (error) {
          console.warn(`JAPANOVA 정산 동기화 건너뜀 ${orderSn}: ${error.message}`);
        }
      }

      console.log(
        `JAPANOVA 시작 동기화 완료: shop=${shopId} products=${products.synced} orders=${orders.synced} settlements=${settlements}`
      );
    } catch (error) {
      console.warn(`JAPANOVA 시작 동기화 실패 shop=${shopId}: ${error.message}`);
    }
  }
} catch (error) {
  console.warn(`JAPANOVA 시작 동기화 전체 실패: ${error.message}`);
} finally {
  await pool.end();
}
