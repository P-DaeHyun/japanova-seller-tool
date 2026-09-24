import { query, withTransaction } from '../db.js';
import { decryptSecret, encryptSecret } from '../tokenCrypto.js';
import { fetchFxSnapshot } from './fx.js';
import {
  getShopApi,
  refreshAccessToken,
  ShopeePaths
} from './shopee.js';

const ACCESS_TOKEN_SAFETY_MS = 5 * 60 * 1000;
const DEFAULT_PAYONEER_RATE = Number(process.env.PAYONEER_RATE || 0.02);

function shopeeEnvironment(){ return String(process.env.SHOPEE_ENV || 'sandbox').trim().toLowerCase(); }

function unixToDate(value) {
  const n = Number(value || 0);
  return n > 0 ? new Date(n * 1000) : null;
}

async function connection(shopId) {
  const result = await query(
    `select * from shopee_connections where shop_id=$1 and environment=$2`,
    [Number(shopId), shopeeEnvironment()]
  );
  if (!result.rowCount) {
    throw new Error(`연결된 Shopee Shop을 찾을 수 없습니다: ${shopId}`);
  }
  return result.rows[0];
}

export async function getValidAccessToken(shopId) {
  const saved = await connection(shopId);
  const expiresAt = saved.access_token_expires_at
    ? new Date(saved.access_token_expires_at).getTime()
    : 0;

  if (saved.access_token_encrypted && expiresAt > Date.now() + ACCESS_TOKEN_SAFETY_MS) {
    return {
      accessToken: decryptSecret(saved.access_token_encrypted),
      connection: saved,
      refreshed: false
    };
  }

  if (!saved.refresh_token_encrypted) {
    throw new Error('Refresh Token이 없습니다. Shopee 재인증이 필요합니다.');
  }

  const refreshToken = decryptSecret(saved.refresh_token_encrypted);
  const token = await refreshAccessToken({
    refreshToken,
    shopId: Number(shopId),
    merchantId: saved.merchant_id ? Number(saved.merchant_id) : undefined
  });

  const newAccessToken = token.access_token;
  const newRefreshToken = token.refresh_token || refreshToken;
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
     where shop_id=$1 and environment=$6`,
    [
      Number(shopId),
      encryptSecret(newAccessToken),
      encryptSecret(newRefreshToken),
      accessExpiresAt,
      refreshExpiresAt,
      shopeeEnvironment()
    ]
  );

  return {
    accessToken: newAccessToken,
    connection: { ...saved, access_token_expires_at: accessExpiresAt },
    refreshed: true
  };
}

async function startLog(scope, shopId, marketCode) {
  const result = await query(
    `insert into sync_logs(scope, market_code, shop_id, status)
     values ($1,$2,$3,'RUNNING') returning id`,
    [scope, marketCode || null, Number(shopId)]
  );
  return result.rows[0].id;
}

async function finishLog(id, status, message) {
  await query(
    `update sync_logs set status=$2, message=$3, finished_at=now() where id=$1`,
    [id, status, String(message || '').slice(0, 4000)]
  );
}

export async function syncProductList(shopId) {
  const auth = await getValidAccessToken(shopId);
  const saved = auth.connection;
  const logId = await startLog('products', shopId, saved.market_code);
  let offset = 0;
  let synced = 0;

  try {
    for (let page = 0; page < 30; page += 1) {
      const data = await getShopApi(ShopeePaths.itemList, {
        shopId: Number(shopId),
        accessToken: auth.accessToken,
        params: {
          offset,
          page_size: 100,
          item_status: 'NORMAL'
        }
      });

      const response = data.response || {};
      const items = Array.isArray(response.item) ? response.item : [];

      for (const item of items) {
        await query(
          `insert into products(
             shop_id, market_code, item_id, item_name, item_sku, model_id,
             currency, item_status, raw_json, synced_at
           ) values ($1,$2,$3,$4,$5,0,$6,$7,$8,now())
           on conflict (shop_id,item_id,model_id) do update set
             market_code=excluded.market_code,
             item_name=coalesce(excluded.item_name,products.item_name),
             item_sku=coalesce(excluded.item_sku,products.item_sku),
             currency=coalesce(excluded.currency,products.currency),
             item_status=excluded.item_status,
             raw_json=excluded.raw_json,
             synced_at=now()`,
          [
            Number(shopId),
            saved.market_code,
            Number(item.item_id),
            item.item_name || null,
            item.item_sku || null,
            item.currency || null,
            item.item_status || 'NORMAL',
            item
          ]
        );
        synced += 1;
      }

      const hasNext = Boolean(response.has_next_page || response.more);
      if (!hasNext || items.length === 0) break;
      offset = Number(response.next_offset ?? (offset + items.length));
    }

    await query(
      `update shopee_connections set last_sync_at=now(), updated_at=now() where shop_id=$1 and environment=$2`,
      [Number(shopId), shopeeEnvironment()]
    );
    await finishLog(logId, 'SUCCESS', `상품 ${synced}건 동기화`);
    return { synced, tokenRefreshed: auth.refreshed };
  } catch (error) {
    await finishLog(logId, 'FAILED', error.message);
    throw error;
  }
}

async function saveOrderDetail({ shopId, marketCode, detail, fxSnapshot }) {
  const currency = detail.currency || fxSnapshot?.marketCurrency || null;
  const fxJpyPer = currency ? Number(fxSnapshot?.jpyPer?.[currency] || 0) || null : null;
  const firstPackage = Array.isArray(detail.package_list) ? detail.package_list[0] : null;

  await withTransaction(async (client) => {
    await client.query(
      `insert into orders(
         shop_id, market_code, order_sn, order_status, currency, total_amount,
         estimated_shipping_fee, actual_shipping_fee, shipping_carrier,
         package_number, logistics_status, created_time_shopee, updated_time_shopee,
         fx_jpy_per, fx_buffer, raw_json, synced_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
       on conflict (order_sn) do update set
         order_status=excluded.order_status,
         currency=excluded.currency,
         total_amount=excluded.total_amount,
         estimated_shipping_fee=excluded.estimated_shipping_fee,
         actual_shipping_fee=excluded.actual_shipping_fee,
         shipping_carrier=excluded.shipping_carrier,
         package_number=excluded.package_number,
         logistics_status=excluded.logistics_status,
         updated_time_shopee=excluded.updated_time_shopee,
         raw_json=excluded.raw_json,
         synced_at=now()`,
      [
        Number(shopId), marketCode, detail.order_sn, detail.order_status || null,
        currency, detail.total_amount ?? null, detail.estimated_shipping_fee ?? null,
        detail.actual_shipping_fee ?? null, detail.shipping_carrier || firstPackage?.shipping_carrier || null,
        firstPackage?.package_number || null, firstPackage?.logistics_status || null,
        unixToDate(detail.create_time), unixToDate(detail.update_time), fxJpyPer,
        Number(fxSnapshot?.fxBufferDefault ?? 0.02), detail
      ]
    );

    await client.query(`delete from order_items where order_sn=$1`, [detail.order_sn]);
    for (const item of detail.item_list || []) {
      await client.query(
        `insert into order_items(
           order_sn,item_id,model_id,item_name,item_sku,model_sku,quantity,
           selling_price,original_price,weight_kg,raw_json
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          detail.order_sn,
          Number(item.item_id),
          Number(item.model_id || 0),
          item.item_name || null,
          item.item_sku || null,
          item.model_sku || null,
          Number(item.model_quantity_purchased || item.quantity_purchased || 1),
          item.model_discounted_price ?? item.selling_price ?? null,
          item.model_original_price ?? item.original_price ?? null,
          item.weight ?? null,
          item
        ]
      );
    }
  });
}

