-- =====================================================================
-- Import des données de l'ancienne version (localStorage « noel2026 »)
-- - S'exécute avec les droits de l'utilisateur connecté (RLS appliquée).
-- - Relançable : chaque élément porte une legacy_key ; en cas de doublon on
--   NE TOUCHE PAS à l'existant (les modifications faites depuis sont conservées).
-- - Les photos sont envoyées ensuite par l'application (les ids sont renvoyés).
-- =====================================================================
create function public.legacy_num(t text) returns numeric
language sql immutable as $$
  select case when t ~ '^\s*[0-9]{1,8}([.,][0-9]{1,4})?\s*$'
              then round(replace(trim(t), ',', '.')::numeric, 2) end
$$;

create function public.legacy_priority(t text) returns text
language sql immutable as $$
  select case when t ilike '%adorer%' then 'love' when t ilike '%aime bien%' then 'like'
              when t is null or t = '' then null else 'maybe' end
$$;

create function public.legacy_category(t text) returns text
language sql immutable as $$
  select case when t is null or t = '' then null
              else case t when 'Beauté' then 'beauty' when 'Vêtements' then 'clothes' when 'Maison' then 'home'
                          when 'Tech' then 'tech' when 'Loisirs' then 'leisure' else 'other' end end
$$;

create function public.legacy_status(t text) returns text
language sql immutable as $$
  select case t when 'Idée' then 'idea' when 'Envie' then 'wish' when 'Reçu' then 'received' else null end
$$;

create function public.legacy_link(t text) returns text
language sql immutable as $$
  select case when t ~* '^https?://' and char_length(t) <= 2000 then t end
$$;

create function public.import_legacy(p jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_list uuid; v_n int;
  v_person jsonb; v_it jsonb;
  c_lists int := 0; c_items int := 0; c_inbox int := 0; c_skipped int := 0;
  v_map jsonb := '[]'::jsonb; v_item_id uuid; v_ins boolean;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'invalid_payload'; end if;
  if coalesce(jsonb_array_length(p->'wishes'), 0) + coalesce(jsonb_array_length(p->'inbox'), 0) > 5000
     or coalesce(jsonb_array_length(p->'people'), 0) > 500 then raise exception 'payload_too_large'; end if;

  -- 1) S.wishes → liste personnelle « Mes envies »
  insert into lists (owner_id, kind, title, emoji, legacy_key)
  values (v_uid, 'wishes', 'Mes envies', '🎀', 'wishes')
  on conflict (owner_id, legacy_key) do nothing;
  get diagnostics v_n = row_count; c_lists := c_lists + v_n;
  select id into v_list from lists where owner_id = v_uid and legacy_key = 'wishes';

  for v_it in select * from jsonb_array_elements(coalesce(p->'wishes', '[]'::jsonb)) loop
    insert into items (list_id, created_by, name, est_price, priority, category, status, link, notes, favorite, legacy_key)
    values (v_list, v_uid, left(coalesce(nullif(trim(v_it->>'name'), ''), 'Sans titre'), 200),
            legacy_num(v_it->>'price'), legacy_priority(v_it->>'prio'), legacy_category(v_it->>'cat'),
            legacy_status(v_it->>'status'), legacy_link(v_it->>'link'), left(nullif(v_it->>'notes', ''), 2000),
            coalesce((v_it->>'fav')::boolean, false), 'w:' || (v_it->>'id'))
    on conflict (list_id, legacy_key) do nothing
    returning id into v_item_id;
    v_ins := v_item_id is not null;
    if v_ins then c_items := c_items + 1; else c_skipped := c_skipped + 1;
      select id into v_item_id from items where list_id = v_list and legacy_key = 'w:' || (v_it->>'id'); end if;
    v_map := v_map || jsonb_build_object('list_id', v_list, 'item_id', v_item_id,
                       'legacy', 'w:' || (v_it->>'id'), 'inserted', v_ins, 'has_photo', coalesce(v_it->>'photo', '') <> '');
    v_item_id := null;
  end loop;

  -- 2) S.people → une liste « cadeaux pour … » par personne
  for v_person in select * from jsonb_array_elements(coalesce(p->'people', '[]'::jsonb)) loop
    insert into lists (owner_id, kind, title, emoji, budget, legacy_key)
    values (v_uid, 'gifts_for', left(coalesce(nullif(trim(v_person->>'name'), ''), 'Sans nom'), 120),
            left(coalesce(nullif(v_person->>'emoji', ''), '🎀'), 16), legacy_num(v_person->>'budget'),
            'p:' || (v_person->>'id'))
    on conflict (owner_id, legacy_key) do nothing;
    get diagnostics v_n = row_count; c_lists := c_lists + v_n;
    select id into v_list from lists where owner_id = v_uid and legacy_key = 'p:' || (v_person->>'id');

    for v_it in select * from jsonb_array_elements(coalesce(v_person->'gifts', '[]'::jsonb)) loop
      insert into items (list_id, created_by, name, est_price, spent, priority, category, status, link, notes,
                         favorite, bought, wrapped, legacy_key)
      values (v_list, v_uid, left(coalesce(nullif(trim(v_it->>'name'), ''), 'Sans titre'), 200),
              legacy_num(v_it->>'price'), legacy_num(v_it->>'spent'), legacy_priority(v_it->>'prio'),
              legacy_category(v_it->>'cat'), legacy_status(v_it->>'status'), legacy_link(v_it->>'link'),
              left(nullif(v_it->>'notes', ''), 2000), coalesce((v_it->>'fav')::boolean, false),
              coalesce((v_it->>'bought')::boolean, false), coalesce((v_it->>'wrapped')::boolean, false),
              'g:' || (v_it->>'id'))
      on conflict (list_id, legacy_key) do nothing
      returning id into v_item_id;
      v_ins := v_item_id is not null;
      if v_ins then c_items := c_items + 1; else c_skipped := c_skipped + 1;
        select id into v_item_id from items where list_id = v_list and legacy_key = 'g:' || (v_it->>'id'); end if;
      v_map := v_map || jsonb_build_object('list_id', v_list, 'item_id', v_item_id,
                         'legacy', 'g:' || (v_it->>'id'), 'inserted', v_ins, 'has_photo', coalesce(v_it->>'photo', '') <> '');
      v_item_id := null;
    end loop;
  end loop;

  -- 3) S.inbox → tiroir à idées
  for v_it in select * from jsonb_array_elements(coalesce(p->'inbox', '[]'::jsonb)) loop
    insert into inbox_items (user_id, text, legacy_key)
    values (v_uid, left(coalesce(nullif(trim(v_it->>'t'), ''), '(vide)'), 1000), 'i:' || (v_it->>'id'))
    on conflict (user_id, legacy_key) do nothing;
    get diagnostics v_n = row_count; c_inbox := c_inbox + v_n; c_skipped := c_skipped + (1 - v_n);
  end loop;

  return jsonb_build_object('lists_created', c_lists, 'items_created', c_items, 'inbox_created', c_inbox,
                            'skipped_existing', c_skipped, 'items', v_map);
end $$;

revoke all on function public.import_legacy(jsonb) from public, anon;
grant execute on function public.import_legacy(jsonb) to authenticated;
