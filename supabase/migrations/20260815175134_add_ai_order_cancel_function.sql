create or replace function public.cancel_ai_order(p_agent_id uuid,p_restaurant_id uuid,p_location_id uuid,p_order_id uuid,p_customer_phone text,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype;
begin
 if not exists(select 1 from public.ai_agents where id=p_agent_id and restaurant_id=p_restaurant_id and coalesce(location_id,p_location_id)=p_location_id and status<>'disabled') then raise exception 'AI agent is not authorized for this restaurant location'; end if;
 select * into v_order from public.orders where id=p_order_id and restaurant_id=p_restaurant_id and location_id=p_location_id for update;
 if not found then raise exception 'Order not found'; end if;
 if public.normalize_customer_phone_value(v_order.customer_phone)<>public.normalize_customer_phone_value(p_customer_phone) then raise exception 'Order does not belong to this customer'; end if;
 if v_order.status not in ('pending','confirmed') then raise exception 'This order can no longer be cancelled'; end if;
 update public.orders set status='cancelled',notes=case when nullif(trim(p_reason),'') is null then notes else concat_ws(E'\n',notes,'Cancellation requested by customer: '||trim(p_reason)) end,updated_at=now() where id=v_order.id;
 return (select jsonb_build_object('id',o.id,'order_number',o.order_number,'restaurant_id',o.restaurant_id,'location_id',o.location_id,'customer_name',o.customer_name,'customer_phone',o.customer_phone,'customer_email',o.customer_email,'fulfillment_type',o.fulfillment_type,'status',o.status,'approval_required',o.approval_required,'approval_reason',o.approval_reason,'subtotal',o.subtotal,'tax',o.tax,'delivery_fee',o.delivery_fee,'total',o.total,'scheduled_for',o.scheduled_for) from public.orders o where o.id=v_order.id);
end;
$$;

revoke all on function public.quote_complex_order_atomic(uuid,uuid,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.create_ai_order_idempotent(uuid,uuid,uuid,text,text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.modify_ai_order_atomic(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.cancel_ai_order(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.quote_complex_order_atomic(uuid,uuid,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.create_ai_order_idempotent(uuid,uuid,uuid,text,text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.modify_ai_order_atomic(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.cancel_ai_order(uuid,uuid,uuid,uuid,text,text) to service_role;
