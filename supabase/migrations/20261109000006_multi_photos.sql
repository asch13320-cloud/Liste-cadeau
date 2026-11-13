-- Plusieurs photos par cadeau (carrousel). Relançable sans erreur.
-- photo_paths = liste ordonnée (la 1re est la couverture) ; photo_path reste synchronisée avec la 1re
-- (compatibilité avec les anciennes versions de l'application).
alter table public.items add column if not exists photo_paths text[] not null default '{}';

update public.items set photo_paths = array[photo_path]
 where photo_path is not null and cardinality(photo_paths) = 0;

create or replace function public.valid_photo_paths(p text[]) returns boolean
language sql immutable as $$
  select coalesce(bool_and(x ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$'), true) from unnest(p) as x
$$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'items_photo_paths_check') then
    alter table public.items add constraint items_photo_paths_check
      check (cardinality(photo_paths) <= 10 and public.valid_photo_paths(photo_paths));
  end if;
end $$;

create or replace function public.items_sync_photos() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if cardinality(new.photo_paths) = 0 and new.photo_path is not null then new.photo_paths := array[new.photo_path]; end if;
    new.photo_path := new.photo_paths[1];
  else
    if new.photo_paths is distinct from old.photo_paths then
      new.photo_path := new.photo_paths[1];                 -- la liste fait foi
    elsif new.photo_path is distinct from old.photo_path then
      new.photo_paths := case when new.photo_path is null then '{}'::text[] else array[new.photo_path] end;  -- ancien client
    end if;
  end if;
  return new;
end $$;

drop trigger if exists items_sync_photos on public.items;
create trigger items_sync_photos before insert or update on public.items
for each row execute function public.items_sync_photos();
