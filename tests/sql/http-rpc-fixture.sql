\set ON_ERROR_STOP on

create table public.http_ai_idempotency (
 agent_id uuid not null,operation text not null,idempotency_key text not null,request_hash text not null,response jsonb,
 primary key(agent_id,operation,idempotency_key)
);

create or replace function public.quote_complex_order_atomic(
 p_restaurant_id uuid,p_location_id uuid,p_customer_name text,p_customer_phone text,p_fulfillment_type text,p_notes text,p_scheduled_for timestamptz,
 p_delivery_address_line1 text,p_delivery_address_line2 text,p_delivery_city text,p_delivery_province text,p_delivery_postal_code text,p_delivery_instructions text,p_table_number text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_item jsonb;v_sel jsonb;v_item_id uuid;v_size_id uuid;v_qty int;v_menu record;v_size record;v_group record;v_mod record;v_count int;v_subtotal numeric:=0;v_base numeric;v_delta numeric;begin
 if not exists(select 1 from public.restaurant_locations where id=p_location_id and restaurant_id=p_restaurant_id and is_active) then raise exception 'Location not found'; end if;
 if p_fulfillment_type not in('pickup','delivery','dine_in') then raise exception 'Invalid fulfillment type'; end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Invalid order items'; end if;
 for v_item in select value from jsonb_array_elements(p_items) loop
  v_item_id=(v_item->>'menu_item_id')::uuid;v_size_id=nullif(v_item->>'size_id','')::uuid;v_qty=coalesce((v_item->>'quantity')::int,1);
  if v_qty<1 or v_qty>99 then raise exception 'Invalid item quantity'; end if;
  select mi.* into v_menu from public.menu_items mi join public.menu_categories mc on mc.id=mi.category_id where mi.id=v_item_id and mc.restaurant_id=p_restaurant_id and mc.is_active;
  if not found then raise exception 'Menu item not found'; end if;if not v_menu.is_available then raise exception 'Menu item is unavailable'; end if;
  select count(*) into v_count from public.menu_item_sizes where menu_item_id=v_item_id and is_available;
  if v_count>0 and v_size_id is null then raise exception 'Size is required'; end if;
  if v_size_id is not null then
    select * into v_size from public.menu_item_sizes where id=v_size_id and menu_item_id=v_item_id and is_available;
    if not found then raise exception 'Invalid or unavailable size'; end if;v_base=v_size.price;
  else v_base=v_menu.price; end if;
  for v_group in select * from public.menu_item_modifier_groups where menu_item_id=v_item_id loop
    select count(*) into v_count from jsonb_to_recordset(coalesce(v_item->'selections','[]'::jsonb))s(modifier_id uuid,quantity int,side text,quantity_level_id uuid)
      join public.modifiers m on m.id=s.modifier_id where m.modifier_group_id=v_group.modifier_group_id;
    if v_count<v_group.min_selections or (v_group.max_selections is not null and v_count>v_group.max_selections) then raise exception 'Invalid selection count'; end if;
  end loop;
  v_delta=0;
  for v_sel in select value from jsonb_array_elements(coalesce(v_item->'selections','[]'::jsonb)) loop
    select m.* into v_mod from public.modifiers m join public.modifier_groups g on g.id=m.modifier_group_id
      join public.menu_item_modifier_groups img on img.modifier_group_id=m.modifier_group_id and img.menu_item_id=v_item_id
      where m.id=(v_sel->>'modifier_id')::uuid and m.is_available and g.is_active;
    if not found then raise exception 'Invalid or unavailable modifier'; end if;
    v_qty=coalesce((v_sel->>'quantity')::int,1);if v_qty<1 or v_qty>v_mod.max_quantity then raise exception 'Invalid modifier quantity'; end if;
    if v_mod.action='add' then v_delta=v_delta+(v_mod.price_delta*v_qty*case when coalesce(v_sel->>'side','whole') in('left','right') then v_mod.side_pricing_factor else 1 end); end if;
  end loop;
  v_subtotal=v_subtotal+((v_base+v_delta)*coalesce((v_item->>'quantity')::int,1));
 end loop;
 return jsonb_build_object('restaurant_id',p_restaurant_id,'location_id',p_location_id,'customer_name',p_customer_name,'items',p_items,'subtotal',round(v_subtotal,2),'tax',0,'delivery_fee',0,'total',round(v_subtotal,2));
end $$;

create or replace function public.create_ai_order_idempotent(
 p_agent_id uuid,p_restaurant_id uuid,p_location_id uuid,p_idempotency_key text,p_request_hash text,p_customer_name text,p_customer_phone text,p_fulfillment_type text,p_notes text,p_scheduled_for timestamptz,
 p_delivery_address_line1 text,p_delivery_address_line2 text,p_delivery_city text,p_delivery_province text,p_delivery_postal_code text,p_delivery_instructions text,p_table_number text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_existing public.http_ai_idempotency%rowtype;v_quote jsonb;v_order_id uuid;v_response jsonb;begin
 if not exists(select 1 from public.ai_agents where id=p_agent_id and restaurant_id=p_restaurant_id and location_id=p_location_id and status<>'disabled') then raise exception 'AI agent is not authorized'; end if;
 insert into public.http_ai_idempotency(agent_id,operation,idempotency_key,request_hash) values(p_agent_id,'order.create',p_idempotency_key,p_request_hash)
 on conflict(agent_id,operation,idempotency_key) do update set request_hash=public.http_ai_idempotency.request_hash returning * into v_existing;
 if v_existing.request_hash<>p_request_hash then raise exception 'Idempotency key was already used with a different request'; end if;
 if v_existing.response is not null then return v_existing.response; end if;
 v_quote=public.quote_complex_order_atomic(p_restaurant_id,p_location_id,p_customer_name,p_customer_phone,p_fulfillment_type,p_notes,p_scheduled_for,p_delivery_address_line1,p_delivery_address_line2,p_delivery_city,p_delivery_province,p_delivery_postal_code,p_delivery_instructions,p_table_number,p_items);
 insert into public.orders(restaurant_id,location_id) values(p_restaurant_id,p_location_id) returning id into v_order_id;
 v_response=jsonb_build_object('id',v_order_id,'restaurant_id',p_restaurant_id,'location_id',p_location_id,'items',p_items,'total',v_quote->'total');
 update public.http_ai_idempotency set response=v_response where agent_id=p_agent_id and operation='order.create' and idempotency_key=p_idempotency_key;
 return v_response;
end $$;

grant select,insert,update,delete on public.http_ai_idempotency to service_role;
grant execute on function public.quote_complex_order_atomic(uuid,uuid,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.create_ai_order_idempotent(uuid,uuid,uuid,text,text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) to service_role;
notify pgrst,'reload schema';