export async function syncOrders(shopId, { days = 7 } = {}) {
  const auth = await getValidAccessToken(shopId);
  const saved = auth.connection;
  const logId = await startLog('orders', shopId, saved.market_code);
  const now = Math.floor(Date.now() / 1000);
  const from = now - Math.min(Math.max(Number(days) || 7, 1), 15) * 86400;
  const orderSns = [];
  let cursor = '';
  const fxSnapshot = await fetchFxSnapshot();

  try {
    for (let page = 0; page < 50; page += 1) {
      const data = await getShopApi(ShopeePaths.orderList, {
        shopId: Number(shopId),
        accessToken: auth.accessToken,
        params: {
          time_range_field: 'update_time',
          time_from: from,
          time_to: now,
          page_size: 50,
          cursor: cursor || undefined,
          response_optional_fields: 'order_status'
        }
      });
      const response = data.response || {};
      const list = response.order_list || [];
      for (const row of list) {
        if (row.order_sn) orderSns.push(row.order_sn);
      }
      if (!response.more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }

    const unique = [...new Set(orderSns)];
    for (let i = 0; i < unique.length; i += 20) {
      const batch = unique.slice(i, i + 20);
      const data = await getShopApi(ShopeePaths.orderDetail, {
        shopId: Number(shopId),
        accessToken: auth.accessToken,
        params: {
          order_sn_list: batch.join(','),
          response_optional_fields: 'item_list,total_amount,estimated_shipping_fee,actual_shipping_fee,shipping_carrier,package_list'
        }
      });
      for (const detail of data.response?.order_list || []) {
        await saveOrderDetail({
          shopId: Number(shopId),
          marketCode: saved.market_code,
          detail,
          fxSnapshot
        });
      }
    }

    await query(
      `update shopee_connections set last_sync_at=now(), updated_at=now() where shop_id=$1 and environment=$2`,
      [Number(shopId), shopeeEnvironment()]
    );
    await finishLog(logId, 'SUCCESS', `주문 ${unique.length}건 동기화`);
    return { synced: unique.length, orderSns: unique, tokenRefreshed: auth.refreshed };
  } catch (error) {
    await finishLog(logId, 'FAILED', error.message);
    throw error;
  }
}

export async function syncSettlement(shopId, orderSn, accessToken = null) {
  const auth = accessToken
    ? { accessToken, connection: await connection(shopId), refreshed: false }
    : await getValidAccessToken(shopId);

  const data = await getShopApi(ShopeePaths.escrowDetail, {
    shopId: Number(shopId),
    accessToken: auth.accessToken,
    params: { order_sn: orderSn }
  });

  const income = data.response?.order_income || {};
  await query(
    `insert into settlements(
       order_sn,escrow_amount,escrow_amount_after_adjustment,order_selling_price,
       buyer_paid_shipping_fee,actual_shipping_fee,final_shipping_fee,
       shopee_shipping_rebate,commission_fee,seller_transaction_fee,service_fee,
       campaign_fee,voucher_from_seller,seller_discount,withholding_tax,
       withholding_pit_tax,raw_json,synced_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
     on conflict (order_sn) do update set
       escrow_amount=excluded.escrow_amount,
       escrow_amount_after_adjustment=excluded.escrow_amount_after_adjustment,
       order_selling_price=excluded.order_selling_price,
       buyer_paid_shipping_fee=excluded.buyer_paid_shipping_fee,
       actual_shipping_fee=excluded.actual_shipping_fee,
       final_shipping_fee=excluded.final_shipping_fee,
       shopee_shipping_rebate=excluded.shopee_shipping_rebate,
       commission_fee=excluded.commission_fee,
       seller_transaction_fee=excluded.seller_transaction_fee,
       service_fee=excluded.service_fee,
       campaign_fee=excluded.campaign_fee,
       voucher_from_seller=excluded.voucher_from_seller,
       seller_discount=excluded.seller_discount,
       withholding_tax=excluded.withholding_tax,
       withholding_pit_tax=excluded.withholding_pit_tax,
       raw_json=excluded.raw_json,
       synced_at=now()`,
    [
      orderSn,
      income.escrow_amount ?? null,
      income.escrow_amount_after_adjustment ?? null,
      income.order_selling_price ?? income.order_discounted_price ?? null,
      income.buyer_paid_shipping_fee ?? null,
      income.actual_shipping_fee ?? null,
      income.final_shipping_fee ?? null,
      income.shopee_shipping_rebate ?? null,
      income.commission_fee ?? null,
      income.seller_transaction_fee ?? null,
      income.service_fee ?? null,
      income.campaign_fee ?? null,
      income.voucher_from_seller ?? null,
      income.seller_discount ?? null,
      income.withholding_tax ?? null,
      income.withholding_pit_tax ?? null,
      data.response || data
    ]
  );

  return { orderSn, income };
}

export async function calculateProfit(orderSn) {
  const orderResult = await query(
    `select o.*, s.escrow_amount, s.escrow_amount_after_adjustment, s.order_selling_price
     from orders o left join settlements s on s.order_sn=o.order_sn
     where o.order_sn=$1`,
    [orderSn]
  );
  if (!orderResult.rowCount) throw new Error('주문을 찾을 수 없습니다.');
  const order = orderResult.rows[0];
  if (!order.fx_jpy_per) throw new Error('주문 환율 스냅샷이 없습니다.');

  const itemResult = await query(
    `select oi.*, pc.purchase_cost_jpy, pc.packaging_cost_jpy,
            pc.domestic_shipping_jpy, pc.other_direct_cost_jpy
     from order_items oi
     left join product_costs pc on pc.item_sku=oi.item_sku
     where oi.order_sn=$1`,
    [orderSn]
  );

  let purchase = 0;
  let packaging = 0;
  let domestic = 0;
  let other = 0;
  let grossMerchandiseLocal = 0;
  let missingCostSkus = [];

  for (const item of itemResult.rows) {
    const qty = Number(item.quantity || 1);
    grossMerchandiseLocal += Number(item.selling_price || 0) * qty;
    if (item.purchase_cost_jpy === null || item.purchase_cost_jpy === undefined) {
      missingCostSkus.push(item.item_sku || String(item.item_id));
      continue;
    }
    purchase += Number(item.purchase_cost_jpy || 0) * qty;
    // V1에서는 상품 원가 DB의 포장/국내배송/기타비용을 '단위당 배부원가'로 해석한다.
    packaging += Number(item.packaging_cost_jpy || 0) * qty;
    domestic += Number(item.domestic_shipping_jpy || 0) * qty;
    other += Number(item.other_direct_cost_jpy || 0) * qty;
  }

  const settlementLocal = Number(
    order.escrow_amount_after_adjustment ?? order.escrow_amount ?? 0
  );
  const fx = Number(order.fx_jpy_per);
  const settlementJpy = settlementLocal * fx;
  const payoneer = settlementJpy * DEFAULT_PAYONEER_RATE;
  const profit = settlementJpy - purchase - packaging - domestic - other - payoneer;
  const salesJpy = grossMerchandiseLocal * fx;
  const margin = salesJpy > 0 ? profit / salesJpy : null;

  await query(`delete from profit_snapshots where order_sn=$1`, [orderSn]);
  await query(
    `insert into profit_snapshots(
       order_sn,shopee_settlement_local,shopee_settlement_jpy,purchase_cost_jpy,
       packaging_cost_jpy,domestic_shipping_jpy,payoneer_cost_jpy,
       other_direct_cost_jpy,actual_profit_jpy,actual_margin,fx_jpy_per
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      orderSn, settlementLocal, settlementJpy, purchase, packaging, domestic,
      payoneer, other, profit, margin, fx
    ]
  );

  return {
    orderSn,
    settlementLocal,
    settlementJpy,
    purchaseCostJpy: purchase,
    packagingCostJpy: packaging,
    domesticShippingJpy: domestic,
    payoneerCostJpy: payoneer,
    otherDirectCostJpy: other,
    actualProfitJpy: profit,
    actualMargin: margin,
    fxJpyPer: fx,
    missingCostSkus: [...new Set(missingCostSkus)]
  };
}

export async function syncAllForShop(shopId, { days = 7, includeSettlement = true } = {}) {
  const products = await syncProductList(shopId);
  const orders = await syncOrders(shopId, { days });
  let settlements = 0;
  let profits = 0;
  const auth = await getValidAccessToken(shopId);

  if (includeSettlement) {
    for (const orderSn of orders.orderSns) {
      try {
        await syncSettlement(shopId, orderSn, auth.accessToken);
        settlements += 1;
        await calculateProfit(orderSn);
        profits += 1;
      } catch (error) {
        console.warn(`정산/수익 동기화 건너뜀 ${orderSn}:`, error.message);
      }
    }
  }

  return { products: products.synced, orders: orders.synced, settlements, profits };
}
