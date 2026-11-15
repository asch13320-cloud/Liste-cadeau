-- Liens d'invitation courts : 22 caractères au lieu de 64. Les anciens liens restent valides.
-- Relançable sans erreur.
create or replace function public.create_invite_link(
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
  -- 22 caractères (16 octets aléatoires en base64 « url-safe ») : aussi sûr qu'avant en pratique, bien plus court à envoyer
  v_token := translate(rtrim(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '='), '+/', '-_');
  insert into public.invite_links (list_id, role, token_hash, email, allow_anonymous, expires_at, max_uses)
  values (p_list, p_role, encode(sha256(convert_to(v_token, 'utf8')), 'hex'),
          nullif(lower(trim(p_email)), ''), coalesce(p_anonymous, false),
          now() + make_interval(hours => p_ttl_hours), p_max_uses)
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'token', v_token, 'expires_at', v_row.expires_at);
end $$;

revoke all on function public.create_invite_link(uuid, text, integer, integer, text, boolean) from public, anon;
grant execute on function public.create_invite_link(uuid, text, integer, integer, text, boolean) to authenticated;
