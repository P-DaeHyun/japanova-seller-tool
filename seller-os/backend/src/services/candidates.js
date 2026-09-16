import { query } from '../db.js';

const STATUS = new Set(['RESEARCH','READY','HOLD']);

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function positiveInt(value, fallback = 1) {
  return Math.max(1, Math.floor(n(value, fallback)));
}

function cleanText(value, max = 4000) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    sourceUrl: row.source_url || '',
    supplier: row.supplier || '',
    purchaseCostJpy: Number(row.purchase_cost_jpy || 0),
    packagingCostJpy: Number(row.packaging_cost_jpy || 0),
    domesticShippingJpy: Number(row.domestic_shipping_jpy || 0),
    otherCostJpy: Number(row.other_cost_jpy || 0),
    weightG: Number(row.weight_g || 1),
    lengthCm: Number(row.length_cm || 0),
    widthCm: Number(row.width_cm || 0),
    heightCm: Number(row.height_cm || 0),
    discountPct: Number(row.discount_pct || 0),
    payoneerPct: Number(row.payoneer_pct || 0),
    fxBufferPct: Number(row.fx_buffer_pct || 0),
    targetMarginPct: Number(row.target_margin_pct || 0),
    initialUnits: Number(row.initial_units || 1),
    status: row.status,
    note: row.note || '',
    plans: row.plans && typeof row.plans === 'object' ? row.plans : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listCandidates() {
  const result = await query(
    `select * from candidate_products order by updated_at desc, created_at desc`
  );
  return result.rows.map(mapRow);
}

export async function saveCandidate(id, input = {}) {
  const candidateId = cleanText(id, 120);
  const name = cleanText(input.name, 500);
  if (!candidateId) throw new Error('후보상품 ID가 필요합니다.');
  if (!name) throw new Error('후보상품 이름이 필요합니다.');

  const purchase = n(input.purchaseCostJpy, NaN);
  if (!Number.isFinite(purchase) || purchase <= 0) {
    throw new Error('매입원가는 0보다 큰 숫자여야 합니다.');
  }

  const status = STATUS.has(String(input.status || 'RESEARCH'))
    ? String(input.status || 'RESEARCH')
    : 'RESEARCH';
  const plans = input.plans && typeof input.plans === 'object' && !Array.isArray(input.plans)
    ? input.plans
    : {};

  const result = await query(
    `insert into candidate_products(
       id,name,source_url,supplier,purchase_cost_jpy,packaging_cost_jpy,
       domestic_shipping_jpy,other_cost_jpy,weight_g,length_cm,width_cm,height_cm,
       discount_pct,payoneer_pct,fx_buffer_pct,target_margin_pct,initial_units,
       status,note,plans,created_at,updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       coalesce((select created_at from candidate_products where id=$1),now()),now()
     )
     on conflict (id) do update set
       name=excluded.name,
       source_url=excluded.source_url,
       supplier=excluded.supplier,
       purchase_cost_jpy=excluded.purchase_cost_jpy,
       packaging_cost_jpy=excluded.packaging_cost_jpy,
       domestic_shipping_jpy=excluded.domestic_shipping_jpy,
       other_cost_jpy=excluded.other_cost_jpy,
       weight_g=excluded.weight_g,
       length_cm=excluded.length_cm,
       width_cm=excluded.width_cm,
       height_cm=excluded.height_cm,
       discount_pct=excluded.discount_pct,
       payoneer_pct=excluded.payoneer_pct,
       fx_buffer_pct=excluded.fx_buffer_pct,
       target_margin_pct=excluded.target_margin_pct,
       initial_units=excluded.initial_units,
       status=excluded.status,
       note=excluded.note,
       plans=excluded.plans,
       updated_at=now()
     returning *`,
    [
      candidateId,
      name,
      cleanText(input.sourceUrl, 2000),
      cleanText(input.supplier, 500),
      purchase,
      Math.max(0, n(input.packagingCostJpy)),
      Math.max(0, n(input.domesticShippingJpy)),
      Math.max(0, n(input.otherCostJpy)),
      positiveInt(input.weightG),
      Math.max(0, n(input.lengthCm)),
      Math.max(0, n(input.widthCm)),
      Math.max(0, n(input.heightCm)),
      Math.min(95, Math.max(0, n(input.discountPct))),
      Math.min(50, Math.max(0, n(input.payoneerPct, 2))),
      Math.min(30, Math.max(0, n(input.fxBufferPct, 2))),
      Math.min(80, Math.max(0, n(input.targetMarginPct, 20))),
      positiveInt(input.initialUnits),
      status,
      cleanText(input.note),
      plans
    ]
  );
  return mapRow(result.rows[0]);
}

export async function deleteCandidate(id) {
  const result = await query(
    `delete from candidate_products where id=$1 returning id`,
    [String(id)]
  );
  return result.rowCount > 0;
}
