-- Retell preparation foundation. No Retell agent is created by this migration.

alter table public.customers
  add column if not exists phone_normalized text;

create or replace function public.normalize_customer_phone_value(p_phone text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) = 10
      then '1' || regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
    else regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
  end;
$$;

update public.customers
set phone_normalized = public.normalize_customer_phone_value(phone)
where phone_normalized is null;

create or replace function public.set_customer_phone_normalized()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.phone_normalized := public.normalize_customer_phone_value(new.phone);
  return new;
end;
$$;

drop trigger if exists customers_set_phone_normalized on public.customers;
create trigger customers_set_phone_normalized
before insert or update of phone on public.customers
for each row execute function public.set_customer_phone_normalized();

create unique index if not exists customers_restaurant_phone_normalized_key
  on public.customers (restaurant_id, phone_normalized);

alter table public.reservations
  add column if not exists seating_preference text;

alter table public.reservations
  drop constraint if exists reservations_seating_preference_check;

alter table public.reservations
  add constraint reservations_seating_preference_check
  check (seating_preference is null or seating_preference in ('indoor','patio','booth','no_preference'));

create table if not exists public.ai_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid references public.restaurant_locations(id) on delete cascade,
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, operation, idempotency_key)
);

alter table public.ai_idempotency_keys enable row level security;
revoke all on public.ai_idempotency_keys from anon, authenticated;

create index if not exists ai_idempotency_keys_created_at_idx
  on public.ai_idempotency_keys (created_at);

