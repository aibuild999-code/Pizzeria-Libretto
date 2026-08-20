\set ON_ERROR_STOP on
create extension if not exists pgcrypto;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then alter role service_role bypassrls; end $$;

create table public.restaurants (
 id uuid primary key,name text not null,phone text,email text,website_url text,logo_url text,
 timezone text not null default 'America/Toronto',max_online_party_size int default 20
);
create table public.restaurant_locations (
 id uuid primary key,restaurant_id uuid not null references public.restaurants(id),name text not null,
 address_line1 text,city text,province text,postal_code text,phone text,email text,is_active boolean not null default true
);
create table public.restaurant_settings (
 restaurant_id uuid primary key references public.restaurants(id),pickup_enabled boolean default true,delivery_enabled boolean default false,dine_in_enabled boolean default true,
 scheduled_orders_enabled boolean default true,large_order_approval_threshold numeric,reservations_enabled boolean default true,reservations_auto_confirm boolean default false,
 reservations_max_auto_party_size int,reservation_capacity int,delivery_radius_km numeric,delivery_minimum_order numeric,free_delivery_threshold numeric,
 delivery_distance_pricing jsonb,ai_enabled boolean default true,ai_escalation_settings jsonb,ai_approval_rules jsonb
);
create table public.restaurant_hours (
 id uuid primary key default gen_random_uuid(),location_id uuid not null references public.restaurant_locations(id),day_of_week int not null,opens_at time,closes_at time,is_closed boolean not null default false
);
create table public.ai_agents (
 id uuid primary key,restaurant_id uuid not null references public.restaurants(id),location_id uuid references public.restaurant_locations(id),retell_agent_id text unique,status text not null default 'active'
);
create table public.orders (
 id uuid primary key default gen_random_uuid(),restaurant_id uuid not null references public.restaurants(id),location_id uuid not null references public.restaurant_locations(id)
);

create table public.menu_categories (
 id uuid primary key,restaurant_id uuid not null references public.restaurants(id),name text not null,is_active boolean not null default true,display_order int not null default 0
);
create table public.menu_items (
 id uuid primary key,category_id uuid not null references public.menu_categories(id),name text not null,description text,price numeric(12,2) not null default 0,
 dietary_tags text[] default '{}',is_available boolean not null default true,item_type text not null default 'standard',display_order int not null default 0
);
create table public.menu_item_sizes (
 id uuid primary key,menu_item_id uuid not null references public.menu_items(id),name text not null,price numeric(12,2) not null,is_available boolean not null default true,display_order int not null default 0,
 unique(id,menu_item_id)
);
create table public.modifier_groups (
 id uuid primary key,restaurant_id uuid not null references public.restaurants(id),name text not null,description text,selection_type text not null default 'multiple',
 min_selections int not null default 0,max_selections int,allow_duplicate_selections boolean not null default false,is_active boolean not null default true,display_order int not null default 0
);
create table public.menu_item_modifier_groups (
 menu_item_id uuid not null references public.menu_items(id),modifier_group_id uuid not null references public.modifier_groups(id),
 min_selections int not null default 0,max_selections int,required boolean not null default false,free_selections int not null default 0,display_order int not null default 0,
 primary key(menu_item_id,modifier_group_id)
);
create table public.modifiers (
 id uuid primary key,modifier_group_id uuid not null references public.modifier_groups(id),name text not null,description text,price_delta numeric(12,2) not null default 0,
 max_quantity int not null default 1,is_available boolean not null default true,action text not null default 'add',target_ingredient_id uuid,replacement_ingredient_id uuid,
 pricing_mode text not null default 'fixed',price_multiplier numeric default 1,side_pricing_factor numeric default 1,display_order int not null default 0,
 unique(id,modifier_group_id)
);
create table public.menu_item_availability_windows (
 id uuid primary key default gen_random_uuid(),menu_item_id uuid not null references public.menu_items(id),day_of_week int not null,starts_at time not null,ends_at time not null
);

