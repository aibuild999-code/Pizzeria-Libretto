insert into public.ai_agents (
  restaurant_id,
  location_id,
  retell_agent_id,
  name,
  language,
  status,
  configuration
)
values (
  '69d6b578-8282-45b4-8736-9b023df9e9ce',
  'e0048f18-fd43-4a3d-acdf-b595da82fe60',
  'agent_924244c1b1086d65ca801c29df',
  'The Junction Kitchen',
  'en-US',
  'active',
  jsonb_build_object(
    'reservation_policy', 'request_only',
    'customer_phone_required', true,
    'order_confirmation_required', true
  )
);