create or replace function public.quote_complex_order_atomic(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_fulfillment_type text,
  p_notes text,
  p_scheduled_for timestamptz,
  p_delivery_address_line1 text,
  p_delivery_address_line2 text,
  p_delivery_city text,
  p_delivery_province text,
  p_delivery_postal_code text,
  p_delivery_instructions text,
  p_table_number text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order jsonb;
begin
  begin
    v_order := public.create_complex_order_atomic(
      p_restaurant_id,
      p_location_id,
      p_customer_name,
      p_customer_phone,
      p_fulfillment_type,
      p_notes,
      p_scheduled_for,
      p_delivery_address_line1,
      p_delivery_address_line2,
      p_delivery_city,
      p_delivery_province,
      p_delivery_postal_code,
      p_delivery_instructions,
      p_table_number,
      p_items
    );
    raise exception using errcode = 'P0002', message = '__AI_QUOTE_ROLLBACK__';
  exception
    when sqlstate 'P0002' then
      return v_order;
  end;
end;
$$;

create or replace function public.create_ai_order_idempotent(
  p_agent_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_customer_name text,
  p_customer_phone text,
  p_fulfillment_type text,
  p_notes text,
  p_scheduled_for timestamptz,
  p_delivery_address_line1 text,
  p_delivery_address_line2 text,
  p_delivery_city text,
  p_delivery_province text,
  p_delivery_postal_code text,
  p_delivery_instructions text,
  p_table_number text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.ai_idempotency_keys%rowtype;
  v_order jsonb;
begin
  if not exists (
    select 1 from public.ai_agents
    where id = p_agent_id
      and restaurant_id = p_restaurant_id
      and coalesce(location_id, p_location_id) = p_location_id
      and status <> 'disabled'
  ) then
    raise exception 'AI agent is not authorized for this restaurant location';
  end if;

  insert into public.ai_idempotency_keys (
    agent_id, restaurant_id, location_id, operation, idempotency_key, request_hash
  ) values (
    p_agent_id, p_restaurant_id, p_location_id, 'order.create', p_idempotency_key, p_request_hash
  )
  on conflict (agent_id, operation, idempotency_key)
  do update set updated_at = public.ai_idempotency_keys.updated_at
  returning * into v_existing;

  if v_existing.request_hash <> p_request_hash then
    raise exception 'Idempotency key was already used with a different request';
  end if;

  if v_existing.response is not null then
    return v_existing.response;
  end if;

  v_order := public.create_complex_order_atomic(
    p_restaurant_id,
    p_location_id,
    p_customer_name,
    p_customer_phone,
    p_fulfillment_type,
    p_notes,
    p_scheduled_for,
    p_delivery_address_line1,
    p_delivery_address_line2,
    p_delivery_city,
    p_delivery_province,
    p_delivery_postal_code,
    p_delivery_instructions,
    p_table_number,
    p_items
  );

  update public.ai_idempotency_keys
  set response = v_order, updated_at = now()
  where id = v_existing.id;

  return v_order;
end;
$$;

create or replace function public.modify_ai_order_atomic(
  p_agent_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_order_id uuid,
  p_customer_phone text,
  p_customer_name text,
  p_customer_email text,
  p_fulfillment_type text,
  p_notes text,
  p_scheduled_for timestamptz,
  p_delivery_address_line1 text,
  p_delivery_address_line2 text,
  p_delivery_city text,
  p_delivery_province text,
  p_delivery_postal_code text,
  p_delivery_instructions text,
  p_table_number text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_quote jsonb;
  v_item jsonb;
  v_selection jsonb;
  v_new_item_id uuid;
begin
  if not exists (
    select 1 from public.ai_agents
    where id = p_agent_id
      and restaurant_id = p_restaurant_id
      and coalesce(location_id, p_location_id) = p_location_id
      and status <> 'disabled'
  ) then
    raise exception 'AI agent is not authorized for this restaurant location';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and restaurant_id = p_restaurant_id
    and location_id = p_location_id
  for update;

  if not found then raise exception 'Order not found'; end if;
  if v_order.customer_phone <> p_customer_phone then raise exception 'Order does not belong to this customer'; end if;
  if v_order.status not in ('pending','confirmed') then raise exception 'This order can no longer be modified'; end if;

  begin
    v_quote := public.create_complex_order_atomic(
      p_restaurant_id,
      p_location_id,
      p_customer_name,
      p_customer_phone,
      p_fulfillment_type,
      p_notes,
      p_scheduled_for,
      p_delivery_address_line1,
      p_delivery_address_line2,
      p_delivery_city,
      p_delivery_province,
      p_delivery_postal_code,
      p_delivery_instructions,
      p_table_number,
      p_items
    );
    raise exception using errcode = 'P0002', message = '__AI_MODIFY_QUOTE_ROLLBACK__';
  exception
    when sqlstate 'P0002' then null;
  end;

  if v_quote is null then raise exception 'Unable to validate modified order'; end if;

  delete from public.order_items where order_id = p_order_id;

  for v_item in select value from jsonb_array_elements(coalesce(v_quote->'items','[]'::jsonb)) loop
    insert into public.order_items (
      order_id, menu_item_id, menu_item_size_id, item_name, item_type,
      unit_price, quantity, line_total, special_instructions
    ) values (
      p_order_id,
      nullif(v_item->>'menu_item_id','')::uuid,
      nullif(v_item->>'menu_item_size_id','')::uuid,
      v_item->>'item_name',
      v_item->>'item_type',
      (v_item->>'unit_price')::numeric,
      (v_item->>'quantity')::integer,
      (v_item->>'line_total')::numeric,
      nullif(v_item->>'special_instructions','')
    ) returning id into v_new_item_id;

    for v_selection in select value from jsonb_array_elements(coalesce(v_item->'selections','[]'::jsonb)) loop
      insert into public.order_item_selections (
        order_item_id, modifier_id, target_ingredient_id, replacement_ingredient_id,
        action, side, quantity, selection_name, modifier_quantity_level_id,
        unit_price_delta, total_price_delta, notes
      ) values (
        v_new_item_id,
        nullif(v_selection->>'modifier_id','')::uuid,
        nullif(v_selection->>'target_ingredient_id','')::uuid,
        nullif(v_selection->>'replacement_ingredient_id','')::uuid,
        v_selection->>'action',
        coalesce(v_selection->>'side','whole'),
        coalesce((v_selection->>'quantity')::integer,1),
        v_selection->>'selection_name',
        nullif(v_selection->>'modifier_quantity_level_id','')::uuid,
        coalesce((v_selection->>'unit_price_delta')::numeric,0),
        coalesce((v_selection->>'total_price_delta')::numeric,0),
        nullif(v_selection->>'notes','')
      );
    end loop;
  end loop;

  update public.orders
  set fulfillment_type = coalesce(p_fulfillment_type, fulfillment_type),
      notes = p_notes,
      scheduled_for = p_scheduled_for,
      delivery_address_line1 = p_delivery_address_line1,
      delivery_address_line2 = p_delivery_address_line2,
      delivery_city = p_delivery_city,
      delivery_province = p_delivery_province,
      delivery_postal_code = p_delivery_postal_code,
      delivery_instructions = p_delivery_instructions,
      table_number = p_table_number,
      subtotal = coalesce((v_quote->>'subtotal')::numeric,0),
      tax = coalesce((v_quote->>'tax')::numeric,0),
      delivery_fee = coalesce((v_quote->>'delivery_fee')::numeric,0),
      total = coalesce((v_quote->>'total')::numeric,0),
      updated_at = now()
  where id = p_order_id;

  if p_customer_email is not null then
    update public.orders set customer_email = p_customer_email where id = p_order_id;
  end if;

  select jsonb_build_object(
    'id',o.id,'order_number',o.order_number,'restaurant_id',o.restaurant_id,'location_id',o.location_id,
    'customer_name',o.customer_name,'customer_phone',o.customer_phone,'customer_email',o.customer_email,
    'fulfillment_type',o.fulfillment_type,'status',o.status,'approval_required',o.approval_required,
    'approval_reason',o.approval_reason,'subtotal',o.subtotal,'tax',o.tax,'delivery_fee',o.delivery_fee,
    'total',o.total,'scheduled_for',o.scheduled_for,'items',coalesce((select jsonb_agg(
      jsonb_build_object('id',oi.id,'menu_item_id',oi.menu_item_id,'menu_item_size_id',oi.menu_item_size_id,
      'item_name',oi.item_name,'item_type',oi.item_type,'unit_price',oi.unit_price,'quantity',oi.quantity,
      'line_total',oi.line_total,'special_instructions',oi.special_instructions,'selections',coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from public.order_item_selections s where s.order_item_id=oi.id),'[]'::jsonb)) order by oi.id) from public.order_items oi where oi.order_id=o.id),'[]'::jsonb)
  ) into v_quote
  from public.orders o where o.id=p_order_id;

  return v_quote;
end;
$$;

revoke all on function public.quote_complex_order_atomic(uuid,uuid,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.create_ai_order_idempotent(uuid,uuid,uuid,text,text,text,text,text,text,text,timestamptz,text,text,text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.modify_ai_order_atomic(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) from public, anon, authenticated;
