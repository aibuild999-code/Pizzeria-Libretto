create or replace function public.is_dashboard_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null;
$$;

revoke all on function public.is_dashboard_user() from public;
grant execute on function public.is_dashboard_user() to authenticated;

create policy "authenticated users can read restaurant"
on public.restaurants
for select
to authenticated
using (public.is_dashboard_user());

create policy "authenticated users can read orders"
on public.orders
for select
to authenticated
using (public.is_dashboard_user());

create policy "authenticated users can read reservations"
on public.reservations
for select
to authenticated
using (public.is_dashboard_user());

update public.restaurants
set email = null,
    updated_at = now()
where name = 'The Junction Kitchen'
  and email = 'university@pizzerialibretto.com';
