create table if not exists public.ai_working_orders (
  id uuid primary key default gen_random_uuid(),
  call_id text not null,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.restaurant_locations(id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  revision integer not null default 0,
  quoted_revision integer,
  quote_token text,
  quote_payload jsonb,
  quote_result jsonb,
  status text not null default 'building' check (status in ('building','quoted','created','abandoned')),
  created_order_id uuid references public.orders(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '4 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, call_id)
);

create index if not exists ai_working_orders_call_lookup_idx
  on public.ai_working_orders (restaurant_id, location_id, call_id);
create index if not exists ai_working_orders_expiry_idx
  on public.ai_working_orders (expires_at);

alter table public.ai_working_orders enable row level security;
revoke all on table public.ai_working_orders from anon, authenticated;
grant select, insert, update, delete on table public.ai_working_orders to service_role;

comment on table public.ai_working_orders is
  'Server-only, call-scoped order state used by authenticated AI voice tools. Menu/pricing tables remain authoritative.';
