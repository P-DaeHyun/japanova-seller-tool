create table if not exists listing_publish_attempts (
  id bigserial primary key,
  candidate_id text not null references candidate_products(id) on delete cascade,
  market_code text not null,
  shop_id bigint not null,
  request_hash text not null,
  status text not null check (status in ('PENDING','SUCCEEDED','REVIEW')),
  item_id bigint,
  response_json jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index if not exists uq_listing_publish_candidate_market
  on listing_publish_attempts(candidate_id, market_code);

create index if not exists idx_listing_publish_status_updated
  on listing_publish_attempts(status, updated_at desc);