insert into public.restaurants(id,name,timezone) values
('11111111-1111-1111-1111-111111111111','Restaurant A','America/Toronto'),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Restaurant B','America/Toronto');
insert into public.restaurant_locations(id,restaurant_id,name,address_line1,city,province,postal_code,is_active) values
('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','A / Location 1','1 Test St','Toronto','ON','M1M1M1',true),
('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','A / Location 2','2 Test St','Toronto','ON','M2M2M2',true),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','B / Location 1','3 Test St','Toronto','ON','M3M3M3',true);
insert into public.restaurant_settings(restaurant_id,pickup_enabled,delivery_enabled,dine_in_enabled,scheduled_orders_enabled,reservations_enabled,reservation_capacity)
values('11111111-1111-1111-1111-111111111111',true,false,true,true,true,100),('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',true,false,true,true,true,100);
insert into public.restaurant_hours(location_id,day_of_week,opens_at,closes_at,is_closed)
select '22222222-2222-2222-2222-222222222222',d,'00:00','23:59',false from generate_series(0,6)d;
insert into public.restaurant_hours(location_id,day_of_week,opens_at,closes_at,is_closed)
select '33333333-3333-3333-3333-333333333333',d,'00:00','23:59',false from generate_series(0,6)d;
insert into public.restaurant_hours(location_id,day_of_week,opens_at,closes_at,is_closed)
select 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',d,'00:00','23:59',false from generate_series(0,6)d;

insert into public.ai_agents(id,restaurant_id,location_id,retell_agent_id,status) values
('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','retell-agent-a1','active'),
('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','retell-agent-a2','active'),
('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','retell-agent-a-l2','active'),
('cccccccc-cccc-cccc-cccc-cccccccccccc','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','retell-agent-b1','active');

-- Deterministic acceptance-test menu, shaped like the real production schema.
insert into public.menu_categories(id,restaurant_id,name,display_order) values
('10000000-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111','Breakfast',1),
('10000000-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','Drinks',2),
('10000000-0000-4000-8000-000000000003','11111111-1111-1111-1111-111111111111','Pizza',3),
('10000000-0000-4000-8000-000000000004','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Drinks',1);
insert into public.menu_items(id,category_id,name,description,price,is_available,item_type,display_order) values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Veggie Omelet','Egg omelet with vegetable fillings',12.00,true,'standard',1),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Coke','Coca-Cola',2.50,true,'standard',1),
('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','Diet Coke','Diet Coca-Cola',2.50,true,'standard',2),
('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000003','Pepperoni Pizza','Classic pepperoni pizza',10.00,true,'standard',1),
('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000004','Coke','Other tenant Coke',3.00,true,'standard',1);
insert into public.menu_item_sizes(id,menu_item_id,name,price,is_available,display_order) values
('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000004','Medium',14.00,true,1),
('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000004','Large',18.00,true,2),
('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','Regular',2.50,true,1),
('30000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000003','Regular',2.50,true,1),
('30000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000005','Regular',3.00,true,1);

insert into public.modifier_groups(id,restaurant_id,name,selection_type,min_selections,max_selections,display_order) values
('40000000-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111','Bread Choice','single',1,1,1),
('40000000-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','Omelette Side','single',1,1,2),
('40000000-0000-4000-8000-000000000003','11111111-1111-1111-1111-111111111111','Remove Ingredients','multiple',0,6,3),
('40000000-0000-4000-8000-000000000004','11111111-1111-1111-1111-111111111111','Spice Level','single',0,1,4),
('40000000-0000-4000-8000-000000000005','11111111-1111-1111-1111-111111111111','Pizza Toppings','multiple',0,null,5);
insert into public.menu_item_modifier_groups(menu_item_id,modifier_group_id,min_selections,max_selections,required,free_selections,display_order) values
('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',1,1,true,1,1),
('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',1,1,true,1,2),
('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003',0,6,false,0,3),
('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000004',0,1,false,0,4),
('20000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000005',0,null,false,0,1);
insert into public.modifiers(id,modifier_group_id,name,price_delta,max_quantity,is_available,action,target_ingredient_id,display_order) values
('50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','White Toast',0,1,true,'add',null,1),
('50000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','Hash Browns',0,1,false,'add',null,1),
('50000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000002','Square-Cut Potatoes',0,1,true,'add',null,2),
('50000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000003','Onions',0,1,true,'remove','60000000-0000-4000-8000-000000000001',1),
('50000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000004','Mild',0,1,true,'add',null,1),
('50000000-0000-4000-8000-000000000006','40000000-0000-4000-8000-000000000005','Pepperoni',2.00,4,true,'add',null,1),
('50000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000005','Mushrooms',1.00,4,true,'add',null,2),
('50000000-0000-4000-8000-000000000008','40000000-0000-4000-8000-000000000005','Green Peppers',1.00,4,true,'add',null,3);

grant usage on schema public to service_role;
grant select,insert,update,delete on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
