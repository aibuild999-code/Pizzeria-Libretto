\set ON_ERROR_STOP on
create table public.menu_item_modifier_group_size_rules (
 id uuid primary key default gen_random_uuid(),
 menu_item_id uuid not null references public.menu_items(id),
 modifier_group_id uuid not null references public.modifier_groups(id),
 menu_item_size_id uuid not null references public.menu_item_sizes(id),
 min_selections int, max_selections int, required boolean, free_selections int,
 unique(menu_item_id,modifier_group_id,menu_item_size_id)
);
-- Large Pepperoni Pizza requires at least one topping in this deterministic fixture.
insert into public.menu_item_modifier_group_size_rules(menu_item_id,modifier_group_id,menu_item_size_id,min_selections,max_selections,required,free_selections)
values('20000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000002',1,null,true,0);
grant select,insert,update,delete on public.menu_item_modifier_group_size_rules to service_role;
