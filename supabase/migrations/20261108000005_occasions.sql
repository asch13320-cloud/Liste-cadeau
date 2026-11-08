-- Les listes ne sont plus seulement pour Noël : une « occasion » (Noël, anniversaire, baby shower…)
-- et une date facultative. Relançable sans erreur. Les listes existantes restent « Noël ».
alter table public.lists add column if not exists occasion text not null default 'christmas';
alter table public.lists add column if not exists event_date date;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lists_occasion_check') then
    alter table public.lists add constraint lists_occasion_check
      check (occasion in ('christmas', 'birthday', 'baby_shower', 'wedding', 'other'));
  end if;
end $$;
