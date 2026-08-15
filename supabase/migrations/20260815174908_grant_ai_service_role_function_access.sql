grant execute on function public.quote_complex_order_atomic(uuid,uuid,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.create_ai_order_idempotent(uuid,uuid,uuid,text,text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.modify_ai_order_atomic(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,jsonb) to service_role;
