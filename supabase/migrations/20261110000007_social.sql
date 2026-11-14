-- =====================================================================
-- Commentaires et réservations sur les listes d'envies partagées.
-- RÈGLE CLÉ : le propriétaire d'une liste d'ENVIES (le destinataire) ne voit JAMAIS les commentaires
-- ni les réservations (pour garder la surprise). C'est la base de données qui l'impose (RLS).
-- Dans une liste de CADEAUX (préparée à plusieurs), tout le monde voit les commentaires.
-- Relançable sans erreur.
-- =====================================================================

-- Le type d'une liste ne peut plus changer (sinon le propriétaire pourrait la faire passer en « cadeaux »
-- pour lire les commentaires).
create or replace function public.lists_guard() returns trigger
language plpgsql as $$
begin
  if new.owner_id <> old.owner_id then raise exception 'owner_id is immutable'; end if;
  if new.kind <> old.kind then raise exception 'kind is immutable'; end if;
  new.updated_at := now();
  return new;
end $$;

-- Mon rôle dans l'espace « social » d'une liste ; null si je n'y ai pas accès
-- (étranger, ou propriétaire d'une liste d'envies).
create or replace function public.social_role(p_list uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role
    from public.list_members m join public.lists l on l.id = m.list_id
   where m.list_id = p_list and m.user_id = (select auth.uid())
     and not (m.role = 'owner' and l.kind = 'wishes')
$$;

create or replace function public.is_wishes_list(p_list uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lists where id = p_list and kind = 'wishes')
$$;

create table if not exists public.item_comments (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.items(id) on delete cascade,
  list_id    uuid not null references public.lists(id) on delete cascade,
  author_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists item_comments_item_idx on public.item_comments (item_id, created_at);

create table if not exists public.item_claims (
  item_id    uuid primary key references public.items(id) on delete cascade,   -- une seule personne par cadeau
  list_id    uuid not null references public.lists(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status     text not null default 'claimed' check (status in ('claimed', 'bought')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- list_id est toujours celui du cadeau (on ne fait pas confiance au navigateur)
create or replace function public.social_set_list() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select i.list_id into new.list_id from public.items i where i.id = new.item_id;
  if new.list_id is null then raise exception 'item not found'; end if;
  return new;
end $$;
drop trigger if exists item_comments_list on public.item_comments;
create trigger item_comments_list before insert on public.item_comments for each row execute function public.social_set_list();
drop trigger if exists item_claims_list on public.item_claims;
create trigger item_claims_list before insert on public.item_claims for each row execute function public.social_set_list();

create or replace function public.claims_touch() returns trigger
language plpgsql as $$
begin
  if new.user_id <> old.user_id or new.item_id <> old.item_id then raise exception 'claim owner is immutable'; end if;
  new.updated_at := now(); return new;
end $$;
drop trigger if exists item_claims_touch on public.item_claims;
create trigger item_claims_touch before update on public.item_claims for each row execute function public.claims_touch();

-- quelqu'un qui quitte (ou est retiré d'une liste) libère ses réservations
create or replace function public.release_claims_on_leave() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.item_claims where list_id = old.list_id and user_id = old.user_id;
  return old;
end $$;
drop trigger if exists members_release_claims on public.list_members;
create trigger members_release_claims after delete on public.list_members for each row execute function public.release_claims_on_leave();

-- liste d'un cadeau (pour les règles ci-dessus, sans exposer la table items)
create or replace function public.item_list(p_item uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select list_id from public.items where id = p_item
$$;

alter table public.item_comments enable row level security;
alter table public.item_claims   enable row level security;

drop policy if exists comments_select on public.item_comments;
create policy comments_select on public.item_comments for select to authenticated
  using (public.social_role(list_id) is not null);
drop policy if exists comments_insert on public.item_comments;
create policy comments_insert on public.item_comments for insert to authenticated
  with check (author_id = (select auth.uid()) and public.social_role(public.item_list(item_id)) is not null);
drop policy if exists comments_delete on public.item_comments;
create policy comments_delete on public.item_comments for delete to authenticated
  using (author_id = (select auth.uid()) and public.social_role(list_id) is not null);

drop policy if exists claims_select on public.item_claims;
create policy claims_select on public.item_claims for select to authenticated
  using (public.social_role(list_id) is not null);
drop policy if exists claims_insert on public.item_claims;
create policy claims_insert on public.item_claims for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_wishes_list(public.item_list(item_id))
              and public.social_role(public.item_list(item_id)) is not null);
drop policy if exists claims_update on public.item_claims;
create policy claims_update on public.item_claims for update to authenticated
  using (user_id = (select auth.uid()) and public.social_role(list_id) is not null)
  with check (user_id = (select auth.uid()) and public.social_role(list_id) is not null);
drop policy if exists claims_delete on public.item_claims;
create policy claims_delete on public.item_claims for delete to authenticated
  using (user_id = (select auth.uid()) and public.social_role(list_id) is not null);

revoke all on public.item_comments, public.item_claims from anon, authenticated;
grant select, insert, delete on public.item_comments to authenticated;
grant select, insert, update, delete on public.item_claims to authenticated;

-- Les membres d'une même liste voient leurs prénoms (pour « Réservé par Paul », auteur d'un commentaire…).
create or replace function public.shares_list_with(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.list_members a
    join public.list_members b on b.list_id = a.list_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user
  )
$$;

alter table public.item_comments replica identity full;
alter table public.item_claims replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.item_comments, public.item_claims;
exception when undefined_object then null; when duplicate_object then null;
end $$;
