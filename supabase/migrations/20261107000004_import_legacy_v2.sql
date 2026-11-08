-- =====================================================================
-- Import de l'ancienne version : fonction plus tolérante ET plus bavarde.
-- - Relançable sans erreur (create or replace).
-- - En cas d'échec, l'erreur indique l'élément et la ligne concernés.
-- - Ne touche à aucune donnée existante.
-- =====================================================================
create or replace function public.legacy_bool(t text) returns boolean
language sql immutable as $$
  select coalesce(lower(trim(t)) in ('true', 't', 'on', 'yes', 'oui', '1'), false)
$$;

create or replace function public.legacy_arr(x jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(x) = 'array' then x else '[]'::jsonb end
$$;

create or replace function public.import_legacy(p jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_list uuid; v_n int;
  v_person jsonb; v_it jsonb; v_ord bigint; v_pord bigint;
  c_lists int := 0; c_items int := 0; c_inbox int := 0; c_skipped int := 0;
  v_map jsonb := '[]'::jsonb; v_item_id uuid; v_ins boolean; v_key text; v_lkey text;
  v_ctx text := 'démarrage'; v_err_ctx text;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'invalid_payload'; end if;
  if jsonb_array_length(legacy_arr(p->'wishes')) + jsonb_array_length(legacy_arr(p->'inbox')) > 5000
     or jsonb_array_length(legacy_arr(p->'people')) > 500 then raise exception 'payload_too_large'; end if;

  -- 1) S.wishes → liste personnelle « Mes envies »
  v_ctx := 'création de la liste Mes envies';
  insert into lists (owner_id, kind, title, emoji, legacy_key)
  values (v_uid, 'wishes', 'Mes envies', '🎀', 'wishes')
  on conflict (owner_id, legacy_key) do nothing;
  get diagnostics v_n = row_count; c_lists := c_lists + v_n;
  select id into v_list from lists where owner_id = v_uid and legacy_key = 'wishes';

  for v_it, v_ord in select e.value, e.ord from jsonb_array_elements(legacy_arr(p->'wishes')) with ordinality as e(value, ord) loop
    continue when jsonb_typeof(v_it) <> 'object';
    v_key := 'w:' || coalesce(nullif(v_it->>'id', ''), 'n' || v_ord);
    v_ctx := 'envie n°' || v_ord || ' « ' || left(coalesce(v_it->>'name', ''), 40) || ' »';
    v_item_id := null;
    insert into items (list_id, created_by, name, est_price, priority, category, status, link, notes, favorite, legacy_key)
    values (v_list, v_uid, left(coalesce(nullif(trim(v_it->>'name'), ''), 'Sans titre'), 200),
            legacy_num(v_it->>'price'), legacy_priority(v_it->>'prio'), legacy_category(v_it->>'cat'),
            legacy_status(v_it->>'status'), legacy_link(v_it->>'link'), left(nullif(v_it->>'notes', ''), 2000),
            legacy_bool(v_it->>'fav'), v_key)
    on conflict (list_id, legacy_key) do nothing
    returning id into v_item_id;
    v_ins := v_item_id is not null;
    if v_ins then c_items := c_items + 1; else c_skipped := c_skipped + 1;
      select id into v_item_id from items where list_id = v_list and legacy_key = v_key; end if;
    v_map := v_map || jsonb_build_object('list_id', v_list, 'item_id', v_item_id, 'legacy', v_key,
                       'inserted', v_ins, 'has_photo', coalesce(v_it->>'photo', '') <> '');
  end loop;

  -- 2) S.people → une liste « cadeaux pour … » par personne
  for v_person, v_pord in select e.value, e.ord from jsonb_array_elements(legacy_arr(p->'people')) with ordinality as e(value, ord) loop
    continue when jsonb_typeof(v_person) <> 'object';
    v_lkey := 'p:' || coalesce(nullif(v_person->>'id', ''), 'n' || v_pord);
    v_ctx := 'carnet n°' || v_pord || ' « ' || left(coalesce(v_person->>'name', ''), 40) || ' »';
    insert into lists (owner_id, kind, title, emoji, budget, legacy_key)
    values (v_uid, 'gifts_for', left(coalesce(nullif(trim(v_person->>'name'), ''), 'Sans nom'), 120),
            left(coalesce(nullif(v_person->>'emoji', ''), '🎀'), 16), legacy_num(v_person->>'budget'), v_lkey)
    on conflict (owner_id, legacy_key) do nothing;
    get diagnostics v_n = row_count; c_lists := c_lists + v_n;
    select id into v_list from lists where owner_id = v_uid and legacy_key = v_lkey;

    for v_it, v_ord in select e.value, e.ord from jsonb_array_elements(legacy_arr(v_person->'gifts')) with ordinality as e(value, ord) loop
      continue when jsonb_typeof(v_it) <> 'object';
      v_key := 'g:' || coalesce(nullif(v_it->>'id', ''), 'n' || v_ord);
      v_ctx := 'cadeau n°' || v_ord || ' « ' || left(coalesce(v_it->>'name', ''), 40) || ' » du carnet « ' || left(coalesce(v_person->>'name', ''), 40) || ' »';
      v_item_id := null;
      insert into items (list_id, created_by, name, est_price, spent, priority, category, status, link, notes,
                         favorite, bought, wrapped, legacy_key)
      values (v_list, v_uid, left(coalesce(nullif(trim(v_it->>'name'), ''), 'Sans titre'), 200),
              legacy_num(v_it->>'price'), legacy_num(v_it->>'spent'), legacy_priority(v_it->>'prio'),
              legacy_category(v_it->>'cat'), legacy_status(v_it->>'status'), legacy_link(v_it->>'link'),
              left(nullif(v_it->>'notes', ''), 2000), legacy_bool(v_it->>'fav'),
              legacy_bool(v_it->>'bought'), legacy_bool(v_it->>'wrapped'), v_key)
      on conflict (list_id, legacy_key) do nothing
      returning id into v_item_id;
      v_ins := v_item_id is not null;
      if v_ins then c_items := c_items + 1; else c_skipped := c_skipped + 1;
        select id into v_item_id from items where list_id = v_list and legacy_key = v_key; end if;
      v_map := v_map || jsonb_build_object('list_id', v_list, 'item_id', v_item_id, 'legacy', v_key,
                         'inserted', v_ins, 'has_photo', coalesce(v_it->>'photo', '') <> '');
    end loop;
  end loop;

  -- 3) S.inbox → tiroir à idées
  for v_it, v_ord in select e.value, e.ord from jsonb_array_elements(legacy_arr(p->'inbox')) with ordinality as e(value, ord) loop
    continue when jsonb_typeof(v_it) <> 'object';
    v_ctx := 'idée en vrac n°' || v_ord || ' « ' || left(coalesce(v_it->>'t', ''), 40) || ' »';
    insert into inbox_items (user_id, text, legacy_key)
    values (v_uid, left(coalesce(nullif(trim(v_it->>'t'), ''), '(vide)'), 1000), 'i:' || coalesce(nullif(v_it->>'id', ''), 'n' || v_ord))
    on conflict (user_id, legacy_key) do nothing;
    get diagnostics v_n = row_count; c_inbox := c_inbox + v_n; c_skipped := c_skipped + (1 - v_n);
  end loop;

  return jsonb_build_object('lists_created', c_lists, 'items_created', c_items, 'inbox_created', c_inbox,
                            'skipped_existing', c_skipped, 'items', v_map);
exception when others then
  -- on précise OÙ ça a échoué (élément + ligne de la fonction) pour pouvoir corriger vite
  get stacked diagnostics v_err_ctx = pg_exception_context;
  raise exception '%', sqlerrm using errcode = sqlstate, detail = 'élément : ' || v_ctx, hint = right(coalesce(v_err_ctx, ''), 160);
end $$;

revoke all on function public.import_legacy(jsonb) from public, anon;
grant execute on function public.import_legacy(jsonb) to authenticated;
