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
  environment text not null default 'sandbox',
  market_code text references markets(code),
  merchant_id bigint,
  shop_id bigint,
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

alter table shopee_connections
  add column if not exists environment text not null default 'sandbox';

alter table shopee_connections
  drop constraint if exists shopee_connections_shop_id_key;

create unique index if not exists uq_shopee_connections_environment_shop
  on shopee_connections(environment, shop_id);

create index if not exists idx_shopee_connections_environment_status
  on shopee_connections(environment, status, market_code);

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

comment on table product_costs is '상품별 단위당 배부원가. Seller OS V1 실제수익 계산에서는 수량을 곱해 사용한다.';

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

create index if not exists idx_profit_snapshots_order_time
  on profit_snapshots(order_sn, calculated_at desc);

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

-- 일본 실물재고 설정. tracking_started_at 이후 생성된 주문만 자동 차감해
-- 기존 주문을 재동기화했을 때 재고가 소급해서 마이너스 되는 것을 방지한다.
create table if not exists inventory_items (
  item_sku text primary key,
  safety_stock_qty integer not null default 0 check (safety_stock_qty >= 0),
  target_stock_qty integer not null default 0 check (target_stock_qty >= 0),
  supplier text,
  supplier_url text,
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),
  note text,
  tracking_started_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists inventory_movements (
  id bigserial primary key,
  item_sku text not null,
  quantity_delta integer not null,
  movement_type text not null,
  source_key text unique,
  order_sn text references orders(order_sn) on delete set null,
  unit_purchase_cost_jpy numeric(20,2),
  supplier text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_inventory_movements_sku_time
  on inventory_movements(item_sku, created_at desc);

create index if not exists idx_inventory_movements_order
  on inventory_movements(order_sn);

comment on table inventory_items is 'JAPANOVA 일본 실물재고 관리 설정. 현재고는 inventory_movements 합계로 계산한다.';
comment on table inventory_movements is '재고 원장. 수동조정/입고/주문차감/취소복구를 기록하며 source_key로 중복 차감을 막는다.';

-- 주문 동기화는 order_items를 매번 삭제 후 재삽입하므로 AFTER INSERT 트리거가
-- 현재 주문상태를 확인해 최초 1회만 재고를 차감하거나 취소 시 1회 복구한다.
create or replace function japanova_apply_order_inventory_movement()
returns trigger
language plpgsql
as $$
declare
  v_sku text;
  v_status text;
  v_created timestamptz;
  v_tracking timestamptz;
  v_deduct_key text;
  v_restore_key text;
begin
  v_sku := coalesce(nullif(btrim(new.item_sku),''), nullif(btrim(new.model_sku),''));
  if v_sku is null then
    return new;
  end if;

  select o.order_status, o.created_time_shopee
    into v_status, v_created
  from orders o
  where o.order_sn=new.order_sn;

  select i.tracking_started_at
    into v_tracking
  from inventory_items i
  where i.item_sku=v_sku;

  if v_tracking is null or v_created is null or v_created < v_tracking then
    return new;
  end if;

  v_deduct_key := 'order:' || new.order_sn || ':deduct:' || v_sku || ':' || new.item_id || ':' || new.model_id;
  v_restore_key := 'order:' || new.order_sn || ':restore:' || v_sku || ':' || new.item_id || ':' || new.model_id;

  if v_status in ('READY_TO_SHIP','PROCESSED','SHIPPED','TO_CONFIRM_RECEIVE','COMPLETED') then
    insert into inventory_movements(
      item_sku, quantity_delta, movement_type, source_key, order_sn, note
    )
    values (
      v_sku, -greatest(coalesce(new.quantity,1),1), 'ORDER_DEDUCT',
      v_deduct_key, new.order_sn, 'Shopee 주문 자동 차감'
    )
    on conflict (source_key) do nothing;

  elsif v_status='CANCELLED' then
    if exists (
      select 1 from inventory_movements
      where source_key=v_deduct_key
    ) then
      insert into inventory_movements(
        item_sku, quantity_delta, movement_type, source_key, order_sn, note
      )
      values (
        v_sku, greatest(coalesce(new.quantity,1),1), 'ORDER_RESTORE',
        v_restore_key, new.order_sn, 'Shopee 주문 취소 자동 복구'
      )
      on conflict (source_key) do nothing;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_japanova_inventory_order_item on order_items;
create trigger trg_japanova_inventory_order_item
after insert on order_items
for each row
execute function japanova_apply_order_inventory_movement();

insert into markets(code, name_ko, currency, active, future_market)
values
  ('TW','대만','TWD',true,false),
  ('SG','싱가포르','SGD',true,false),
  ('MY','말레이시아','MYR',true,false),
  ('TH','태국','THB',true,false),
  ('PH','필리핀','PHP',true,false),
  ('VN','베트남','VND',true,false),
  ('BR','브라질','BRL',false,true)
on conflict (code) do update set
  name_ko=excluded.name_ko,
  currency=excluded.currency,
  active=excluded.active,
  future_market=excluded.future_market,
  updated_at=now();