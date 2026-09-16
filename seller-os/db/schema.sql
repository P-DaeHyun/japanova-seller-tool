-- JAPANOVA Seller OS PostgreSQL schema
-- 모든 금액은 원본 통화 금액과 JPY 환산값을 함께 보관한다.
-- 과거 주문의 수익이 이후 환율 변경으로 바뀌지 않도록 주문별 환율 스냅샷을 저장한다.

create table if not exists markets (
  code text primary key,
  name_ko text not null,
  currency text not null,
  active boolean not null default true,
  future_market boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists shopee_connections (
  id bigserial primary key,
  market_code text references markets(code),
  merchant_id bigint,
  shop_id bigint unique,
  shop_name text,
  main_account_id bigint,
  authorization_expires_at timestamptz,
  access_token_encrypted text,
  refresh_token_encrypted text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  status text not null default 'DISCONNECTED',
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fx_rates (
  id bigserial primary key,
  currency text not null,
  jpy_per numeric(20,10) not null,
  provider text not null,
  source_date text,
  status text not null default 'ok',
  captured_at timestamptz not null default now(),
  unique(currency, captured_at)
);

create index if not exists idx_fx_rates_currency_time
  on fx_rates(currency, captured_at desc);

create table if not exists products (
  id bigserial primary key,
  shop_id bigint,
  market_code text references markets(code),
  item_id bigint not null,
  item_name text,
  item_sku text,
  model_id bigint not null default 0,
  model_sku text,
  currency text,
  listed_price numeric(20,6),
  stock integer,
  weight_kg numeric(12,6),
  item_status text,
  raw_json jsonb,
  synced_at timestamptz not null default now(),
  unique(shop_id, item_id, model_id)
);

create table if not exists product_costs (
  id bigserial primary key,
  item_sku text not null,
  purchase_cost_jpy numeric(20,2) not null default 0,
  packaging_cost_jpy numeric(20,2) not null default 0,
  domestic_shipping_jpy numeric(20,2) not null default 0,
  other_direct_cost_jpy numeric(20,2) not null default 0,
  packed_weight_g integer,
  supplier text,
  note text,
  updated_at timestamptz not null default now(),
  unique(item_sku)
);

create table if not exists orders (
  id bigserial primary key,
  shop_id bigint not null,
  market_code text references markets(code),
  order_sn text unique not null,
  order_status text,
  currency text,
  total_amount numeric(20,6),
  buyer_paid_shipping_fee numeric(20,6),
  estimated_shipping_fee numeric(20,6),
  actual_shipping_fee numeric(20,6),
  shipping_carrier text,
  package_number text,
  logistics_status text,
  created_time_shopee timestamptz,
  updated_time_shopee timestamptz,
  fx_jpy_per numeric(20,10),
  fx_buffer numeric(10,6) not null default 0.02,
  raw_json jsonb,
  synced_at timestamptz not null default now()
);

create index if not exists idx_orders_market_time
  on orders(market_code, created_time_shopee desc);

create table if not exists order_items (
  id bigserial primary key,
  order_sn text references orders(order_sn) on delete cascade,
  item_id bigint not null,
  model_id bigint not null default 0,
  item_name text,
  item_sku text,
  model_sku text,
  quantity integer not null default 1,
  selling_price numeric(20,6),
  original_price numeric(20,6),
  weight_kg numeric(12,6),
  raw_json jsonb
);

create index if not exists idx_order_items_sku
  on order_items(item_sku);

create table if not exists settlements (
  id bigserial primary key,
  order_sn text references orders(order_sn) on delete cascade,
  escrow_amount numeric(20,6),
  escrow_amount_after_adjustment numeric(20,6),
  order_selling_price numeric(20,6),
  buyer_paid_shipping_fee numeric(20,6),
  actual_shipping_fee numeric(20,6),
  final_shipping_fee numeric(20,6),
  shopee_shipping_rebate numeric(20,6),
  commission_fee numeric(20,6),
  seller_transaction_fee numeric(20,6),
  service_fee numeric(20,6),
  campaign_fee numeric(20,6),
  voucher_from_seller numeric(20,6),
  seller_discount numeric(20,6),
  withholding_tax numeric(20,6),
  withholding_pit_tax numeric(20,6),
  raw_json jsonb,
  synced_at timestamptz not null default now(),
  unique(order_sn)
);

create table if not exists profit_snapshots (
  id bigserial primary key,
  order_sn text references orders(order_sn) on delete cascade,
  shopee_settlement_local numeric(20,6),
  shopee_settlement_jpy numeric(20,2),
  purchase_cost_jpy numeric(20,2),
  packaging_cost_jpy numeric(20,2),
  domestic_shipping_jpy numeric(20,2),
  payoneer_cost_jpy numeric(20,2),
  other_direct_cost_jpy numeric(20,2),
  actual_profit_jpy numeric(20,2),
  actual_margin numeric(12,8),
  fx_jpy_per numeric(20,10) not null,
  calculated_at timestamptz not null default now()
);

create table if not exists sync_logs (
  id bigserial primary key,
  scope text not null,
  market_code text,
  shop_id bigint,
  status text not null,
  message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

insert into markets(code, name_ko, currency, active, future_market)
values
  ('TW','대만','TWD',true,false),
  ('SG','싱가포르','SGD',true,false),
  ('MY','말레이시아','MYR',true,false),
  ('TH','태국','THB',true,false),
  ('PH','필리핀','PHP',true,false),
  ('VN','베트남','VND',true,false),
  ('BR','브라질','BRL',false,true)
on conflict (code) do nothing;
