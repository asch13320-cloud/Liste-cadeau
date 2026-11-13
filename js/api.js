/* Couche de données V2 : tout ce qui parle à Supabase. Les droits réels sont dans la base (RLS) ;
   ce code ne fait jamais confiance à l'interface pour la sécurité. */
(function (root) {
  'use strict';

  const MESSAGES = {
    invalid_or_expired_invite: 'Ce lien n’est plus valide (expiré, révoqué ou déjà utilisé).',
    anonymous_link_not_allowed: 'Un lien sans compte n’est possible que pour une liste d’envies.',
    not_authenticated: 'Connecte-toi d’abord.',
    forbidden: 'Seul le propriétaire peut faire ça.',
    conflict: 'Quelqu’un vient de modifier cet élément. Les données ont été rechargées : vérifie puis réessaie.',
    invalid_ttl: 'Durée de validité invalide.',
    invalid_max_uses: 'Nombre d’utilisations invalide.'
  };

  const uerr = (m) => { const e = new Error(m); e.user = true; return e; };

  function friendly(e) {
    if (!e) return 'Une erreur est survenue.';
    if (e.user) return e.message;
    if (e.conflict) return MESSAGES.conflict;
    const m = String(e.message || e.error_description || e);
    for (const k of Object.keys(MESSAGES)) if (m.includes(k)) return MESSAGES[k];
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return 'Connexion impossible. Vérifie ton réseau puis réessaie.';
    if (/Invalid login credentials/i.test(m)) return 'E-mail ou mot de passe incorrect.';
    if (/Email not confirmed/i.test(m)) return 'Ton adresse e-mail n’est pas encore confirmée : ouvre l’e-mail de confirmation reçu.';
    if (/password.*(at least|short|weak)|Password should/i.test(m)) { const n = /at least (\d+)/i.exec(m); return 'Mot de passe trop court (' + (n ? n[1] : 6) + ' caractères minimum).'; }
    if (/rate limit|too many/i.test(m)) return 'Trop de tentatives. Patiente quelques minutes.';
    if (/row-level security|permission denied/i.test(m)) return 'Tu n’as pas les droits pour faire ça.';
    return 'Une erreur est survenue : ' + m.slice(0, 140);
  }

  const isNetworkError = (e) => /Failed to fetch|NetworkError|Load failed|network/i.test(String((e && e.message) || e));
  const must = (r) => { if (r.error) throw r.error; return r.data; };

  // ---- validation / nettoyage des champs avant envoi
  const PRIOS = ['love', 'like', 'maybe'], CATS = ['beauty', 'clothes', 'home', 'tech', 'leisure', 'other'], STATS = ['idea', 'wish', 'received'];
  const OCCS = ['christmas', 'birthday', 'baby_shower', 'wedding', 'other'];
  const occ = (v) => (OCCS.includes(v) ? v : 'christmas');
  const day = (v) => { const x = String(v || '').trim(); if (!x) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(x) || isNaN(new Date(x + 'T12:00:00'))) throw uerr('Date invalide.'); return x; };
  const noOccCol = (e) => e && /occasion|event_date/.test(String(e.message || '')) && /column|schema cache/i.test(String(e.message || ''));
  const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,80}$/;
  const photoList = (it) => (it && Array.isArray(it.photo_paths) && it.photo_paths.length ? it.photo_paths : it && it.photo_path ? [it.photo_path] : []);
  const noPhotosCol = (e) => e && /photo_paths/.test(String(e.message || '')) && /column|schema cache/i.test(String(e.message || ''));
  const safeUrl = (u) => {
    const v = String(u || '').trim();
    if (!v) return null;
    if (v.length > 2000 || !/^https?:\/\//i.test(v)) throw uerr('Le lien doit commencer par http:// ou https://');
    try { new URL(v); } catch (e) { throw uerr('Lien invalide.'); }
    return v;
  };
  const num = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 99999999) throw uerr('Montant invalide.');
    return Math.round(n * 100) / 100;
  };
  const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : null; };

  function cleanItem(f) {
    const o = {};
    if ('name' in f) { const n = txt(f.name, 200); if (!n) throw uerr('Le nom est obligatoire.'); o.name = n; }
    if ('est_price' in f) o.est_price = num(f.est_price);
    if ('spent' in f) o.spent = num(f.spent);
    if ('priority' in f) o.priority = PRIOS.includes(f.priority) ? f.priority : null;
    if ('category' in f) o.category = CATS.includes(f.category) ? f.category : null;
    if ('status' in f) o.status = STATS.includes(f.status) ? f.status : null;
    if ('link' in f) o.link = safeUrl(f.link);
    if ('notes' in f) o.notes = txt(f.notes, 2000);
    if ('favorite' in f) o.favorite = !!f.favorite;
    if ('bought' in f) o.bought = !!f.bought;
    if ('wrapped' in f) o.wrapped = !!f.wrapped;
    if ('link_title' in f) o.link_title = txt(f.link_title, 300);
    if ('link_description' in f) o.link_description = txt(f.link_description, 1000);
    if ('link_image' in f) { try { o.link_image = safeUrl(f.link_image); } catch (e) { o.link_image = null; } }
    if ('link_price' in f) { try { const p = num(f.link_price); o.link_price = p && p > 0 ? p : null; } catch (e) { o.link_price = null; } }
    if ('photo_path' in f) o.photo_path = f.photo_path || null;
    if ('photo_paths' in f) { const a = Array.isArray(f.photo_paths) ? f.photo_paths : []; if (a.length > 10) throw uerr('10 photos maximum par cadeau.'); o.photo_paths = a.filter((x) => typeof x === 'string' && PATH_RE.test(x)); }
    return o;
  }

  // ---- images : redimensionnement côté navigateur (JPEG, 1280 px max, < 3 Mo)
  async function resizeImage(file) {
    if (!file || !/^image\//.test(file.type || '')) throw uerr('Ce fichier n’est pas une image.');
    if (file.size > 25 * 1024 * 1024) throw uerr('Image trop lourde (25 Mo maximum).');
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      bmp = await new Promise((res, rej) => {
        const im = new Image(), u = URL.createObjectURL(file);
        im.onload = () => { URL.revokeObjectURL(u); res(im); };
        im.onerror = () => { URL.revokeObjectURL(u); rej(uerr('Image illisible.')); };
        im.src = u;
      });
    }
    const w = bmp.width, h = bmp.height, k = Math.min(1, 1280 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.7, 0.55, 0.4]) {
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= 2.8 * 1024 * 1024) return blob;
    }
    throw uerr('Image trop lourde même après compression.');
  }

  const dataUrlToBlob = (d) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(d || '');
    if (!m) return null;
    const bin = atob(m[2]), a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: m[1] });
  };

  const newId = () => (root.crypto && crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));

  function makeApi(sb, cfg) {
    const api = { sb, friendly, isNetworkError, cleanItem, safeUrl };
    const BUCKET = 'gift-photos';

    // ---------- Auth
    api.getSession = async () => (await sb.auth.getSession()).data.session;
    api.signUp = async (email, password, name) => must(await sb.auth.signUp({ email, password, options: { data: { display_name: txt(name, 60) || '' }, emailRedirectTo: cfg.site } }));
    api.signIn = async (email, password) => must(await sb.auth.signInWithPassword({ email, password }));
    api.resend = async (email) => { const r = await sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: cfg.site } }); if (r.error) throw r.error; };
    api.signOut = async () => { const r = await sb.auth.signOut(); if (r.error) throw r.error; };
    api.resetPassword = async (email) => { const r = await sb.auth.resetPasswordForEmail(email, { redirectTo: cfg.site }); if (r.error) throw r.error; };
    api.setPassword = async (pw) => { const r = await sb.auth.updateUser({ password: pw }); if (r.error) throw r.error; };

    // ---------- Chargement complet (petites données : on recharge tout, c'est simple et fiable)
    api.loadAll = async (user) => {
      const [lists, members, items, profiles, notes, inbox] = await Promise.all([
        sb.from('lists').select('*').order('created_at', { ascending: true }),
        sb.from('list_members').select('list_id,user_id,role'),
        sb.from('items').select('*').order('created_at', { ascending: false }).limit(5000),
        sb.from('profiles').select('id,display_name'),
        sb.from('item_private_notes').select('item_id,notes'),
        sb.from('inbox_items').select('id,text,created_at').order('created_at', { ascending: false })
      ].map((p) => p.then(must)));
      const names = {}; profiles.forEach((p) => { names[p.id] = p.display_name || ''; });
      const mem = {}; members.forEach((m) => { (mem[m.list_id] = mem[m.list_id] || []).push(m); });
      const D = { me: { id: user.id, email: user.email, name: names[user.id] || '' }, names, lists: [], members: mem, items: {}, notes: {}, inbox };
      lists.forEach((l) => {
        const mine = (mem[l.id] || []).find((m) => m.user_id === user.id);
        D.lists.push({ ...l, role: mine ? mine.role : (l.owner_id === user.id ? 'owner' : 'reader') });
        D.items[l.id] = [];
      });
      items.forEach((i) => { (D.items[i.list_id] = D.items[i.list_id] || []).push(i); });
      notes.forEach((n) => { D.notes[n.item_id] = n.notes; });
      return D;
    };

    // ---------- Profil
    api.setName = async (uid, name) => { const r = await sb.from('profiles').update({ display_name: txt(name, 60) || '' }).eq('id', uid); if (r.error) throw r.error; };

    // ---------- Listes
    api.createList = async ({ title, emoji, kind, budget, occasion, eventDate }) => {
      const t = txt(title, 120); if (!t) throw uerr('Le titre est obligatoire.');
      const uid = (await sb.auth.getUser()).data.user.id;
      const row = { owner_id: uid, title: t, emoji: txt(emoji, 16) || '🎀', kind: kind === 'gifts_for' ? 'gifts_for' : 'wishes', budget: kind === 'gifts_for' ? num(budget) : null, occasion: occ(occasion), event_date: day(eventDate) };
      let r = await sb.from('lists').insert(row).select().single();
      if (r.error && noOccCol(r.error)) { delete row.occasion; delete row.event_date; r = await sb.from('lists').insert(row).select().single(); api.needsMigration5 = true; }
      return must(r);
    };
    api.updateList = async (id, { title, emoji, budget, occasion, eventDate }) => {
      const p = {}; if (title !== undefined) { p.title = txt(title, 120); if (!p.title) throw uerr('Le titre est obligatoire.'); }
      if (emoji !== undefined) p.emoji = txt(emoji, 16) || '🎀'; if (budget !== undefined) p.budget = num(budget);
      if (occasion !== undefined) p.occasion = occ(occasion); if (eventDate !== undefined) p.event_date = day(eventDate);
      let r = await sb.from('lists').update(p).eq('id', id).select();
      if (r.error && noOccCol(r.error)) { delete p.occasion; delete p.event_date; api.needsMigration5 = true; r = await sb.from('lists').update(p).eq('id', id).select(); }
      if (!must(r).length) throw new Error('forbidden');
    };
    api.deleteList = async (id, paths) => {
      if (paths && paths.length) await sb.storage.from(BUCKET).remove(paths);
      const r = await sb.from('lists').delete().eq('id', id).select();
      if (!must(r).length) throw new Error('forbidden');
    };

    // ---------- Cadeaux
    // Si la base n'a pas encore la migration 6 (plusieurs photos), on garde au moins la 1re photo.
    const downgrade = (row) => { if ('photo_paths' in row) { const a = row.photo_paths; delete row.photo_paths; row.photo_path = a && a.length ? a[0] : null; api.needsMigration6 = true; } return row; };
    api.createItem = async (listId, fields, id) => {
      const row = { ...cleanItem(fields), list_id: listId }; if (id) row.id = id;
      let r = await sb.from('items').insert(row).select().single();
      if (r.error && noPhotosCol(r.error)) r = await sb.from('items').insert(downgrade(row)).select().single();
      return must(r);
    };
    api.updateItem = async (item, patch) => {
      const p = cleanItem(patch);
      let r = await sb.from('items').update(p).eq('id', item.id).eq('version', item.version).select().maybeSingle();
      if (r.error && noPhotosCol(r.error)) r = await sb.from('items').update(downgrade(p)).eq('id', item.id).eq('version', item.version).select().maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) { const e = new Error('conflict'); e.conflict = true; throw e; }
      return r.data;
    };
    api.deleteItem = async (item) => {
      const ps = photoList(item); if (ps.length) await sb.storage.from(BUCKET).remove(ps).catch(() => {});
      const r = await sb.from('items').delete().eq('id', item.id).select();
      if (!must(r).length) throw new Error('forbidden');
    };
    api.removePhotos = async (paths) => { if (paths && paths.length) await sb.storage.from(BUCKET).remove(paths); };
    api.setPrivateNote = async (itemId, notes) => {
      const n = txt(notes, 2000);
      if (!n) { const r = await sb.from('item_private_notes').delete().eq('item_id', itemId); if (r.error) throw r.error; return; }
      const uid = (await sb.auth.getUser()).data.user.id;
      const r = await sb.from('item_private_notes').upsert({ item_id: itemId, user_id: uid, notes: n, updated_at: new Date().toISOString() }, { onConflict: 'item_id,user_id' });
      if (r.error) throw r.error;
    };

    // ---------- Photos
    api.uploadPhoto = async (listId, itemId, fileOrBlob, alreadyResized) => {
      const blob = alreadyResized ? fileOrBlob : await resizeImage(fileOrBlob);
      const path = `${listId}/${itemId}/${newId()}.jpg`;
      const r = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (r.error) throw r.error;
      return path;
    };
    api.removePhoto = async (path) => { if (path) await sb.storage.from(BUCKET).remove([path]); };
    api.copyPhoto = async (from, to) => { const r = await sb.storage.from(BUCKET).copy(from, to); if (r.error) throw r.error; };
    api.signPhotos = async (paths) => {
      if (!paths.length) return {};
      const r = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
      if (r.error) throw r.error;
      const out = {}; (r.data || []).forEach((x) => { if (x && x.signedUrl && x.path) out[x.path] = x.signedUrl; });
      return out;
    };

    // ---------- Aperçu d'un lien produit (fonction serveur ; peut être indisponible)
    api.linkPreview = async (url) => {
      const u = safeUrl(url);
      try {
        const r = await sb.functions.invoke('fetch-og', { body: { url: u } });
        if (r.error || !r.data || r.data.error) return null;
        return r.data;
      } catch (e) { return null; }
    };

    // Photo du produit : téléchargée par la fonction serveur (les sites bloquent souvent l'affichage direct)
    api.fetchLinkImage = async (url) => {
      const r = await sb.functions.invoke('fetch-og', { body: { image: safeUrl(url) } });
      if (r.error || !r.data || r.data.error || !r.data.base64) throw uerr('Photo du site indisponible.');
      const bin = atob(r.data.base64), a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return new Blob([a], { type: r.data.contentType || 'image/jpeg' });
    };

    // ---------- Membres et invitations
    api.setMemberRole = async (listId, userId, role) => {
      const r = await sb.from('list_members').update({ role }).eq('list_id', listId).eq('user_id', userId).select();
      if (!must(r).length) throw new Error('forbidden');
    };
    api.removeMember = async (listId, userId) => {
      const r = await sb.from('list_members').delete().eq('list_id', listId).eq('user_id', userId).select();
      if (!must(r).length) throw new Error('forbidden');
    };
    api.createInvite = async (p) => {
      const r = await sb.rpc('create_invite_link', { p_list: p.list, p_role: p.role, p_ttl_hours: p.ttl, p_max_uses: p.maxUses, p_email: p.email || null, p_anonymous: !!p.anonymous });
      return must(r);
    };
    api.listInvites = async (listId) => must(await sb.from('invite_links').select('id,role,email,allow_anonymous,expires_at,revoked_at,max_uses,uses,created_at').eq('list_id', listId).order('created_at', { ascending: false }));
    api.revokeInvite = async (id) => { const r = await sb.from('invite_links').update({ revoked_at: new Date().toISOString() }).eq('id', id).select(); if (!must(r).length) throw new Error('forbidden'); };
    api.redeem = async (token) => must(await sb.rpc('redeem_invite', { p_token: token }));
    api.publicView = async (token) => must(await sb.rpc('public_list_view', { p_token: token }));

    // ---------- Tiroir à idées
    api.addIdea = async (text) => { const t = txt(text, 1000); if (!t) return; const r = await sb.from('inbox_items').insert({ text: t }); if (r.error) throw r.error; };
    api.deleteIdea = async (id) => { const r = await sb.from('inbox_items').delete().eq('id', id); if (r.error) throw r.error; };

    // ---------- Temps réel (les droits sont appliqués par la base ; on recharge à chaque évènement)
    api.subscribe = (uid, onChange, onStatus) => {
      const ch = sb.channel('v2-' + uid);
      ['items', 'lists', 'list_members'].forEach((t) => ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => onChange(t)));
      ch.subscribe((s) => onStatus && onStatus(s));
      return () => { try { sb.removeChannel(ch); } catch (e) { /* ignore */ } };
    };

    // ---------- Migration depuis l'ancienne version (localStorage)
    api.importLegacy = async (payload) => must(await sb.rpc('import_legacy', { p: payload }));
    api.verifyLegacy = async () => {
      const [lists, items, inbox] = await Promise.all([
        sb.from('lists').select('id,legacy_key').not('legacy_key', 'is', null),
        sb.from('items').select('id,legacy_key,photo_path,list_id,version').not('legacy_key', 'is', null),
        sb.from('inbox_items').select('id,legacy_key').not('legacy_key', 'is', null)
      ].map((p) => p.then(must)));
      return { lists, items, inbox };
    };

    return api;
  }

  root.V2API = { photoList, makeApi, friendly, isNetworkError, resizeImage, dataUrlToBlob, cleanItem, safeUrl, newId };
})(typeof window !== 'undefined' ? window : globalThis);
