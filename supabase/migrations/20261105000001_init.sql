-- =====================================================================
-- Liste-cadeau V2 — schéma initial
-- Sécurité : toutes les permissions sont appliquées ICI (RLS), jamais
-- seulement dans l'interface. Aucune clé service_role côté navigateur.
-- Rôles : owner (propriétaire) > collaborator (collaborateur) > reader (lecteur)
-- =====================================================================

-- ---------- Profils ----------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 60),
  created_at   timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'display_name', ''), 60))
  on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------- Listes ----------
create table public.lists (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  kind       text not null default 'wishes' check (kind in ('wishes', 'gifts_for')),
  title      text not null check (char_length(title) between 1 and 120),
  emoji      text not null default '🎀' check (char_length(emoji) <= 16),
  budget     numeric(10,2) check (budget is null or budget >= 0),
  legacy_key text,                        -- migration : évite les doublons
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, legacy_key)
);

create table public.list_members (
  list_id    uuid not null references public.lists(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner', 'collaborator', 'reader')),
  created_at timestamptz not null default now(),
  primary key (list_id, user_id)
);
create index list_members_user_idx on public.list_members (user_id);
create unique index one_owner_per_list on public.list_members (list_id) where role = 'owner';

-- ---------- Outils de droits ----------
create function public.role_rank(r text) returns int
language sql immutable as $$
  select case r when 'owner' then 3 when 'collaborator' then 2 when 'reader' then 1 else 0 end
$$;

create function public.has_list_role(p_list uuid, p_min text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.list_members m
    where m.list_id = p_list
      and m.user_id = (select auth.uid())
      and public.role_rank(m.role) >= public.role_rank(p_min)
  )
$$;

create function public.shares_list_with(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.list_members a
    join public.list_members b on b.list_id = a.list_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user
      and public.role_rank(a.role) >= 2   -- seuls propriétaires/collaborateurs voient les autres membres
  )
$$;

-- Le propriétaire est membre de sa propre liste ; owner_id est immuable.
create function public.add_owner_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.list_members (list_id, user_id, role) values (new.id, new.owner_id, 'owner');
  return new;
end $$;
create trigger lists_add_owner after insert on public.lists
for each row execute function public.add_owner_member();

create function public.lists_guard() returns trigger
language plpgsql as $$
begin
  if new.owner_id <> old.owner_id then raise exception 'owner_id is immutable'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger lists_guard before update on public.lists
for each row execute function public.lists_guard();

-- ---------- Cadeaux ----------
create table public.items (
  id               uuid primary key default gen_random_uuid(),
  list_id          uuid not null references public.lists(id) on delete cascade,
  created_by       uuid default auth.uid() references auth.users(id) on delete set null,
  name             text not null check (char_length(name) between 1 and 200),
  est_price        numeric(10,2) check (est_price is null or est_price >= 0),
  spent            numeric(10,2) check (spent is null or spent >= 0),
  priority         text check (priority in ('love', 'like', 'maybe')),
  category         text check (category in ('beauty', 'clothes', 'home', 'tech', 'leisure', 'other')),
  status           text check (status in ('idea', 'wish', 'received')),
  link             text check (link is null or (link ~* '^https?://' and char_length(link) <= 2000)),
  notes            text check (notes is null or char_length(notes) <= 2000),   -- visibles par tous les membres
  photo_path       text check (photo_path is null or photo_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$'),
  favorite         boolean not null default false,
  bought           boolean not null default false,
  wrapped          boolean not null default false,
  link_title       text check (char_length(link_title) <= 300),
  link_image       text check (link_image is null or (link_image ~* '^https?://' and char_length(link_image) <= 2000)),
  link_description text check (char_length(link_description) <= 1000),
  link_price       numeric(10,2) check (link_price is null or link_price >= 0),
  legacy_key       text,
  version          integer not null default 1,   -- détection des conflits (voir doc)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (list_id, legacy_key)
);
create index items_list_idx on public.items (list_id, created_at desc);

create function public.items_guard() returns trigger
language plpgsql as $$
begin
  if new.list_id <> old.list_id then raise exception 'list_id is immutable'; end if;
  new.created_by := old.created_by;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
create trigger items_guard before update on public.items
for each row execute function public.items_guard();

-- Notes privées : visibles uniquement par leur auteur, même dans une liste partagée.
create function public.can_read_item(p_item uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.items i where i.id = p_item and public.has_list_role(i.list_id, 'reader'))
$$;

create table public.item_private_notes (
  item_id    uuid not null references public.items(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  notes      text not null check (char_length(notes) between 1 and 2000),
  updated_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

-- Tiroir à idées (privé)
create table public.inbox_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text       text not null check (char_length(text) between 1 and 1000),
  legacy_key text,
  created_at timestamptz not null default now(),
  unique (user_id, legacy_key)
);

-- Liens d'invitation / de partage (le jeton n'est JAMAIS stocké en clair)
create table public.invite_links (
  id             uuid primary key default gen_random_uuid(),
  list_id        uuid not null references public.lists(id) on delete cascade,
  role           text not null check (role in ('collaborator', 'reader')),
  token_hash     text not null unique,
  created_by     uuid default auth.uid() references auth.users(id) on delete set null,
  email          text check (email is null or email = lower(email)),
  allow_anonymous boolean not null default false,
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  max_uses       integer not null default 1 check (max_uses between 1 and 100000),
  uses           integer not null default 0,
  created_at     timestamptz not null default now()
);
create index invite_links_list_idx on public.invite_links (list_id);

-- ---------- RLS ----------
alter table public.profiles          enable row level security;
alter table public.lists             enable row level security;
alter table public.list_members      enable row level security;
alter table public.items             enable row level security;
alter table public.item_private_notes enable row level security;
alter table public.inbox_items       enable row level security;
alter table public.invite_links      enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_list_with(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- lists
create policy lists_select on public.lists for select to authenticated
  using (owner_id = (select auth.uid()) or public.has_list_role(id, 'reader'));
create policy lists_insert on public.lists for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy lists_update on public.lists for update to authenticated
  using (public.has_list_role(id, 'owner')) with check (public.has_list_role(id, 'owner'));
create policy lists_delete on public.lists for delete to authenticated
  using (public.has_list_role(id, 'owner'));

-- list_members : aucune insertion directe (passe par redeem_invite / trigger propriétaire)
create policy members_select on public.list_members for select to authenticated
  using (user_id = (select auth.uid()) or public.has_list_role(list_id, 'collaborator'));
create policy members_update on public.list_members for update to authenticated
  using (public.has_list_role(list_id, 'owner') and role <> 'owner')
  with check (public.has_list_role(list_id, 'owner') and role in ('collaborator', 'reader'));
create policy members_delete on public.list_members for delete to authenticated
  using (role <> 'owner' and (user_id = (select auth.uid()) or public.has_list_role(list_id, 'owner')));

-- items
create policy items_select on public.items for select to authenticated
  using (public.has_list_role(list_id, 'reader'));
create policy items_insert on public.items for insert to authenticated
  with check (public.has_list_role(list_id, 'collaborator') and created_by = (select auth.uid()));
create policy items_update on public.items for update to authenticated
  using (public.has_list_role(list_id, 'collaborator'))
  with check (public.has_list_role(list_id, 'collaborator'));
create policy items_delete on public.items for delete to authenticated
  using (public.has_list_role(list_id, 'collaborator'));

-- notes privées : uniquement l'auteur
create policy pnotes_all on public.item_private_notes for all to authenticated
  using (user_id = (select auth.uid()) and public.can_read_item(item_id))
  with check (user_id = (select auth.uid()) and public.can_read_item(item_id));

-- inbox
create policy inbox_all on public.inbox_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- invite_links : seul le propriétaire les voit / révoque ; création via create_invite_link()
create policy invites_select on public.invite_links for select to authenticated
  using (public.has_list_role(list_id, 'owner'));
create policy invites_update on public.invite_links for update to authenticated
  using (public.has_list_role(list_id, 'owner')) with check (public.has_list_role(list_id, 'owner'));
create policy invites_delete on public.invite_links for delete to authenticated
  using (public.has_list_role(list_id, 'owner'));

-- Droits de table : anonyme = rien ; connecté = ce que RLS autorise
revoke all on all tables in schema public from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.lists, public.items, public.item_private_notes, public.inbox_items to authenticated;
grant select, update, delete on public.list_members to authenticated;
grant select, update, delete on public.invite_links to authenticated;
-- (invite_links : pas d'INSERT direct)
grant usage on schema public to anon, authenticated;

-- ---------- Invitations ----------
create function public.create_invite_link(
  p_list uuid, p_role text, p_ttl_hours integer default 168,
  p_max_uses integer default 1, p_email text default null, p_anonymous boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_token text; v_row public.invite_links; v_kind text;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_list_role(p_list, 'owner') then raise exception 'forbidden'; end if;
  if p_role not in ('collaborator', 'reader') then raise exception 'invalid_role'; end if;
  if p_ttl_hours is null or p_ttl_hours not between 1 and 2160 then raise exception 'invalid_ttl'; end if;
  if p_anonymous then
    select kind into v_kind from public.lists where id = p_list;
    if p_role <> 'reader' or v_kind <> 'wishes' or p_email is not null then
      raise exception 'anonymous_link_not_allowed';
    end if;
    p_max_uses := 100000;
  end if;
  if p_max_uses is null or p_max_uses not between 1 and 100000 then raise exception 'invalid_max_uses'; end if;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.invite_links (list_id, role, token_hash, email, allow_anonymous, expires_at, max_uses)
  values (p_list, p_role, encode(sha256(convert_to(v_token, 'utf8')), 'hex'),
          nullif(lower(trim(p_email)), ''), coalesce(p_anonymous, false),
          now() + make_interval(hours => p_ttl_hours), p_max_uses)
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'token', v_token, 'expires_at', v_row.expires_at);
end $$;

create function public.redeem_invite(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.invite_links; v_uid uuid := (select auth.uid()); v_old text;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into l from public.invite_links
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex') for update;
  -- Message unique : on ne révèle pas si le lien existe, est expiré, révoqué ou épuisé.
  if not found or l.revoked_at is not null or l.expires_at <= now() or l.uses >= l.max_uses then
    raise exception 'invalid_or_expired_invite';
  end if;
  if l.email is not null and lower(coalesce((select auth.jwt()) ->> 'email', '')) <> l.email then
    raise exception 'invalid_or_expired_invite';
  end if;
  select role into v_old from public.list_members where list_id = l.list_id and user_id = v_uid;
  if v_old is null or public.role_rank(l.role) > public.role_rank(v_old) then
    insert into public.list_members (list_id, user_id, role) values (l.list_id, v_uid, l.role)
    on conflict (list_id, user_id) do update set role = excluded.role;
    update public.invite_links set uses = uses + 1 where id = l.id;
  end if;
  return jsonb_build_object('list_id', l.list_id,
    'role', (select role from public.list_members where list_id = l.list_id and user_id = v_uid));
end $$;

-- Vue publique en lecture seule (sans compte) : colonnes sûres uniquement.
create function public.public_list_view(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare l public.invite_links; v_list public.lists;
begin
  select * into l from public.invite_links
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex')
     and allow_anonymous and revoked_at is null and expires_at > now();
  if not found then return null; end if;
  select * into v_list from public.lists where id = l.list_id and kind = 'wishes';
  if not found then return null; end if;
  return jsonb_build_object(
    'list', jsonb_build_object('id', v_list.id, 'title', v_list.title, 'emoji', v_list.emoji),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name, 'est_price', i.est_price, 'priority', i.priority,
        'category', i.category, 'status', i.status, 'link', i.link, 'notes', i.notes,
        'favorite', i.favorite, 'photo_path', i.photo_path, 'link_title', i.link_title,
        'link_image', i.link_image, 'link_description', i.link_description,
        'link_price', i.link_price, 'updated_at', i.updated_at) order by i.created_at desc)
      from public.items i where i.list_id = v_list.id), '[]'::jsonb));
end $$;

revoke all on function public.create_invite_link(uuid, text, integer, integer, text, boolean) from public, anon;
revoke all on function public.redeem_invite(text) from public, anon;
revoke all on function public.public_list_view(text) from public;
grant execute on function public.create_invite_link(uuid, text, integer, integer, text, boolean) to authenticated;
grant execute on function public.redeem_invite(text) to authenticated;
grant execute on function public.public_list_view(text) to anon, authenticated;

-- ---------- Photos (Storage) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gift-photos', 'gift-photos', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- chemin attendu : {list_id}/{item_id}/{fichier}
create function public.storage_list_id(p_name text) returns uuid
language sql immutable as $$
  select case when (storage.foldername(p_name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and array_length(storage.foldername(p_name), 1) = 2
         then ((storage.foldername(p_name))[1])::uuid end
$$;

create policy photos_select on storage.objects for select to authenticated
  using (bucket_id = 'gift-photos' and public.has_list_role(public.storage_list_id(name), 'reader'));
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'gift-photos' and public.has_list_role(public.storage_list_id(name), 'collaborator'));
create policy photos_update on storage.objects for update to authenticated
  using (bucket_id = 'gift-photos' and public.has_list_role(public.storage_list_id(name), 'collaborator'))
  with check (bucket_id = 'gift-photos' and public.has_list_role(public.storage_list_id(name), 'collaborator'));
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'gift-photos' and public.has_list_role(public.storage_list_id(name), 'collaborator'));

-- ---------- Temps réel (respecte RLS) ----------
alter table public.items replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.items, public.lists, public.list_members;
exception when undefined_object then null;
end $$;
