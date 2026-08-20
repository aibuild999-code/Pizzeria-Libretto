\set ON_ERROR_STOP on

create table quote_audit_test(id bigserial primary key,call_id text not null);
create table created_order_test(id uuid primary key default gen_random_uuid(),restaurant_id uuid not null,location_id uuid not null,call_id text not null,request_hash text not null,unique(restaurant_id,location_id,call_id));

create or replace function assert_true(ok boolean,message text) returns void language plpgsql as $$
begin if not coalesce(ok,false) then raise exception 'ASSERTION FAILED: %',message; end if; end $$;

create or replace function mutate_line(p_restaurant uuid,p_location uuid,p_agent uuid,p_call text,p_expected_revision int,p_line_id text,p_patch jsonb)
returns int language plpgsql as $$
declare v_revision int; begin
 update public.ai_working_orders set
  items=(select jsonb_agg(case when elem->>'line_id'=p_line_id then elem||p_patch else elem end order by ord) from jsonb_array_elements(items) with ordinality e(elem,ord)),
  revision=revision+1,quoted_revision=null,quote_token=null,quote_payload=null,quote_result=null,status='building',updated_at=now()
 where restaurant_id=p_restaurant and location_id=p_location and agent_id=p_agent and call_id=p_call and revision=p_expected_revision and status in('building','quoted')
 returning revision into v_revision;
 if v_revision is null then raise exception 'WORKING_ORDER_CONFLICT'; end if;
 return v_revision;
end $$;

create or replace function guarded_quote(p_restaurant uuid,p_location uuid,p_agent uuid,p_call text,p_expected_revision int)
returns text language plpgsql as $$
declare v_row public.ai_working_orders%rowtype;v_token text;begin
 select * into v_row from public.ai_working_orders where restaurant_id=p_restaurant and location_id=p_location and agent_id=p_agent and call_id=p_call for update;
 if not found or v_row.revision<>p_expected_revision then raise exception 'WORKING_ORDER_CONFLICT'; end if;
 if v_row.expires_at<=now() then raise exception 'WORKING_ORDER_EXPIRED'; end if;
 if jsonb_array_length(v_row.items)=0 or exists(select 1 from jsonb_array_elements(v_row.items)i where coalesce((i->>'ready')::boolean,false)=false) then raise exception 'ORDER_NOT_READY'; end if;
 insert into quote_audit_test(call_id) values(p_call);
 v_token=encode(digest(p_call||':'||v_row.revision::text,'sha256'),'hex');
 update public.ai_working_orders set quoted_revision=revision,quote_token=v_token,quote_payload=jsonb_build_object('items',items,'revision',revision),quote_result=jsonb_build_object('total',20),status='quoted' where id=v_row.id;
 return v_token;
end $$;

create or replace function guarded_create(p_restaurant uuid,p_location uuid,p_agent uuid,p_call text,p_expected_revision int,p_token text)
returns uuid language plpgsql as $$
declare v_row public.ai_working_orders%rowtype;v_id uuid;begin
 select * into v_row from public.ai_working_orders where restaurant_id=p_restaurant and location_id=p_location and agent_id=p_agent and call_id=p_call for update;
 if not found or v_row.revision<>p_expected_revision or v_row.quoted_revision<>v_row.revision or v_row.quote_token is distinct from p_token or v_row.status<>'quoted' then raise exception 'STALE_OR_UNCONFIRMED_QUOTE'; end if;
 update public.ai_working_orders set status='creating' where id=v_row.id and status='quoted';
 insert into created_order_test(restaurant_id,location_id,call_id,request_hash) values(p_restaurant,p_location,p_call,encode(digest(v_row.quote_payload::text,'sha256'),'hex'))
 on conflict(restaurant_id,location_id,call_id) do update set request_hash=created_order_test.request_hash returning id into v_id;
 update public.ai_working_orders set status='created',created_order_id=null where id=v_row.id and status='creating';
 return v_id;
end $$;

\set restaurant '11111111-1111-1111-1111-111111111111'
\set location '22222222-2222-2222-2222-222222222222'
\set location2 '33333333-3333-3333-3333-333333333333'
\set agent '44444444-4444-4444-4444-444444444444'
\set agent2 '55555555-5555-5555-5555-555555555555'
\set restaurantB 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set locationB 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set agentB 'cccccccc-cccc-cccc-cccc-cccccccccccc'

-- Real branch table/RLS exists and anon/authenticated cannot access it.
select assert_true((select relrowsecurity from pg_class where oid='public.ai_working_orders'::regclass),'RLS enabled');
select assert_true(not has_table_privilege('anon','public.ai_working_orders','select'),'anon cannot select');
select assert_true(not has_table_privilege('authenticated','public.ai_working_orders','select'),'authenticated cannot select');

-- Scope: same call id is valid at a different location and a different restaurant.
insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id,items) values
('shared-call',:'agent',:'restaurant',:'location','[{"line_id":"line-a","item_name":"Pepperoni","ready":true}]'),
('shared-call','66666666-6666-6666-6666-666666666666',:'restaurant',:'location2','[{"line_id":"line-l2","item_name":"Coke","ready":true}]'),
('shared-call',:'agentB',:'restaurantB',:'locationB','[{"line_id":"line-b","item_name":"Diet Coke","ready":true}]');
select assert_true((select count(*) from public.ai_working_orders where call_id='shared-call')=3,'restaurant/location/call isolation');

