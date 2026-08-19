\set ON_ERROR_STOP on
create extension if not exists pgcrypto;

create table if not exists public.restaurants (
  id uuid primary key,
  name text not null
);
create table if not exists public.restaurant_locations (
  id uuid primary key,
  restaurant_id uuid not null references public.restaurants(id),
  name text not null
);
create table if not exists public.ai_agents (
  id uuid primary key,
  restaurant_id uuid not null references public.restaurants(id),
  location_id uuid references public.restaurant_locations(id),
  retell_agent_id text unique,
  status text not null default 'active'
);
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id),
  location_id uuid not null references public.restaurant_locations(id)
);

insert into public.restaurants(id,name) values
('11111111-1111-1111-1111-111111111111','Restaurant A'),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Restaurant B')
on conflict do nothing;
insert into public.restaurant_locations(id,restaurant_id,name) values
('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','A / Location 1'),
('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','A / Location 2'),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','B / Location 1')
on conflict do nothing;
insert into public.ai_agents(id,restaurant_id,location_id,retell_agent_id,status) values
('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','retell-agent-a1','active'),
('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','retell-agent-a2','active'),
('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','retell-agent-a-l2','active'),
('cccccccc-cccc-cccc-cccc-cccccccccccc','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','retell-agent-b1','active')
on conflict do nothing;
