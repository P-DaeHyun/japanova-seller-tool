import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';

function cleanSku(value) {
  const sku = String(value || '').trim();
  if (!sku) throw new Error('SKU가 필요합니다.');
  return sku;
}

function nonNegativeInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name}은 0 이상의 정수여야 합니다.`);
  }
  return n;
}

function optionalNonNegativeInt(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return nonNegativeInt(value, name);
}

function optionalNonNegativeNumber(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name}은 0 이상의 숫자여야 합니다.`);
  }
  return n;
}

export async function getInventoryList({ search = '', lowOnly = false } = {}) {
  const q = String(search || '').trim();
  const params = [];
  let filter = '';
  if (q) {
    params.push(`%${q}%`);
    filter = `where (
      lower(coalesce(c.item_sku,'')) like lower($${params.length})
      or lower(coalesce(c.item_name,'')) like lower($${params.length})
      or lower(coalesce(i.supplier,'')) like lower($${params.length})
    )`;
  }

  const result = await query(
    `with catalog as (
       select
         item_sku,
         max(item_name) as item_name,
         string_agg(distinct market_code, ',' order by market_code) as markets,
         max(stock) as shopee_stock
       from products
       where item_sku is not null and btrim(item_sku) <> ''
       group by item_sku
     ),
     movements as (
       select item_sku,
              coalesce(sum(quantity_delta),0)::int as on_hand_qty,
              max(created_at) as last_movement_at
       from inventory_movements
       group by item_sku
     ),
     base as (
       select
         coalesce(c.item_sku, i.item_sku, m.item_sku) as item_sku,
         c.item_name,
         c.markets,
         c.shopee_stock,
         coalesce(m.on_hand_qty,0)::int as on_hand_qty,
         coalesce(i.safety_stock_qty,0)::int as safety_stock_qty,
         coalesce(i.target_stock_qty,0)::int as target_stock_qty,
         i.supplier,
         i.supplier_url,
         i.lead_time_days,
         i.note,
         i.tracking_started_at,
         i.updated_at,
         m.last_movement_at,
         pc.purchase_cost_jpy,
         case
           when i.tracking_started_at is null then 'UNTRACKED'
           when coalesce(m.on_hand_qty,0) <= 0 then 'OUT'
           when coalesce(i.target_stock_qty,0) > 0
             and coalesce(m.on_hand_qty,0) <= coalesce(i.safety_stock_qty,0) then 'LOW'
           else 'OK'
         end as stock_status,
         (
           i.tracking_started_at is not null
           and coalesce(i.target_stock_qty,0) > 0
           and coalesce(m.on_hand_qty,0) <= coalesce(i.safety_stock_qty,0)
         ) as needs_reorder,
         case
           when i.tracking_started_at is not null
             and coalesce(i.target_stock_qty,0) > 0
             and coalesce(m.on_hand_qty,0) <= coalesce(i.safety_stock_qty,0)
           then greatest(coalesce(i.target_stock_qty,0)-coalesce(m.on_hand_qty,0),0)::int
           else 0
         end as reorder_qty,
         round((coalesce(m.on_hand_qty,0) * coalesce(pc.purchase_cost_jpy,0))::numeric,2) as stock_value_jpy
       from catalog c
       full join inventory_items i on i.item_sku=c.item_sku
       full join movements m on m.item_sku=coalesce(c.item_sku,i.item_sku)
       left join product_costs pc on pc.item_sku=coalesce(c.item_sku,i.item_sku,m.item_sku)
     )
     select * from base
     ${filter}
     ${lowOnly ? (filter ? `and needs_reorder` : `where needs_reorder`) : ''}
     order by
       case stock_status when 'OUT' then 0 when 'LOW' then 1 when 'UNTRACKED' then 2 else 3 end,
       item_name nulls last, item_sku`,
    params
  );
  return result.rows;
}