-- Duplicate same restaurant/location/call is rejected, even with another agent.
do $$ begin
 insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id) values('shared-call','55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
 raise exception 'expected unique violation'; exception when unique_violation then null; end $$;

-- A/B/C: state persists multiple items and targeted mutation preserves peers.
insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id,items) values
('call-order',:'agent',:'restaurant',:'location','[{"line_id":"line-coke","menu_item_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","item_name":"Coke","quantity":1,"ready":true,"selections":[]}]');
update public.ai_working_orders set items=items||'[{"line_id":"line-pizza","menu_item_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","item_name":"Pepperoni Pizza","quantity":1,"ready":true,"selections":[]}]'::jsonb,revision=revision+1 where call_id='call-order';
select mutate_line(:'restaurant',:'location',:'agent','call-order',1,'line-coke','{"quantity":2}'::jsonb);
select assert_true(jsonb_array_length(items)=2 and (items->0->>'line_id')='line-coke' and (items->0->>'quantity')::int=2 and (items->1->>'item_name')='Pepperoni Pizza','targeted line mutation') from public.ai_working_orders where call_id='call-order';

-- Optimistic stale writer cannot overwrite winning update.
do $$ begin
 perform mutate_line('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','call-order',1,'line-coke','{"quantity":3}'::jsonb);
 raise exception 'expected conflict'; exception when others then if sqlerrm not like '%WORKING_ORDER_CONFLICT%' then raise; end if; end $$;
select assert_true((items->0->>'quantity')::int=2 and revision=2,'no silent lost update') from public.ai_working_orders where call_id='call-order';

-- Empty and unresolved orders block quote boundary; audit remains zero.
insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id) values('empty',:'agent',:'restaurant',:'location');
insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id,items) values('unresolved',:'agent',:'restaurant',:'location','[{"line_id":"u","item_name":"Ambiguous","ready":false}]');
do $$ begin perform guarded_quote('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','empty',0); raise exception 'expected not ready'; exception when others then if sqlerrm not like '%ORDER_NOT_READY%' then raise; end if; end $$;
do $$ begin perform guarded_quote('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','unresolved',0); raise exception 'expected not ready'; exception when others then if sqlerrm not like '%ORDER_NOT_READY%' then raise; end if; end $$;
select assert_true((select count(*) from quote_audit_test where call_id in('empty','unresolved'))=0,'quote boundary not called for unready orders');

-- Quote derives stored state, then any modification invalidates it and stale create fails.
insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id,items) values('quoted',:'agent',:'restaurant',:'location','[{"line_id":"q","item_name":"Coke","quantity":1,"ready":true}]');
select guarded_quote(:'restaurant',:'location',:'agent','quoted',0) as token \gset
select assert_true(quote_payload->'items'=items and quoted_revision=revision and status='quoted','quote snapshot stored') from public.ai_working_orders where call_id='quoted';
select mutate_line(:'restaurant',:'location',:'agent','quoted',0,'q','{"quantity":2}'::jsonb);
select assert_true(quote_token is null and quoted_revision is null and status='building' and revision=1,'quote invalidated by modification') from public.ai_working_orders where call_id='quoted';
do $$ begin perform guarded_create('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','quoted',0,null); raise exception 'expected stale create'; exception when others then if sqlerrm not like '%STALE_OR_UNCONFIRMED_QUOTE%' then raise; end if; end $$;

-- Expired state is rejected.
insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id,items,expires_at) values('expired',:'agent',:'restaurant',:'location','[{"line_id":"e","ready":true}]',now()-interval '1 minute');
do $$ begin perform guarded_quote('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','expired',0); raise exception 'expected expired'; exception when others then if sqlerrm not like '%WORKING_ORDER_EXPIRED%' then raise; end if; end $$;

-- Agent mismatch cannot address another agent's row through the guarded functions.
do $$ begin perform mutate_line('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','55555555-5555-5555-5555-555555555555','call-order',2,'line-coke','{"quantity":9}'::jsonb); raise exception 'expected agent conflict'; exception when others then if sqlerrm not like '%WORKING_ORDER_CONFLICT%' then raise; end if; end $$;

-- Idempotent create equivalent: one authoritative created record for repeated create of same scope.
insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id,items) values('create-once',:'agent',:'restaurant',:'location','[{"line_id":"c","item_name":"Coke","ready":true}]');
select guarded_quote(:'restaurant',:'location',:'agent','create-once',0) as create_token \gset
select guarded_create(:'restaurant',:'location',:'agent','create-once',0,:'create_token');
select assert_true((select count(*) from created_order_test where restaurant_id=:'restaurant' and location_id=:'location' and call_id='create-once')=1,'exactly one created order');
select assert_true((select status from public.ai_working_orders where call_id='create-once')='created','working state finalized');

select 'ACTUAL_WORKING_ORDER_MIGRATION_INTEGRATION_PASS' as result;
