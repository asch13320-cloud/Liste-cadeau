-- Un lecteur doit pouvoir voir le prénom du propriétaire de la liste qu'on lui partage
-- (et seulement lui : pas les autres membres).
create function public.owner_of_my_list(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.lists l
    join public.list_members m on m.list_id = l.id
    where l.owner_id = p_user and m.user_id = (select auth.uid())
  )
$$;

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_list_with(id) or public.owner_of_my_list(id));
