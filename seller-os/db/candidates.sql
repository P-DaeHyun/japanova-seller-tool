-- JAPANOVA Seller OS pre-listing candidate products

create table if not exists candidate_products (
  id text primary key,
  name text not null,
  source_url text,
  supplier text,
  purchase_cost_jpy numeric(20,2) not null,
  packaging_cost_jpy numeric(20,2) not null default 0,
  domestic_shipping_jpy numeric(20,2) not null default 0,
  other_cost_jpy numeric(20,2) not null default 0,
  weight_g integer not null default 1,
  length_cm numeric(12,2) not null default 0,
  width_cm numeric(12,2) not null default 0,
  height_cm numeric(12,2) not null default 0,
  discount_pct numeric(8,3) not null default 0,
  payoneer_pct numeric(8,3) not null default 2,
  fx_buffer_pct numeric(8,3) not null default 2,
  target_margin_pct numeric(8,3) not null default 20,
  initial_units integer not null default 1,
  status text not null default 'RESEARCH',
  note text,
  plans jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_products_status_check check (status in ('RESEARCH','READY','HOLD')),
  constraint candidate_products_purchase_check check (purchase_cost_jpy > 0),
  constraint candidate_products_weight_check check (weight_g > 0),
  constraint candidate_products_units_check check (initial_units > 0)
);

create index if not exists idx_candidate_products_status_updated
  on candidate_products(status, updated_at desc);

comment on table candidate_products is 'Shopee 등록 전 후보상품과 7개국 예상가격 계획. 실제 Shopee SKU가 없어도 저장한다.';
