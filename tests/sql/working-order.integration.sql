\set ON_ERROR_STOP on

create extension if not exists pgcrypto;

create table ai_working_orders_test (
  id uuid primary key default gen_random_uuid(), restaurant_id uuid not null, location_id uuid not null, call_id text not null,
  items jsonb not null default '[]'::jsonb, revision integer not null default 0, quoted_revision integer, quote_token text,
  quote_payload jsonb, status text not null default 'building', unique (restaurant_id, call_id)
);
create table quote_audit_test (id bigserial primary key, call_id text not null);
create or replace function assert_true(ok boolean,message text) returns void language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create or replace function mutate_line(p_restaurant uuid,p_location uuid,p_call text,p_expected_revision int,p_line_id text,p_patch jsonb) returns int language plpgsql as $$
declare v_new_revision int; begin
 update ai_working_orders_test set items=(select jsonb_agg(case when elem->>'line_id'=p_line_id then elem||p_patch else elem end order by ord) from jsonb_array_elements(items) with ordinality e(elem,ord)),revision=revision+1,quoted_revision=null,quote_token=null,quote_payload=null,status='building'
 where restaurant_id=p_restaurant and location_id=p_location and call_id=p_call and revision=p_expected_revision returning revision into v_new_revision;
 if v_new_revision is null then raise exception 'WORKING_ORDER_CONFLICT'; end if; return v_new_revision; end $$;
create or replace function guarded_quote(p_restaurant uuid,p_location uuid,p_call text,p_expected_revision int) returns text language plpgsql as $$
declare v_row ai_working_orders_test%rowtype; v_token text; begin
 select * into v_row from ai_working_orders_test where restaurant_id=p_restaurant and location_id=p_location and call_id=p_call for update;
 if not found or v_row.revision<>p_expected_revision then raise exception 'WORKING_ORDER_CONFLICT'; end if;
 if jsonb_array_length(v_row.items)=0 or exists(select 1 from jsonb_array_elements(v_row.items)i where coalesce((i->>'ready')::boolean,false)=false) then raise exception 'ORDER_NOT_READY'; end if;
 insert into quote_audit_test(call_id) values(p_call); v_token=encode(digest(p_call||':'||v_row.revision::text,'sha256'),'hex');
 update ai_working_orders_test set quoted_revision=revision,quote_token=v_token,quote_payload=jsonb_build_object('items',items),status='quoted' where id=v_row.id; return v_token; end $$;
create or replace function guarded_create(p_restaurant uuid,p_location uuid,p_call text,p_expected_revision int,p_token text) returns jsonb language plpgsql as $$
declare v_row ai_working_orders_test%rowtype; begin
 select * into v_row from ai_working_orders_test where restaurant_id=p_restaurant and location_id=p_location and call_id=p_call for update;
 if not found or v_row.revision<>p_expected_revision or v_row.quoted_revision<>v_row.revision or v_row.quote_token is distinct from p_token or v_row.status<>'quoted' then raise exception 'STALE_OR_UNCONFIRMED_QUOTE'; end if; return v_row.quote_payload; end $$;

\set restaurant '11111111-1111-1111-1111-111111111111'
\set location '22222222-2222-2222-2222-222222222222'

-- A/B single + multiple.
insert into ai_working_orders_test(restaurant_id,location_id,call_id,items) values(:'restaurant',:'location','call-A','[{"line_id":"line-coke","menu_item_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","item_name":"Coke","size_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001","quantity":1,"ready":true,"selections":[]}]');
select assert_true(jsonb_array_length(items)=1,'A single item') from ai_working_orders_test where call_id='call-A';
update ai_working_orders_test set items=items||'[{"line_id":"line-pep","menu_item_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","item_name":"Pepperoni","size_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001","quantity":1,"ready":true,"selections":[]}]'::jsonb,revision=revision+1 where call_id='call-A';
select assert_true(jsonb_array_length(items)=2,'B multiple items') from ai_working_orders_test where call_id='call-A';

-- C modify Coke only.
select mutate_line(:'restaurant',:'location','call-A',1,'line-coke','{"item_name":"Diet Coke","menu_item_id":"cccccccc-cccc-cccc-cccc-cccccccccccc","size_id":"cccccccc-cccc-cccc-cccc-cccccccc0001"}'::jsonb);
select assert_true(items->0->>'line_id'='line-coke' and items->0->>'item_name'='Diet Coke' and items->1->>'item_name'='Pepperoni','C line isolation') from ai_working_orders_test where call_id='call-A';

-- D/E complex incremental state + substitution.
insert into ai_working_orders_test(restaurant_id,location_id,call_id,items) values(:'restaurant',:'location','call-omelet','[{"line_id":"line-omelet","menu_item_id":"dddddddd-dddd-dddd-dddd-dddddddddddd","item_name":"Veggie Omelet","quantity":1,"ready":true,"selections":[{"name":"White Toast","group":"toast"},{"name":"Square-Cut Potatoes","group":"side","substitutes_for":"Hash Browns"},{"name":"No Onions","group":"removal"},{"name":"Mild","group":"spice"}]}]');
select assert_true(jsonb_array_length(items->0->'selections')=4 and items->0->'selections' @> '[{"name":"White Toast"},{"name":"Square-Cut Potatoes","substitutes_for":"Hash Browns"},{"name":"No Onions"},{"name":"Mild"}]'::jsonb,'D/E complex state') from ai_working_orders_test where call_id='call-omelet';