export async function getInventorySummary() {
  const result = await query(
    `with movements as (
       select item_sku, coalesce(sum(quantity_delta),0)::int as on_hand_qty
       from inventory_movements group by item_sku
     ),
     base as (
       select
         i.item_sku,
         coalesce(m.on_hand_qty,0)::int as on_hand_qty,
         coalesce(i.safety_stock_qty,0)::int as safety_stock_qty,
         coalesce(i.target_stock_qty,0)::int as target_stock_qty,
         coalesce(pc.purchase_cost_jpy,0)::numeric as purchase_cost_jpy,
         case
           when coalesce(m.on_hand_qty,0) <= 0 then 'OUT'
           when coalesce(i.target_stock_qty,0) > 0
             and coalesce(m.on_hand_qty,0) <= coalesce(i.safety_stock_qty,0) then 'LOW'
           else 'OK'
         end as stock_status,
         (
           coalesce(i.target_stock_qty,0) > 0
           and coalesce(m.on_hand_qty,0) <= coalesce(i.safety_stock_qty,0)
         ) as needs_reorder
       from inventory_items i
       left join movements m on m.item_sku=i.item_sku
       left join product_costs pc on pc.item_sku=i.item_sku
       where i.tracking_started_at is not null
     )
     select
       count(*)::int as tracked_skus,
       count(*) filter (where needs_reorder)::int as low_stock_skus,
       coalesce(sum(on_hand_qty),0)::int as on_hand_units,
       coalesce(sum(
         case when needs_reorder
           then greatest(target_stock_qty-on_hand_qty,0) else 0 end
       ),0)::int as reorder_units,
       coalesce(sum(on_hand_qty*purchase_cost_jpy),0)::numeric as stock_value_jpy
     from base`
  );
  const row = result.rows[0] || {};
  return {
    trackedSkus: Number(row.tracked_skus || 0),
    lowStockSkus: Number(row.low_stock_skus || 0),
    onHandUnits: Number(row.on_hand_units || 0),
    reorderUnits: Number(row.reorder_units || 0),
    stockValueJpy: Number(row.stock_value_jpy || 0)
  };
}

export async function getInventoryMovements(sku, { limit = 100 } = {}) {
  const clean = cleanSku(sku);
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await query(
    `select id,item_sku,quantity_delta,movement_type,source_key,order_sn,
            unit_purchase_cost_jpy,supplier,note,created_at
     from inventory_movements
     where item_sku=$1
     order by created_at desc,id desc
     limit $2`,
    [clean, n]
  );
  return result.rows;
}