-- F ORDER_NOT_READY and quote boundary untouched.
insert into ai_working_orders_test(restaurant_id,location_id,call_id,items) values(:'restaurant',:'location','call-incomplete','[{"line_id":"line-pizza","item_name":"Build Pizza","quantity":1,"ready":false,"missing":["size"]}]');
do $$ begin perform guarded_quote('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','call-incomplete',0); raise exception 'expected ORDER_NOT_READY'; exception when others then if sqlerrm not like '%ORDER_NOT_READY%' then raise; end if; end $$;
select assert_true(count(*)=0,'F quote boundary not executed') from quote_audit_test where call_id='call-incomplete';

-- G quote is snapshot of stored state.
select guarded_quote(:'restaurant',:'location','call-omelet',0);
select assert_true(quote_payload->'items'=items and quoted_revision=revision and quote_token is not null,'G authoritative quote snapshot') from ai_working_orders_test where call_id='call-omelet';
create temporary table saved_quote as select revision,quote_token from ai_working_orders_test where call_id='call-omelet';

-- H/I modify invalidates quote and saved old quote cannot create.
select mutate_line(:'restaurant',:'location','call-omelet',0,'line-omelet','{"special_instructions":"extra napkins"}'::jsonb);
select assert_true(quote_token is null and quoted_revision is null and status='building','H quote invalidated') from ai_working_orders_test where call_id='call-omelet';
do $$ declare t text; r int; begin select quote_token,revision into t,r from saved_quote; begin perform guarded_create('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','call-omelet',r,t); raise exception 'expected stale failure'; exception when others then if sqlerrm not like '%STALE_OR_UNCONFIRMED_QUOTE%' then raise; end if; end; end $$;

-- J real FK integrity rejects cross-item size/modifier IDs.
create table menu_item_test(id uuid primary key,name text not null);
create table size_test(id uuid primary key,menu_item_id uuid not null references menu_item_test(id),name text not null,unique(id,menu_item_id));
create table modifier_test(id uuid primary key,menu_item_id uuid not null references menu_item_test(id),name text not null,unique(id,menu_item_id));
create table resolved_line_test(id bigserial primary key,menu_item_id uuid not null references menu_item_test(id),size_id uuid,modifier_id uuid,foreign key(size_id,menu_item_id) references size_test(id,menu_item_id),foreign key(modifier_id,menu_item_id) references modifier_test(id,menu_item_id));
insert into menu_item_test values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Coke'),('cccccccc-cccc-cccc-cccc-cccccccccccc','Diet Coke');
insert into size_test values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Regular'),('cccccccc-cccc-cccc-cccc-cccccccc0001','cccccccc-cccc-cccc-cccc-cccccccccccc','Regular');
insert into modifier_test values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa1001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Ice');
insert into resolved_line_test(menu_item_id,size_id,modifier_id) values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa1001');
do $$ begin insert into resolved_line_test(menu_item_id,size_id) values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cccccccc-cccc-cccc-cccc-cccccccc0001'); raise exception 'expected size FK rejection'; exception when foreign_key_violation then null; end $$;
do $$ begin insert into resolved_line_test(menu_item_id,modifier_id) values('cccccccc-cccc-cccc-cccc-cccccccccccc','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa1001'); raise exception 'expected modifier FK rejection'; exception when foreign_key_violation then null; end $$;

-- K call isolation.
insert into ai_working_orders_test(restaurant_id,location_id,call_id,items) values(:'restaurant',:'location','call-B','[{"line_id":"b","item_name":"Water","ready":true}]');
select assert_true((select items->0->>'item_name' from ai_working_orders_test where call_id='call-A')='Diet Coke' and (select items->0->>'item_name' from ai_working_orders_test where call_id='call-B')='Water','K calls isolated');

-- L optimistic concurrency rejects stale writer.
insert into ai_working_orders_test(restaurant_id,location_id,call_id,items) values(:'restaurant',:'location','call-race','[{"line_id":"race","item_name":"Coke","quantity":1,"ready":true}]');
select mutate_line(:'restaurant',:'location','call-race',0,'race','{"quantity":2}'::jsonb);
do $$ begin perform mutate_line('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','call-race',0,'race','{"quantity":3}'::jsonb); raise exception 'expected conflict'; exception when others then if sqlerrm not like '%WORKING_ORDER_CONFLICT%' then raise; end if; end $$;
select assert_true((items->0->>'quantity')::int=2 and revision=1,'L no lost update') from ai_working_orders_test where call_id='call-race';

-- M/N no browse/ack mutation invocation means state remains unchanged.
select assert_true(revision=2,'M/N no unnecessary mutation') from ai_working_orders_test where call_id='call-A';
select 'LOCAL_POSTGRES_INTEGRATION_PASS' as result;