export async function setInventoryItem(sku, payload = {}) {
  const clean = cleanSku(sku);
  const onHandQty = payload.onHandQty === undefined ? null : nonNegativeInt(payload.onHandQty, '현재고');
  const safetyStockQty = optionalNonNegativeInt(payload.safetyStockQty, '안전재고');
  const targetStockQty = optionalNonNegativeInt(payload.targetStockQty, '목표재고');
  const leadTimeDays = optionalNonNegativeInt(payload.leadTimeDays, '리드타임');
  const supplier = payload.supplier === undefined ? null : String(payload.supplier || '').trim() || null;
  const supplierUrl = payload.supplierUrl === undefined ? null : String(payload.supplierUrl || '').trim() || null;
  const note = payload.note === undefined ? null : String(payload.note || '').trim() || null;

  return withTransaction(async (client) => {
    const existing = await client.query(
      `select * from inventory_items where item_sku=$1 for update`,
      [clean]
    );

    if (!existing.rowCount) {
      await client.query(
        `insert into inventory_items(
           item_sku,safety_stock_qty,target_stock_qty,supplier,supplier_url,
           lead_time_days,note,tracking_started_at,updated_at
         ) values ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
        [
          clean,
          safetyStockQty ?? 0,
          targetStockQty ?? 0,
          supplier,
          supplierUrl,
          leadTimeDays,
          note
        ]
      );
    } else {
      await client.query(
        `update inventory_items set
           safety_stock_qty=coalesce($2,safety_stock_qty),
           target_stock_qty=coalesce($3,target_stock_qty),
           supplier=case when $4::boolean then $5 else supplier end,
           supplier_url=case when $6::boolean then $7 else supplier_url end,
           lead_time_days=case when $8::boolean then $9 else lead_time_days end,
           note=case when $10::boolean then $11 else note end,
           tracking_started_at=coalesce(tracking_started_at,now()),
           updated_at=now()
         where item_sku=$1`,
        [
          clean,
          safetyStockQty,
          targetStockQty,
          payload.supplier !== undefined, supplier,
          payload.supplierUrl !== undefined, supplierUrl,
          payload.leadTimeDays !== undefined, leadTimeDays,
          payload.note !== undefined, note
        ]
      );
    }

    let adjustment = 0;
    if (onHandQty !== null) {
      const current = await client.query(
        `select coalesce(sum(quantity_delta),0)::int as qty
         from inventory_movements where item_sku=$1`,
        [clean]
      );
      const currentQty = Number(current.rows[0]?.qty || 0);
      adjustment = onHandQty - currentQty;
      if (adjustment !== 0) {
        await client.query(
          `insert into inventory_movements(
             item_sku,quantity_delta,movement_type,source_key,note
           ) values ($1,$2,'MANUAL_ADJUST',$3,$4)`,
          [
            clean,
            adjustment,
            `manual:${clean}:${randomUUID()}`,
            `현재고를 ${onHandQty}개로 조정`
          ]
        );
      }
    }

    const item = await client.query(
      `select * from inventory_items where item_sku=$1`,
      [clean]
    );
    const stock = await client.query(
      `select coalesce(sum(quantity_delta),0)::int as qty
       from inventory_movements where item_sku=$1`,
      [clean]
    );

    return {
      item: item.rows[0],
      onHandQty: Number(stock.rows[0]?.qty || 0),
      adjustment
    };
  });
}

export async function receiveInventory(sku, payload = {}) {
  const clean = cleanSku(sku);
  const quantity = Number(payload.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('입고수량은 1 이상의 정수여야 합니다.');
  }
  const unitPurchaseCostJpy = optionalNonNegativeNumber(payload.unitPurchaseCostJpy, '매입단가');
  const supplier = String(payload.supplier || '').trim() || null;
  const supplierUrl = String(payload.supplierUrl || '').trim() || null;
  const note = String(payload.note || '').trim() || null;

  return withTransaction(async (client) => {
    await client.query(
      `insert into inventory_items(
         item_sku,supplier,supplier_url,tracking_started_at,updated_at
       ) values ($1,$2,$3,now(),now())
       on conflict (item_sku) do update set
         supplier=coalesce(excluded.supplier,inventory_items.supplier),
         supplier_url=coalesce(excluded.supplier_url,inventory_items.supplier_url),
         tracking_started_at=coalesce(inventory_items.tracking_started_at,now()),
         updated_at=now()`,
      [clean, supplier, supplierUrl]
    );

    const movement = await client.query(
      `insert into inventory_movements(
         item_sku,quantity_delta,movement_type,source_key,
         unit_purchase_cost_jpy,supplier,note
       ) values ($1,$2,'PURCHASE_RECEIPT',$3,$4,$5,$6)
       returning *`,
      [
        clean,
        quantity,
        `receipt:${clean}:${randomUUID()}`,
        unitPurchaseCostJpy,
        supplier,
        note
      ]
    );

    if (unitPurchaseCostJpy !== null) {
      await client.query(
        `insert into product_costs(item_sku,purchase_cost_jpy,supplier,updated_at)
         values ($1,$2,$3,now())
         on conflict (item_sku) do update set
           purchase_cost_jpy=excluded.purchase_cost_jpy,
           supplier=coalesce(excluded.supplier,product_costs.supplier),
           updated_at=now()`,
        [clean, unitPurchaseCostJpy, supplier]
      );
    }

    const stock = await client.query(
      `select coalesce(sum(quantity_delta),0)::int as qty
       from inventory_movements where item_sku=$1`,
      [clean]
    );

    return {
      movement: movement.rows[0],
      onHandQty: Number(stock.rows[0]?.qty || 0),
      purchaseCostUpdated: unitPurchaseCostJpy !== null
    };
  });
}
