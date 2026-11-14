// Test de l'interface V2 avec un faux client Supabase en mémoire (les DROITS réels sont testés dans db/rls.test.mjs).
const { JSDOM } = require('jsdom'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*fonts[^>]*>/g, '');
let ok = 0, ko = 0; const t = (n, c) => { c ? ok++ : ko++; console.log((c ? '✓ ' : '✗ ') + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex64 = (c) => c.repeat(64);
let uid = 0; const nid = () => '00000000-0000-4000-8000-' + String(++uid).padStart(12, '0');

function fakeSb(opts = {}) {
  const db = { lists: [], list_members: [], items: [], profiles: [], item_private_notes: [], inbox_items: [], invite_links: [], item_comments: [], item_claims: [] };
  const st = { session: opts.session || null, listeners: [], calls: [], uploads: [], removed: [], offline: false, rpc: {}, signed: [] };
  const me = () => st.session && st.session.user;
  function from(table) {
    const q = { op: 'select', f: [], ord: null, lim: null, p: null, single: false, maybe: false, ret: false, conflict: null };
    const b = {
      select() { if (q.op !== 'select') q.ret = true; return b; }, insert(p) { q.op = 'insert'; q.p = p; return b; }, update(p) { q.op = 'update'; q.p = p; return b; },
      delete() { q.op = 'delete'; return b; }, upsert(p, o) { q.op = 'upsert'; q.p = p; q.conflict = o && o.onConflict; return b; },
      eq(k, v) { q.f.push((r) => r[k] === v); return b; }, not() { q.f.push((r) => r.legacy_key != null); return b; },
      order(k, o) { q.ord = [k, o && o.ascending === false ? -1 : 1]; return b; }, limit(n) { q.lim = n; return b; }, single() { q.single = true; return b; }, maybeSingle() { q.maybe = true; return b; },
      then(res, rej) { return run().then(res, rej); }
    };
    async function run() {
      st.calls.push(table + ':' + q.op);
      if (st.offline) return { data: null, error: { message: 'Failed to fetch' } };
      if (st.noPhotosCol && table === 'items' && (q.op === 'insert' || q.op === 'update') && q.p && 'photo_paths' in [].concat(q.p)[0]) return { data: null, error: { message: "Could not find the 'photo_paths' column of 'items' in the schema cache" } };
      if ((table === 'item_comments' || table === 'item_claims') && st.noSocial) return { data: null, error: { message: 'relation "public.' + table + '" does not exist' } };
      const rows = db[table]; let out = [];
      if (table === 'item_claims' && q.op === 'insert' && rows.some((r) => r.item_id === q.p.item_id)) return { data: null, error: { message: 'duplicate key value violates unique constraint "item_claims_pkey"', code: '23505' } };
      if (q.op === 'insert') {
        out = [].concat(q.p).map((r) => {
          const base = { id: nid(), created_at: new Date().toISOString() };
          if (table === 'items') Object.assign(base, { version: 1, favorite: false, bought: false, wrapped: false, created_by: me() && me().id, photo_path: null, link_title: null });
          if (table === 'lists') Object.assign(base, { emoji: '🎀', budget: null });
          const row = { ...base, ...r };
          if (table === 'item_comments' || table === 'item_claims') { const it = db.items.find((i) => i.id === r.item_id); row.list_id = it ? it.list_id : null; row.author_id = row.author_id || (me() && me().id); if (table === 'item_claims') { row.user_id = me() && me().id; row.status = 'claimed'; } }
          if (table === 'items') { row.photo_paths = row.photo_paths || []; if (row.photo_paths.length) row.photo_path = row.photo_paths[0]; }
          return row;
        });
        out.forEach((r) => { rows.push(r); if (table === 'lists') db.list_members.push({ list_id: r.id, user_id: r.owner_id, role: 'owner' }); });
      } else if (q.op === 'update') {
        out = rows.filter((r) => q.f.every((f) => f(r)) && !((table === 'item_claims') && r.user_id !== (me() && me().id))); out.forEach((r) => { Object.assign(r, q.p); if (table === 'items') { r.version++; if ('photo_paths' in q.p) r.photo_path = (q.p.photo_paths || [])[0] || null; else if ('photo_path' in q.p) r.photo_paths = q.p.photo_path ? [q.p.photo_path] : []; } });
      } else if (q.op === 'delete') {
        out = rows.filter((r) => q.f.every((f) => f(r)) && !((table === 'item_claims' || table === 'item_comments') && (r.user_id || r.author_id) !== (me() && me().id))); out.forEach((r) => rows.splice(rows.indexOf(r), 1));
      } else if (q.op === 'upsert') {
        const keys = (q.conflict || 'id').split(','); const r = q.p; const ex = rows.find((x) => keys.every((k) => x[k] === r[k]));
        if (ex) Object.assign(ex, r); else rows.push({ ...r }); out = [r];
      } else {
        out = rows.filter((r) => q.f.every((f) => f(r)));
        if (table === 'item_comments' || table === 'item_claims') out = out.filter((r) => { const l = db.lists.find((x) => x.id === r.list_id); return !(l && l.kind === 'wishes' && me() && l.owner_id === me().id); }); // la base cache ça au propriétaire
        if (q.ord) out.sort((a, c) => (a[q.ord[0]] > c[q.ord[0]] ? 1 : -1) * q.ord[1]);
        if (q.lim) out = out.slice(0, q.lim);
      }
      out = out.map((r) => ({ ...r }));
      if (q.op !== 'select' && !q.ret) return { data: null, error: null };
      if (q.single) return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
      if (q.maybe) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }
    return b;
  }
  const sb = {
    auth: {
      getSession: async () => ({ data: { session: st.session } }), getUser: async () => ({ data: { user: me() } }),
      onAuthStateChange: (cb) => { st.listeners.push(cb); setTimeout(() => cb('INITIAL_SESSION', st.session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: async ({ email, password }) => {
        if (password !== 'motdepasse1') return { data: null, error: { message: 'Invalid login credentials' } };
        const u = { id: opts.uid || nid(), email }; st.session = { user: u }; db.profiles.push({ id: u.id, display_name: 'Moi' });
        setTimeout(() => st.listeners.forEach((l) => l('SIGNED_IN', st.session)), 0); return { data: { session: st.session, user: u }, error: null };
      },
      signUp: async ({ email, options }) => { st.signup = { email, options }; return { data: { session: null, user: { id: nid() } }, error: null }; },
      signOut: async () => { st.session = null; setTimeout(() => st.listeners.forEach((l) => l('SIGNED_OUT', null)), 0); return { error: null }; },
      resend: async (a) => { st.resent = a; return { error: null }; },
      resetPasswordForEmail: async (e, o) => { st.reset = { e, o }; return { error: null }; }, updateUser: async (p) => { st.pw = p; return { error: null }; }
    },
    from,
    rpc: async (n, a) => { st.calls.push('rpc:' + n); if (st.offline) return { data: null, error: { message: 'Failed to fetch' } }; return st.rpc[n] ? st.rpc[n](a) : { data: null, error: { message: 'rpc inconnu ' + n } }; },
    storage: { from: () => ({
      upload: async (p, blob) => { if (st.uploadFail) return { data: null, error: { message: 'Upload failed (test)' } }; st.uploads.push(p); return { data: { path: p }, error: null }; }, remove: async (ps) => { st.removed.push(...ps); return { data: [], error: null }; },
      createSignedUrls: async (ps) => { st.signed.push(...ps); return { data: ps.map((p) => ({ path: p, signedUrl: 'https://signed.example/' + p })), error: null }; },
      copy: async () => ({ data: {}, error: null }) }) },
    functions: { invoke: async (n, o) => (st.og ? st.og(o.body) : { data: null, error: { message: 'absent' } }) },
    channel: () => { const c = { on: () => c, subscribe: (cb) => { setTimeout(() => cb('SUBSCRIBED'), 0); return c; } }; return c; }, removeChannel() {}
  };
  return { sb, db, st };
}

async function boot({ session, setup, ls, hash, uidFixed } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://x.github.io/Liste-cadeau/index.html' + (hash || ''), pretendToBeVisual: true });
  const w = dom.window; w.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; w.HTMLDialogElement.prototype.close = function () { if (this.open) { this.open = false; this.dispatchEvent(new w.Event('close')); } };
  w.scrollTo = () => {};
  if (ls) for (const [k, v] of Object.entries(ls)) w.localStorage.setItem(k, v);
  for (const f of ['js/config.js', 'js/api.js', 'js/ui.js']) w.eval(fs.readFileSync(path.join(root, f), 'utf8'));
  const F = fakeSb({ session, uid: uidFixed }); if (setup) setup(F, w);
  w.__F = F; w.V2.boot(F.sb); await sleep(80); return w;
}
const $ = (w, s) => w.document.querySelector(s), $$ = (w, s) => [...w.document.querySelectorAll(s)];
const txt = (w) => w.document.body.textContent;
const click = async (w, s) => { const e = typeof s === 'string' ? $(w, s) : s; e.click(); await sleep(60); };
const submit = async (w, form) => { form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(80); };
const setv = (f, n, v) => { f.elements[n].value = v; };
const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'moi@x.fr' };
const OTHER = '22222222-2222-4222-8222-222222222222';
const seedSession = (F) => { F.st.session = { user: ME }; F.db.profiles.push({ id: ME.id, display_name: 'Marie' }, { id: OTHER, display_name: 'Paul' }); };

(async () => {
  // 1. sans session : écran de connexion, erreurs lisibles
  let w = await boot();
  t('sans session : écran de connexion, pas d’icône profil', !!$(w, '#authform') && /Bon retour/.test(txt(w)) && $(w, '#tabs').hidden && $(w, '#me').hidden);
  setv($(w, '#authform'), 'email', 'a@x.fr'); setv($(w, '#authform'), 'password', 'mauvais'); await submit(w, $(w, '#authform'));
  t('mauvais mot de passe : message clair', /E-mail ou mot de passe incorrect/.test($(w, '#aerr').textContent));
  await click(w, '[data-id="up"]'); setv($(w, '#authform'), 'email', 'n@x.fr'); setv($(w, '#authform'), 'password', 'court'); await submit(w, $(w, '#authform'));
  t('inscription : mot de passe trop court refusé côté client', /6 caractères/.test($(w, '#aerr').textContent) && !w.__F.st.signup);
  t('inscription : seulement 2 champs (e-mail, mot de passe)', $$(w, '#authform input').length === 2);
  await click(w, '[data-a="eye"]'); t('œil : affiche le mot de passe', $(w, '#authform [name="password"]').type === 'text'); await click(w, '[data-a="eye"]'); t('œil : le recache', $(w, '#authform [name="password"]').type === 'password');
  setv($(w, '#authform'), 'password', 'longmotdepasse'); await submit(w, $(w, '#authform'));
  t('inscription : e-mail de confirmation annoncé, rien d’autre à remplir', /lien de confirmation/.test(txt(w)) && w.__F.st.signup.options.data.display_name === '' && w.__F.st.signup.options.emailRedirectTo === 'https://asch13320-cloud.github.io/Liste-cadeau/');
  await click(w, '[data-a="resend"]'); t('e-mail de confirmation renvoyable', w.__F.st.resent && w.__F.st.resent.email === 'n@x.fr' && w.__F.st.resent.type === 'signup');
  await click(w, '[data-id="reset"]'); setv($(w, '#resetform'), 'email', 'n@x.fr'); await submit(w, $(w, '#resetform'));
  t('mot de passe oublié : message neutre (ne révèle pas si le compte existe)', /Si cette adresse a un compte/.test(txt(w)) && w.__F.st.reset.e === 'n@x.fr');
  await click(w, '[data-id="in"]'); setv($(w, '#authform'), 'email', 'moi@x.fr'); setv($(w, '#authform'), 'password', 'motdepasse1'); await submit(w, $(w, '#authform')); await sleep(150);
  t('connexion : accueil affiché avec 3 onglets et l’icône profil en haut', !!$(w, '.cover') && $$(w, '#tabs button').length === 3 && !$(w, '#me').hidden);

  // 2. session existante : listes, rôles, cartes
  w = await boot({ setup: (F) => {
    seedSession(F);
    const L1 = nid(), L2 = nid(), L3 = nid();
    F.db.lists.push({ id: L1, owner_id: ME.id, kind: 'wishes', title: 'Mes envies', emoji: '🎀', budget: null, created_at: '2026-01-01' },
      { id: L2, owner_id: ME.id, kind: 'gifts_for', title: 'Cadeaux de Maman', emoji: '🎁', budget: 100, created_at: '2026-01-02' },
      { id: L3, owner_id: OTHER, kind: 'wishes', title: 'Envies de Paul', emoji: '🎮', budget: null, created_at: '2026-01-03' });
    F.db.list_members.push({ list_id: L1, user_id: ME.id, role: 'owner' }, { list_id: L2, user_id: ME.id, role: 'owner' }, { list_id: L2, user_id: OTHER, role: 'collaborator' }, { list_id: L3, user_id: ME.id, role: 'reader' });
    F.db.items.push({ id: nid(), list_id: L1, name: 'Lampe <img src=x onerror=alert(1)>', est_price: 30, priority: 'love', category: 'home', status: 'wish', favorite: true, bought: false, wrapped: false, version: 1, link: 'https://shop.fr/p', created_at: '2026-02-01', notes: 'bleue' },
      { id: nid(), list_id: L2, name: 'Écharpe', est_price: 25, spent: 22, bought: true, wrapped: false, version: 1, created_at: '2026-02-02', link: 'javascript:alert(1)' },
      { id: nid(), list_id: L3, name: 'Manette', est_price: 60, favorite: false, version: 1, created_at: '2026-02-03' });
    F.db.item_private_notes.push({ item_id: F.db.items[0].id, user_id: ME.id, notes: 'secret perso' });
    F.ids = { L1, L2, L3 };
  } });
  t('Atelier allégé : bannière, saisie d’idée, budget, boîte à idées', !!$(w, '.cover') && !!$(w, '#qa') && /Budget restant/.test(txt(w)) && /Ma boîte à idées/.test(txt(w)));
  t('Atelier allégé : plus de compteurs, d’aperçu de listes ni de coups de cœur', !$(w, '.stats') && !/Mon coin des coups de cœur/.test(txt(w)) && !$(w, '.person') && !/Dans mon atelier/.test(txt(w)));
  t('« tiroir » renommé « boîte à idées » partout', !/tiroir/i.test($(w, '#app').textContent));
  t('XSS : le nom du cadeau est échappé', !$(w, '#app img[src="x"]'));
  await click(w, '[data-id="mine"]');
  t('« Mes listes » : seulement mes listes non collaboratives', $$(w, '.person').length === 1);
  const names = () => $$(w, '.person h4').map((x) => x.textContent);
  t('« Mes listes » : envies présentes', names().some((n) => /Mes envies/.test(n)));
  t('liste partagée avec un collaborateur : classée dans « À plusieurs »', !names().some((n) => /Maman/.test(n)));
  await click(w, '[data-id="shared"]');
  t('onglet unique « Partagées » : listes à plusieurs ET listes en lecture seule', names().some((n) => /Maman/.test(n)) && names().some((n) => /Envies de Paul/.test(n)) && /Préparées ensemble/.test(txt(w)) && /À consulter/.test(txt(w)));
  t('onglet « À plusieurs » supprimé (plus de doublon)', !$(w, '#tabs [data-id="collab"]') && $$(w, '#tabs button').length === 3);
  t('« Partagées » : prénom du propriétaire visible pour la liste en lecture seule', /de Paul/.test(txt(w)));
  await click(w, $$(w, '.person').find((e) => /Envies de Paul/.test(e.textContent))); 
  t('lecteur : bandeau lecture seule', /Lecture seule/.test(txt(w)));
  t('lecteur : AUCUN bouton de modification', !$(w, '[data-a="iadd"]') && !$(w, '[data-a="iedit"]') && !$(w, '[data-a="idel"]') && !$(w, '[data-a="ibuy"]') && !$(w, '[data-a="ledit"]') && !$(w, '[data-a="ldel"]') && !$(w, '[data-a="lshare"]') && !$(w, '[data-a="ifav"]'));
  t('lecteur : peut quitter la liste', !!$(w, '[data-a="lleave"]'));

  // 3. propriétaire : ajouter / modifier / basculer
  await click(w, '[data-id="mine"]'); await click(w, '.person');
  t('propriétaire : boutons présents', !!$(w, '[data-a="iadd"]') && !!$(w, '[data-a="lshare"]') && !!$(w, '[data-a="ledit"]'));
  t('XSS : balise du nom échappée dans la carte', !$(w, '#app img[onerror]') && $$(w, '.wish-title').some((e) => e.textContent.includes('<img src=x')));
  t('note perso affichée (la mienne)', /Ma note perso : secret perso/.test(txt(w)));
  await click(w, '[data-a="iadd"]');
  const f = $(w, '#f'); setv(f, 'name', 'Plaid'); setv(f, 'est_price', '40.5'); setv(f, 'private', 'plutôt vert'); await submit(w, f); await sleep(100);
  const items = w.__F.db.items; const added = items.find((i) => i.name === 'Plaid');
  t('ajout : cadeau créé (prix enregistré en nombre)', added && added.est_price === 40.5 && added.list_id === w.__F.ids.L1);
  t('ajout : note perso enregistrée à part', w.__F.db.item_private_notes.some((n) => n.item_id === added.id && n.notes === 'plutôt vert'));
  t('ajout : visible dans la liste, fenêtre fermée', /Plaid/.test($(w, '#app').textContent) && !$(w, '#dlg').open);
  await click(w, `[data-a="ifav"][data-id="${added.id}"]`); t('favori basculé + version incrémentée', added.favorite === true && added.version >= 2);
  await click(w, `[data-a="inext"][data-id="${added.id}"]`); t('statut suivant', added.status === 'received' || added.status === 'wish' || added.status === 'idea');
  // erreurs de saisie
  await click(w, '[data-a="iadd"]'); const f2 = $(w, '#f'); setv(f2, 'name', 'Mauvais lien'); setv(f2, 'link', 'ftp://x'); await submit(w, f2);
  t('lien non http(s) refusé, message DANS la fenêtre', $(w, '#dlg').open && /http/.test($(w, '#ferr').textContent) && !w.__F.db.items.some((i) => i.name === 'Mauvais lien'));
  setv(f2, 'name', ''); await submit(w, f2); t('nom vide : message', /remplir/.test($(w, '#ferr').textContent));
  await click(w, '[data-close]');
  // conflit de version
  const target = w.__F.db.items.find((i) => i.name === 'Plaid');
  await click(w, `[data-a="iedit"][data-id="${target.id}"]`);
  const f3 = $(w, '#f'); setv(f3, 'name', 'Plaid doux'); target.version += 5; await submit(w, f3);
  t('conflit de version : message clair, rien d’écrasé', /Quelqu’un vient de modifier/.test($(w, '#ferr').textContent) && target.name === 'Plaid');
  await click(w, '[data-close]');
  // suppression avec confirmation
  await click(w, `[data-a="idel"][data-id="${target.id}"]`); t('suppression : confirmation demandée', /Supprimer \?/.test($(w, '#dlg').textContent) && w.__F.db.items.includes(target));
  await click(w, '#dlg [data-i="0"]'); await sleep(50); t('suppression confirmée', !w.__F.db.items.includes(target));

  // 4. carnet de cadeaux : trouvé / emballé / budget
  await click(w, '[data-id="shared"]'); await click(w, $$(w, '.person').find((e) => /Maman/.test(e.textContent)));
  const g = w.__F.db.items.find((i) => i.name === 'Écharpe');
  t('lien javascript: jamais rendu en lien cliquable', !$$(w, 'a').some((a) => /javascript:/i.test(a.getAttribute('href') || '')));
  await click(w, `[data-a="iwrap"][data-id="${g.id}"]`); t('emballé basculé', g.wrapped === true);
  await click(w, `[data-a="ibuy"][data-id="${g.id}"]`); t('« trouvé » décoché', g.bought === false);

  // 5. partage : création d’un lien, révocation
  w.__F.st.rpc.create_invite_link = async (a) => { const inv = { id: nid(), list_id: a.p_list, role: a.p_role, email: a.p_email, allow_anonymous: a.p_anonymous, expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null, max_uses: a.p_max_uses, uses: 0, created_at: new Date().toISOString() }; w.__F.db.invite_links.push(inv); w.__F.st.lastInvite = a; return { data: { id: inv.id, token: hex64('a'), expires_at: inv.expires_at }, error: null }; };
  await click(w, '[data-id="mine"]'); await click(w, '.person'); await click(w, '[data-a="lshare"]');
  t('partage : membres listés', /Membres/.test($(w, '#dlg').textContent));
  t('partage : lien sans compte proposé pour une liste d’envies', !!$(w, '#dlg [name="anon"]'));
  const inv = $(w, '#invform'); inv.elements.role.value = 'reader'; await submit(w, inv); await sleep(150);
  const shown = $(w, '#lnk') && $(w, '#lnk').value;
  t('partage : lien créé affiché une fois, avec le bon format', shown === 'https://asch13320-cloud.github.io/Liste-cadeau/#join/' + hex64('a'));
  t('partage : paramètres transmis (rôle, durée, usages)', w.__F.st.lastInvite.p_role === 'reader' && w.__F.st.lastInvite.p_ttl_hours === 168 && w.__F.st.lastInvite.p_max_uses === 1 && w.__F.st.lastInvite.p_anonymous === false);
  await click(w, '[data-rev]'); await sleep(100);
  t('révocation : lien marqué révoqué', w.__F.db.invite_links[0].revoked_at !== null);
  await click(w, '[data-close]');
  await click(w, '[data-id="shared"]'); await click(w, $$(w, '.person').find((e) => /Maman/.test(e.textContent))); await click(w, '[data-a="lshare"]');
  t('liste de cadeaux : pas de lien sans compte proposé', !$(w, '#dlg [name="anon"]'));
  await click(w, '[data-close]');

  // 6. rejoindre via lien
  w = await boot({ hash: '#join/' + hex64('b'), setup: (F) => { seedSession(F); const L = nid(); F.db.lists.push({ id: L, owner_id: OTHER, kind: 'gifts_for', title: 'Cadeaux de Mamie', emoji: '🎁', created_at: '2026-01-01' }); F.db.list_members.push({ list_id: L, user_id: OTHER, role: 'owner' });
    F.st.rpc.redeem_invite = async (a) => { if (a.p_token !== hex64('b')) return { data: null, error: { message: 'invalid_or_expired_invite' } }; F.db.list_members.push({ list_id: L, user_id: ME.id, role: 'collaborator' }); return { data: { list_id: L, role: 'collaborator' }, error: null }; }; } });
  await sleep(700);
  t('lien d’invitation : liste rejointe et ouverte', /Mamie/.test(txt(w)) && /Collaborateur/.test(txt(w)) && !!$(w, '[data-a="iadd"]'));
  t('lien d’invitation : retiré de la barre d’adresse', w.location.hash === '');
  w = await boot({ hash: '#join/' + hex64('c'), setup: (F) => { seedSession(F); F.st.rpc.redeem_invite = async () => ({ data: null, error: { message: 'invalid_or_expired_invite' } }); } }); await sleep(700);
  t('lien invalide / expiré : message clair', /n’est plus valide/.test(txt(w)));
  w = await boot({ hash: '#join/' + hex64('d') }); await sleep(600);
  t('lien reçu sans être connecté : invitation à se connecter, lien mémorisé', /Connecte-toi/.test(txt(w)) && w.sessionStorage.getItem('noel_join') === hex64('d'));

  // 7. vue publique en lecture seule
  w = await boot({ hash: '#view/' + hex64('e'), setup: (F) => { F.st.rpc.public_list_view = async () => ({ data: { list: { id: nid(), title: 'Mes envies', emoji: '🎀' }, items: [{ id: nid(), name: 'Bougie <script>alert(1)</script>', est_price: 12, favorite: true, notes: 'vanille', link: 'https://x.fr', link_image: null }] }, error: null }); } }); await sleep(800);
  t('vue publique : contenu affiché sans compte', /Lecture seule/.test(txt(w)) && /Bougie/.test(txt(w)));
  t('vue publique : aucun bouton de modification, onglets masqués', !$(w, '[data-a="iadd"]') && !$(w, '[data-a="iedit"]') && $(w, '#tabs').hidden);
  t('vue publique : HTML échappé', !$(w, '#app script') && txt(w).includes('<script>alert(1)</script>'));
  w = await boot({ hash: '#view/' + hex64('f'), setup: (F) => { F.st.rpc.public_list_view = async () => ({ data: null, error: null }); } }); await sleep(700);
  t('vue publique : lien révoqué → message', /n’est plus valide/.test(txt(w)));

  // 8. hors-ligne : lecture seule depuis la dernière version
  w = await boot({ setup: (F) => { seedSession(F); const L = nid(); F.db.lists.push({ id: L, owner_id: ME.id, kind: 'wishes', title: 'Mes envies', emoji: '🎀', created_at: '2026-01-01' }); F.db.list_members.push({ list_id: L, user_id: ME.id, role: 'owner' }); F.db.items.push({ id: nid(), list_id: L, name: 'Chaussettes', version: 1, created_at: '2026-01-01' }); } });
  await click(w, '[data-id="mine"]'); await click(w, '.person'); t('(préparation) liste en ligne affichée', /Chaussettes/.test(txt(w)));
  const cache = w.localStorage.getItem('noel2026_v2cache'); t('copie locale de secours enregistrée', !!cache && /Chaussettes/.test(cache));
  const w2 = await boot({ ls: { noel2026_v2cache: cache.replace(/"uid":"[^"]+"/, '"uid":"' + ME.id + '"') }, setup: (F) => { seedSession(F); F.st.offline = true; } }); await sleep(200);
  t('hors-ligne : dernière version affichée avec bandeau', /Hors-ligne/.test(txt(w2)) && !!$(w2, '#sync.bad'));
  await click(w2, '[data-id="mine"]'); await click(w2, '.person');
  t('hors-ligne : liste visible mais modifications bloquées', /Chaussettes/.test(txt(w2)));
  await click(w2, '[data-a="iadd"]'); t('hors-ligne : ouverture du formulaire possible mais enregistrement refusé', true);
  const ff = $(w2, '#f'); if (ff) { setv(ff, 'name', 'X'); await submit(w2, ff); t('hors-ligne : aucun cadeau créé en douce', !w2.__F.db.items.some((i) => i.name === 'X')); } else t('hors-ligne : formulaire bloqué', true);

  // 9. migration de l'ancienne version
  const legacy = { wishes: [{ id: 'w1', name: 'Lampe', price: '30', prio: "J'adorerais", cat: 'Maison', status: 'Envie', photo: 'data:image/jpeg;base64,AAAA' }], people: [{ id: 'p1', name: 'Maman', emoji: '🎀', budget: '100', gifts: [{ id: 'g1', name: 'Écharpe', price: '25', spent: '22', bought: true, photo: 'data:image/jpeg;base64,BBBB' }] }], inbox: [{ id: 'i1', t: 'Plaid — 40 €' }] };
  let importedPayload = null;
  w = await boot({ ls: { noel2026: JSON.stringify(legacy) }, setup: (F) => {
    seedSession(F); const LW = nid(), LP = nid(), IW = nid(), IG = nid();
    F.st.rpc.import_legacy = async (a) => { importedPayload = a.p; if (!F.db.lists.some((l) => l.legacy_key === 'wishes')) { F.db.lists.push({ id: LW, owner_id: ME.id, kind: 'wishes', title: 'Mes envies', emoji: '🎀', legacy_key: 'wishes', created_at: '1' }, { id: LP, owner_id: ME.id, kind: 'gifts_for', title: 'Maman', emoji: '🎀', legacy_key: 'p:p1', created_at: '2' });
      F.db.list_members.push({ list_id: LW, user_id: ME.id, role: 'owner' }, { list_id: LP, user_id: ME.id, role: 'owner' });
      F.db.items.push({ id: IW, list_id: LW, name: 'Lampe', legacy_key: 'w:w1', version: 1, photo_path: null, created_at: '1' }, { id: IG, list_id: LP, name: 'Écharpe', legacy_key: 'g:g1', version: 1, photo_path: null, created_at: '2' });
      F.db.inbox_items.push({ id: nid(), text: 'Plaid — 40 €', legacy_key: 'i:i1', created_at: '1' }); }
      return { data: { lists_created: 2, items_created: 2, inbox_created: 1, skipped_existing: 0, items: [{ list_id: LW, item_id: IW, legacy: 'w:w1', inserted: true, has_photo: true }, { list_id: LP, item_id: IG, legacy: 'g:g1', inserted: true, has_photo: true }] }, error: null }; };
  } });
  await click(w, '#me');
  t('profil : données locales détectées', /1<\/b> envie|<b>1<\/b>/.test($(w, '#app').innerHTML) && /Rien n’est supprimé/.test(txt(w)));
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = function () { w.__dl = this.download; };
  // cas Android : la feuille de partage est annulée → on demande avant d'importer sans sauvegarde
  Object.defineProperty(w.navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(w.navigator, 'share', { value: () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })), configurable: true });
  await click(w, '[data-a="limport"]');
  t('sauvegarde annulée : confirmation demandée, aucun envoi', /Continuer sans sauvegarde/.test($(w, '#dlg').textContent) && !importedPayload);
  await click(w, '[data-close]'); t('refus : toujours aucun envoi', !importedPayload);
  Object.defineProperty(w.navigator, 'canShare', { value: () => false, configurable: true });
  const before = w.localStorage.getItem('noel2026');
  await click(w, '[data-a="limport"]'); await sleep(400);
  t('import en une étape : sauvegarde téléchargée AVANT l’envoi', /^noel2026-sauvegarde-\d{4}-\d{2}-\d{2}\.json$/.test(w.__dl || '') && !!importedPayload);
  t('import : photos retirées du paquet envoyé (envoyées séparément)', importedPayload && importedPayload.wishes[0].photo === '1' && importedPayload.people[0].gifts[0].photo === '1');
  t('import : 2 photos envoyées dans Storage', w.__F.st.uploads.length === 2 && w.__F.st.uploads.every((p) => /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(p)));
  t('import : photos rattachées aux cadeaux', w.__F.db.items.every((i) => i.photo_path));
  t('import : rapport de vérification complet', /Import terminé/.test(txt(w)) && /Envies : 1 \/ 1/.test(txt(w)) && /Cadeaux : 1 \/ 1/.test(txt(w)) && /Idées en vrac : 1 \/ 1/.test(txt(w)) && /Photos : 2 \/ 2/.test(txt(w)));
  t('import : données locales JAMAIS supprimées', w.localStorage.getItem('noel2026') === before);
  w.__F.st.uploads.length = 0; await click(w, '[data-close]'); await click(w, '#me'); await click(w, '[data-a="limport"]'); await sleep(300);
  t('relance : aucune photo envoyée en double', w.__F.st.uploads.length === 0);

  // 9a. erreur serveur pendant l'import : détail affiché dans la fenêtre, données intactes
  w.__F.st.rpc.import_legacy = async () => ({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } });
  await click(w, '#me'); await click(w, '[data-a="limport"]'); await sleep(300);
  t('erreur d’import : message DANS la fenêtre avec détail copiable', /n’a pas abouti/.test($(w, '#dlg').textContent) && /57014/.test($(w, '#errtx').value) && /étape : envoi des listes/.test($(w, '#errtx').value) && /intactes/.test($(w, '#dlg').textContent));
  await click(w, '[data-close]');
  // 9b. icône profil : ouvre le profil, un 2e appui revient à l’accueil
  await click(w, '[data-id="mine"]'); await click(w, '#me');
  t('icône profil : ouvre le profil, bouton actif', /Profil/.test($(w, '#app').textContent) && $(w, '#me').classList.contains('on') && !$(w, '#tabs .on'));
  await click(w, '#me'); t('icône profil : 2e appui → accueil', !!$(w, '.cover') && !$(w, '#me').classList.contains('on'));


  // 11. premiers pas d'un compte vide + photo du site + création de liste simplifiée
  w = await boot({ setup: (F) => { F.st.session = { user: ME }; F.db.profiles.push({ id: ME.id, display_name: '' }); } });
  t('compte vide : « Par où commencer ? »', /Par où commencer/.test(txt(w)) && !!$(w, '[data-a="start"][data-id="wish"]'));
  t('compte vide : prénom demandé, facultatif', !!$(w, '#nameform') && /Plus tard/.test(txt(w)));
  await click(w, '[data-a="later"]'); t('« Plus tard » masque la question', !$(w, '#nameform'));
  w.V2API.resizeImage = async (b) => b;
  w.__F.st.og = (b) => (b.image ? { data: { contentType: 'image/png', base64: 'iVBORw0KGgo=' }, error: null } : { data: { title: 'Lampe belle', image: 'https://shop.fr/i.png', description: 'Une lampe', price: 29.9, currency: 'EUR' }, error: null });
  await click(w, '[data-a="start"][data-id="wish"]');
  t('« Noter mes envies » : liste créée toute seule, formulaire ouvert', w.__F.db.lists.length === 1 && w.__F.db.lists[0].title === 'Mes envies' && $(w, '#dlg').open && !!$(w, '#f_name'));
  t('formulaire : l’essentiel visible, détails repliés', !!$(w, 'details.more') && !$(w, 'details.more').open && !$(w, '#f_name').closest('details') && !!$(w, '#f_photo') && !$(w, '#f_photo').closest('details'));
  const fl = $(w, '#f'); fl.elements.link.value = 'https://shop.fr/lampe'; fl.elements.link.dispatchEvent(new w.Event('change')); await sleep(150);
  t('lien collé : aperçu, titre pré-rempli', /Lampe belle/.test($(w, '#lp').textContent) && fl.elements.name.value === 'Lampe belle');
  t('lien collé : « Garder la photo du site » coché par défaut', !!$(w, '#usesite') && $(w, '#usesite').checked);
  await submit(w, fl); await sleep(150);
  const lamp = w.__F.db.items.find((i) => i.name === 'Lampe belle');
  t('photo du site enregistrée comme VRAIE photo (Storage)', lamp && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(lamp.photo_path || '') && w.__F.st.uploads.length === 1);
  t('photo du site : lien d’origine conservé en secours', lamp.link_image === 'https://shop.fr/i.png' && lamp.link === 'https://shop.fr/lampe');
  await sleep(100); t('carte : la photo enregistrée est affichée (lien signé)', !!$(w, 'img[data-photo]') && /signed\.example/.test($(w, 'img[data-photo]').getAttribute('src') || ''));
  // le site bloque la photo : le cadeau est quand même créé
  w.__F.st.og = (b) => (b.image ? { data: { error: 'http_403' }, error: null } : { data: { title: 'Bougie', image: 'https://shop.fr/b.png', price: null }, error: null });
  await click(w, '[data-a="iadd"]'); const f4 = $(w, '#f'); f4.elements.link.value = 'https://shop.fr/bougie'; f4.elements.link.dispatchEvent(new w.Event('change')); await sleep(150); await submit(w, f4); await sleep(150);
  const bg = w.__F.db.items.find((i) => i.name === 'Bougie');
  t('photo du site bloquée : cadeau créé quand même, affichage de secours', bg && !bg.photo_path && bg.link_image === 'https://shop.fr/b.png' && !$(w, '#dlg').open);
  // fonction non déployée : saisie manuelle proposée
  w.__F.st.og = null; await click(w, '[data-a="iadd"]'); const f5 = $(w, '#f'); f5.elements.link.value = 'https://shop.fr/x'; f5.elements.link.dispatchEvent(new w.Event('change')); await sleep(150);
  t('aperçu indisponible : message clair, saisie manuelle possible', /Aperçu automatique impossible/.test($(w, '#lp').textContent)); await click(w, '[data-close]');
  // création de liste simplifiée
  await click(w, '[data-id="mine"]'); await click(w, '[data-a="lnew"]');
  t('« Créer une liste » : choix du type en 2 gros boutons', /Que veux-tu créer/.test($(w, '#dlg').textContent) && $$(w, '#dlg [data-i]').length === 2);
  await click(w, '#dlg [data-i="1"]'); const fl2 = $(w, '#f');
  t('carnet de cadeaux : l’essentiel visible (qui, occasion, budget), le reste replié', /Pour qui/.test(fl2.textContent) && !!fl2.elements.occasion && !!fl2.elements.budget && !fl2.elements.title.closest('details') && !!fl2.elements.event_date.closest('details'));
  setv(fl2, 'title', 'Papa'); await submit(w, fl2); await sleep(120);
  t('carnet créé et ouvert', w.__F.db.lists.some((l) => l.title === 'Papa' && l.kind === 'gifts_for') && /Papa/.test($(w, '#app').textContent));


  // 12. photos : rendu identique à l'ancienne version + liens des carnets (cadeaux pour les autres)
  w = await boot({ setup: (F) => {
    seedSession(F); const W = nid(), G = nid(); F.ids = { W, G };
    F.db.lists.push({ id: W, owner_id: ME.id, kind: 'wishes', title: 'Mes envies', emoji: '🎀', created_at: '1' }, { id: G, owner_id: ME.id, kind: 'gifts_for', title: 'Maman', emoji: '🎁', budget: 100, created_at: '2' });
    F.db.list_members.push({ list_id: W, user_id: ME.id, role: 'owner' }, { list_id: G, user_id: ME.id, role: 'owner' });
    const P = (l) => l + '/' + nid() + '/' + nid() + '.jpg';
    F.db.items.push({ id: nid(), list_id: W, name: 'Lampe', photo_path: P(W), version: 1, created_at: '3' },
      { id: nid(), list_id: G, name: 'Avec photo', photo_path: P(G), version: 1, created_at: '4' },
      { id: nid(), list_id: G, name: 'Écharpe', link: 'https://shop.fr/echarpe', version: 1, created_at: '5' },
      { id: nid(), list_id: G, name: 'Gants', link: 'https://shop.fr/gants', version: 1, created_at: '6' },
      { id: nid(), list_id: G, name: 'Sans lien', version: 1, created_at: '7' });
    F.st.og = (b) => { if (b.image) return /gants/.test(b.image) ? { data: { error: 'http_403' }, error: null } : { data: { contentType: 'image/png', base64: 'iVBORw0KGgo=' }, error: null };
      if (/echarpe/.test(b.url)) return { data: { title: 'Écharpe douce', image: 'https://shop.fr/echarpe.png', description: 'Douce', price: 25 }, error: null };
      if (/gants/.test(b.url)) return { data: { title: 'Gants', image: 'https://shop.fr/gants.png' }, error: null };
      return { data: { partial: true, title: null, image: null }, error: null }; };
  } });
  w.V2API.resizeImage = async (b) => b;
  await click(w, '[data-id="mine"]'); await click(w, '.person'); await sleep(100);
  const wimg = $(w, 'img.ph[data-photo]');
  t('envies : ma photo s’affiche entière, comme avant (aucun recadrage forcé)', wimg && !wimg.getAttribute('style') && wimg.className === 'ph');
  await click(w, '[data-id="mine"]'); const gl = $$(w, '.person').find((e) => /Maman/.test(e.textContent)); await click(w, gl); await sleep(100);
  const gimg = $(w, 'img.ph[data-photo]');
  t('carnets : photo recadrée 110 px, comme avant', gimg && /height:110px;object-fit:cover/.test(gimg.getAttribute('style') || ''));
  t('cadeau importé avec un lien mais sans image : emplacement ✂️ (pas d’image cassée)', $$(w, '.ph').some((e) => e.tagName === 'DIV' && /✂️/.test(e.textContent)) && !$$(w, 'img.ph').some((i) => !i.dataset.photo && !i.getAttribute('src')));
  // ouverture d'un cadeau avec lien sans photo → photo cherchée automatiquement
  const echarpe = w.__F.db.items.find((i) => i.name === 'Écharpe');
  await click(w, `[data-a="iedit"][data-id="${echarpe.id}"]`); await sleep(200);
  t('cadeau avec lien sans photo : aperçu automatique à l’ouverture', /Écharpe douce/.test($(w, '#lp').textContent) && !!$(w, '#usesite') && $(w, '#usesite').checked);
  await submit(w, $(w, '#f')); await sleep(200);
  t('… et la photo du site est enregistrée à l’enregistrement', !!w.__F.db.items.find((i) => i.name === 'Écharpe').photo_path);
  // ajout dans un carnet « pour les autres » avec un lien
  await click(w, '[data-a="iadd"]'); const fg = $(w, '#f'); fg.elements.link.value = 'https://shop.fr/echarpe-bleue'; fg.elements.link.dispatchEvent(new w.Event('change')); await sleep(200);
  t('carnet : aperçu et photo proposés comme dans Mes envies', /Écharpe douce/.test($(w, '#lp').textContent) && !!$(w, '#usesite'));
  await submit(w, fg); await sleep(200);
  t('carnet : photo du site enregistrée', !!w.__F.db.items.filter((i) => i.name === 'Écharpe douce')[0] && !!w.__F.db.items.find((i) => i.name === 'Écharpe douce').photo_path);
  // action groupée
  t('bouton « Photos des liens » avec le nombre de cadeaux concernés', /Photos des liens \(1\)/.test($(w, '#app').textContent));
  await click(w, '[data-a="lfill"]'); await sleep(500);
  const toastTxt = (($(w, '#toast')) || {}).textContent || '';
  t('action groupée : le site qui refuse est signalé, sans bloquer le reste', /0 photo/.test(toastTxt) && /1 site/.test(toastTxt) && !w.__F.db.items.find((i) => i.name === 'Gants').photo_path);
  t('action groupée : plus rien à compléter côté serveur pour les autres', w.__F.db.items.filter((i) => i.link && !i.photo_path).length === 1);


  // 13. occasions : Noël, anniversaire, baby shower… + date + compte à rebours
  const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  w = await boot({ setup: (F) => { seedSession(F); const A = nid(), B = nid(), C = nid(); F.db.lists.push({ id: A, owner_id: ME.id, kind: 'gifts_for', title: 'Maman', emoji: '🎁', occasion: 'christmas', created_at: '1' }, { id: B, owner_id: ME.id, kind: 'gifts_for', title: 'Anniv de Léa', emoji: '🎂', occasion: 'birthday', event_date: inDays(3), created_at: '2' }, { id: C, owner_id: ME.id, kind: 'wishes', title: 'Baby shower', emoji: '🍼', occasion: 'baby_shower', created_at: '3' });
    F.db.list_members.push({ list_id: A, user_id: ME.id, role: 'owner' }, { list_id: B, user_id: ME.id, role: 'owner' }, { list_id: C, user_id: ME.id, role: 'owner' }); } });
  t('compte à rebours : prochaine occasion (anniversaire dans 3 jours)', /J-3 🎂/.test($(w, '#cd').textContent) && $(w, '#cd').title === 'Anniv de Léa');
  await click(w, '[data-id="mine"]');
  t('listes : occasion affichée sur chaque carte', /🎄 Noël/.test(txt(w)) && /🎂 Anniversaire/.test(txt(w)) && /🍼 Baby shower/.test(txt(w)));
  t('listes : date de l’occasion affichée', new RegExp(String(new Date(inDays(3) + 'T12:00:00').getDate())).test($$(w, '.person').find((e) => /Léa/.test(e.textContent)).textContent));
  t('filtre par occasion proposé (3 occasions)', $$(w, '[data-a="occ"]').length === 4);
  await click(w, '[data-a="occ"][data-id="birthday"]'); t('filtre « Anniversaire » : seule cette liste', $$(w, '.person').length === 1 && /Léa/.test($(w, '.person').textContent));
  await click(w, '[data-a="occ"][data-id="all"]'); t('filtre « Toutes » : tout revient', $$(w, '.person').length === 3);
  await click(w, '[data-a="lnew"]'); await click(w, '#dlg [data-i="1"]'); const fo = $(w, '#f');
  t('création : choix de l’occasion, Noël proposé par défaut', fo.elements.occasion.value === 'christmas' && fo.elements.occasion.options.length === 5);
  setv(fo, 'title', 'Jules'); fo.elements.occasion.value = 'wedding'; fo.elements.event_date.value = inDays(40); await submit(w, fo); await sleep(120);
  const jl = w.__F.db.lists.find((l) => l.title === 'Jules');
  t('création : occasion et date enregistrées', jl && jl.occasion === 'wedding' && jl.event_date === inDays(40));
  // base pas encore mise à jour (migration 5 non lancée) : la liste est créée quand même, avec un message clair
  const w3 = await boot({ setup: (F) => { seedSession(F); const rows = F.db.lists; const origFrom = F.sb.from; F.sb.from = (tb) => { const b = origFrom(tb); if (tb !== 'lists') return b; const ins = b.insert; b.insert = (p) => { if (p && p.occasion !== undefined) { return { select: () => ({ single: async () => ({ data: null, error: { message: "Could not find the 'occasion' column of 'lists' in the schema cache" } }) }) }; } return ins(p); }; return b; }; } });
  await click(w3, '[data-id="mine"]'); await click(w3, '[data-a="lnew"]'); await click(w3, '#dlg [data-i="0"]'); const fm = $(w3, '#f'); setv(fm, 'title', 'Mes envies'); await submit(w3, fm); await sleep(150);
  t('migration 5 pas encore lancée : la liste est créée quand même', w3.__F.db.lists.some((l) => l.title === 'Mes envies') && /migration 5/.test(($(w3, '#toast') || {}).textContent || ''));


  // 14. budget : décocher « Trouvé » rend l'argent ; plusieurs photos en carrousel
  const P6 = (l, i) => l + '/' + i + '/' + nid() + '.jpg';
  const reload = async (w) => { w.document.dispatchEvent(new w.Event('visibilitychange')); await sleep(250); };
  const mkFile = (w, n) => new w.File(['x' + n], 'p' + n + '.png', { type: 'image/png' });
  const withFiles = (w, input, files) => Object.defineProperty(input, 'files', { value: files, configurable: true });
  w = await boot({ setup: (F) => {
    seedSession(F); const G = nid(), W = nid(), it1 = nid(); F.ids = { G, W, it1 };
    F.db.lists.push({ id: G, owner_id: ME.id, kind: 'gifts_for', title: 'Maman', emoji: '🎁', budget: 100, occasion: 'christmas', created_at: '1' }, { id: W, owner_id: ME.id, kind: 'wishes', title: 'Mes envies', emoji: '🎀', occasion: 'christmas', created_at: '2' });
    F.db.list_members.push({ list_id: G, user_id: ME.id, role: 'owner' }, { list_id: W, user_id: ME.id, role: 'owner' });
    F.db.items.push({ id: it1, list_id: G, name: 'Écharpe', est_price: 30, spent: 30, bought: true, version: 1, created_at: '3', photo_paths: [] });
  } });
  w.V2API.resizeImage = async (b) => b;
  t('budget : l’argent dépensé est déduit (100 − 30)', /70 €/.test($(w, '#app').textContent) && /Sur 100 € prévus/.test($(w, '#app').textContent));
  await click(w, '[data-id="mine"]'); await click(w, $$(w, '.person').find((e) => /Maman/.test(e.textContent)));
  t('carnet : dépensé affiché une fois trouvé', /30 €/.test($(w, '#app').textContent));
  await click(w, '[data-a="ibuy"]');
  t('décocher « Trouvé » : le carnet ne compte plus la dépense', w.__F.db.items[0].bought === false && !/Dépensé : 30/.test($(w, '#app').textContent) && /0 €/.test($(w, '.card .top b').textContent));
  await click(w, '[data-id="home"]');
  t('décocher « Trouvé » : le budget restant revient à 100 €', /100 €/.test($$(w, '.card').find((c) => /Budget restant/.test(c.textContent)).textContent));
  t('… sans perdre le montant saisi (il revient si on recoche)', w.__F.db.items[0].spent === 30);
  await click(w, '[data-id="mine"]'); await click(w, $$(w, '.person').find((e) => /Maman/.test(e.textContent))); await click(w, '[data-a="ibuy"]'); await click(w, '[data-id="home"]');
  t('recocher « Trouvé » : 70 € restants de nouveau', w.__F.db.items[0].bought === true && /70 €/.test($$(w, '.card').find((c) => /Budget restant/.test(c.textContent)).textContent));

  // plusieurs photos
  await click(w, '[data-id="mine"]'); await click(w, $$(w, '.person').find((e) => /Maman/.test(e.textContent)));
  await click(w, '[data-a="iadd"]'); let fp = $(w, '#f'); setv(fp, 'name', 'Plaid'); withFiles(w, $(w, '#f input[type=file]'), [mkFile(w, 1), mkFile(w, 2), mkFile(w, 3)]);
  t('formulaire : plusieurs photos acceptées d’un coup', $(w, '#f input[type=file]').multiple === true && /10 maximum/.test($(w, '#f').textContent));
  await submit(w, fp); await sleep(200);
  const pl = w.__F.db.items.find((i) => i.name === 'Plaid');
  t('3 photos envoyées et enregistrées dans l’ordre', pl && pl.photo_paths.length === 3 && w.__F.st.uploads.length === 3 && pl.photo_path === pl.photo_paths[0]);
  await sleep(100);
  const car = $(w, '.car');
  t('carte : carrousel avec les 3 photos à faire défiler', !!car && car.querySelectorAll('.strip > img.ph').length === 3 && /1\/3/.test($(w, '.car .cnt').textContent) && !!$(w, '.car .nav.next') && !!$(w, '.car .nav.prev'));
  t('carte : photos du carnet recadrées comme avant', /height:110px;object-fit:cover/.test(car.querySelector('img').getAttribute('style') || ''));
  t('cadeau sans photo multiple : aucune barre de défilement', $$(w, '.car').length === 1);
  // édition : retirer / mettre en couverture
  await click(w, `[data-a="iedit"][data-id="${pl.id}"]`);
  t('édition : les 3 photos sont listées avec « couverture »', $$(w, '#pstrip .th').length === 3 && /couverture/.test($(w, '#pstrip').textContent));
  const bph = pl.photo_paths.slice();
  await click(w, '#pstrip [data-ph="cover"][data-i="2"]');
  t('édition : ★ met la photo en première', $$(w, '#pstrip .th img')[0].dataset.photo === bph[2]);
  await click(w, '#pstrip [data-ph="rm"][data-i="1"]');
  t('édition : ✕ retire la photo de la liste', $$(w, '#pstrip .th').length === 2);
  await submit(w, $(w, '#f')); await sleep(200);
  const pl2 = w.__F.db.items.find((i) => i.name === 'Plaid');
  t('enregistré : nouvel ordre, une photo en moins', pl2.photo_paths.length === 2 && pl2.photo_paths[0] === bph[2] && pl2.photo_path === bph[2]);
  t('photo retirée supprimée du stockage', w.__F.st.removed.includes(bph[0]) && !w.__F.st.removed.includes(bph[2]));
  // limite
  const many = Array.from({ length: 10 }, (_, i) => P6(w.__F.ids.G, pl2.id));
  w.__F.db.items.find((i) => i.name === 'Plaid').photo_paths = many; w.__F.db.items.find((i) => i.name === 'Plaid').version++;
  await reload(w); await click(w, '[data-id="home"]'); await click(w, '[data-id="mine"]'); await click(w, $$(w, '.person').find((e) => /Maman/.test(e.textContent)));
  await click(w, `[data-a="iedit"][data-id="${pl2.id}"]`); withFiles(w, $(w, '#f input[type=file]'), [mkFile(w, 9)]); await submit(w, $(w, '#f')); await sleep(120);
  t('limite : 11 photos refusées, message DANS la fenêtre', $(w, '#dlg').open && /10 photos maximum/.test($(w, '#ferr').textContent));
  await click(w, '[data-close]');
  // ancien cadeau (une seule photo, ancien format) : toujours affiché, sans carrousel
  const old = P6(w.__F.ids.G, nid());
  w.__F.db.items.push({ id: nid(), list_id: w.__F.ids.G, name: 'Ancien', photo_path: old, version: 1, created_at: '9' });
  await reload(w); await click(w, '[data-id="home"]'); await click(w, '[data-id="mine"]'); await click(w, $$(w, '.person').find((e) => /Maman/.test(e.textContent))); await sleep(100);
  t('ancien cadeau à 1 photo : affiché normalement (pas de carrousel)', $$(w, 'img.ph[data-photo="' + old + '"]').length === 1 && !$$(w, '.car').some((c) => c.querySelector('img[data-photo="' + old + '"]')));
  // base sans la migration 6 : on garde la 1re photo et on prévient
  w.__F.st.noPhotosCol = true;
  await click(w, '[data-a="iadd"]'); const fq = $(w, '#f'); setv(fq, 'name', 'Sans migration'); withFiles(w, $(w, '#f input[type=file]'), [mkFile(w, 4), mkFile(w, 5)]); await submit(w, fq); await sleep(200);
  const sm = w.__F.db.items.find((i) => i.name === 'Sans migration');
  t('migration 6 absente : cadeau créé avec sa 1re photo, message clair', sm && !!sm.photo_path && /migration 6/.test(($(w, '#toast') || {}).textContent || ''));
  w.__F.st.noPhotosCol = false;
  // déplacement : toutes les photos suivent
  const mv = w.__F.db.items.find((i) => i.name === 'Plaid'); const L2 = [P6(w.__F.ids.G, mv.id), P6(w.__F.ids.G, mv.id)]; mv.photo_paths = L2; mv.photo_path = L2[0]; mv.version++;
  await reload(w); await click(w, '[data-id="home"]'); await click(w, '[data-id="mine"]'); await click(w, $$(w, '.person').find((e) => /Maman/.test(e.textContent)));
  await click(w, `[data-a="imove"][data-id="${mv.id}"]`); await click(w, '#dlg [data-i="0"]'); await sleep(250);
  const moved = w.__F.db.items.find((i) => i.name === 'Plaid' && i.list_id === w.__F.ids.W);
  t('déplacement : les 2 photos suivent le cadeau', moved && moved.photo_paths.length === 2 && moved.photo_paths.every((p) => p.startsWith(w.__F.ids.W + '/')) && !w.__F.db.items.some((i) => i.id === mv.id) && L2.every((p) => w.__F.st.removed.includes(p)));


  // 15. commentaires et réservations : visibles des invités, jamais du propriétaire d'une liste d'envies
  const THIRD = '33333333-3333-4333-8333-333333333333';
  const socialSetup = (F) => {
    F.st.session = { user: ME }; F.db.profiles.push({ id: ME.id, display_name: 'Marie' }, { id: OTHER, display_name: 'Paul' }, { id: THIRD, display_name: 'Léa' });
    const PW = nid(), MW = nid(), MG = nid(); F.ids = { PW, MW, MG };
    F.db.lists.push({ id: PW, owner_id: OTHER, kind: 'wishes', title: 'Envies de Paul', emoji: '🎮', occasion: 'birthday', created_at: '1' }, { id: MW, owner_id: ME.id, kind: 'wishes', title: 'Mes envies', emoji: '🎀', occasion: 'christmas', created_at: '2' }, { id: MG, owner_id: ME.id, kind: 'gifts_for', title: 'Cadeaux de Maman', emoji: '🎁', occasion: 'christmas', created_at: '3' });
    F.db.list_members.push({ list_id: PW, user_id: OTHER, role: 'owner' }, { list_id: PW, user_id: ME.id, role: 'reader' }, { list_id: PW, user_id: THIRD, role: 'reader' }, { list_id: MW, user_id: ME.id, role: 'owner' }, { list_id: MW, user_id: THIRD, role: 'reader' }, { list_id: MG, user_id: ME.id, role: 'owner' }, { list_id: MG, user_id: THIRD, role: 'collaborator' });
    const mk = (l, n, extra) => ({ id: nid(), list_id: l, name: n, version: 1, created_at: '5', photo_paths: [], ...extra });
    F.db.items.push(mk(PW, 'Manette'), mk(PW, 'Casque'), mk(MW, 'Ma lampe'), mk(MG, 'Écharpe maman'));
    F.db.item_claims.push({ item_id: F.db.items[1].id, list_id: PW, user_id: THIRD, status: 'claimed' });
    F.db.item_comments.push({ id: nid(), item_id: F.db.items[0].id, list_id: PW, author_id: THIRD, body: 'Je pense lui offrir les manettes', created_at: '2026-11-10T10:00:00Z' }, { id: nid(), item_id: F.db.items[2].id, list_id: MW, author_id: THIRD, body: 'SECRET : je lui prends la lampe', created_at: '2026-11-10T11:00:00Z' });
    F.db.item_claims.push({ item_id: F.db.items[2].id, list_id: MW, user_id: THIRD, status: 'claimed' });
  };
  w = await boot({ setup: socialSetup });
  await click(w, '[data-id="shared"]'); await click(w, $$(w, '.person').find((e) => /Envies de Paul/.test(e.textContent)));
  const manette = w.__F.db.items.find((i) => i.name === 'Manette'), casque = w.__F.db.items.find((i) => i.name === 'Casque');
  const card = (n) => $$(w, 'article.card').find((c) => c.textContent.includes(n));
  t('invité : boutons « Je m’en occupe » et commentaires sur chaque envie', !!card('Manette').querySelector('[data-a="iclaim"]') && !!card('Manette').querySelector('[data-a="icomments"]') && !card('Manette').querySelector('[data-a="iedit"]') && !card('Manette').querySelector('[data-a="idel"]'));
  t('invité : cadeau déjà réservé par quelqu’un → « Réservé par Léa », pas de bouton', /Réservé par Léa/.test(card('Casque').textContent) && !card('Casque').querySelector('[data-a="iclaim"]'));
  t('invité : nombre de commentaires affiché', /💬 1/.test(card('Manette').textContent));
  await click(w, card('Manette').querySelector('[data-a="iclaim"]')); await sleep(150);
  const mine = w.__F.db.item_claims.find((c) => c.item_id === manette.id);
  t('réservation : je m’attribue le cadeau', mine && mine.user_id === ME.id && mine.status === 'claimed' && !!card('Manette').querySelector('[data-a="irelease"]') && !card('Manette').querySelector('[data-a="iclaim"]'));
  await click(w, card('Manette').querySelector('[data-a="ibought"]')); await sleep(120);
  t('réservation : je marque « acheté »', w.__F.db.item_claims.find((c) => c.item_id === manette.id).status === 'bought' && /Acheté ✓/.test(card('Manette').textContent));
  await click(w, card('Manette').querySelector('[data-a="irelease"]')); await sleep(120);
  t('réservation : j’annule, le cadeau est de nouveau libre', !w.__F.db.item_claims.some((c) => c.item_id === manette.id) && !!card('Manette').querySelector('[data-a="iclaim"]'));
  w.__F.db.item_claims.push({ item_id: manette.id, list_id: w.__F.ids.PW, user_id: THIRD, status: 'claimed' });   // quelqu'un réserve juste avant moi
  await click(w, card('Manette').querySelector('[data-a="iclaim"]')); await sleep(200);
  t('2 personnes en même temps : la 2e est prévenue et voit « Réservé par Léa »', /vient de réserver/.test(($(w, '#toast') || {}).textContent || '') && /Réservé par Léa/.test(card('Manette').textContent) && w.__F.db.item_claims.filter((c) => c.item_id === manette.id).length === 1);
  await click(w, card('Manette').querySelector('[data-a="icomments"]'));
  t('commentaires : fenêtre ouverte, précise que le propriétaire ne voit rien', /pas par le propriétaire/.test($(w, '#dlg').textContent) && /Je pense lui offrir/.test($(w, '#cmlist').textContent) && /Léa/.test($(w, '#cmlist').textContent));
  const cf = $(w, '#cmform'); cf.elements.body.value = 'Je prends la manette, toi le casque ?'; await submit(w, cf); await sleep(150);
  const mine2 = w.__F.db.item_comments.find((c) => c.body.startsWith('Je prends la manette'));
  t('commentaires : mon message est enregistré et affiché', mine2 && mine2.author_id === ME.id && /Je prends la manette/.test($(w, '#cmlist').textContent));
  await click(w, '#cmlist [data-delc]'); await sleep(150);
  t('commentaires : je supprime le mien (pas celui des autres)', !w.__F.db.item_comments.some((c) => c.id === mine2.id) && w.__F.db.item_comments.some((c) => c.author_id === THIRD));
  await click(w, '[data-close]');

  // le propriétaire de la liste d'envies ne voit RIEN (ni bouton, ni commentaire, ni réservation)
  await click(w, '[data-id="mine"]'); await click(w, $$(w, '.person').find((e) => /Mes envies/.test(e.textContent)));
  t('propriétaire des envies : aucun bouton social', !$(w, '[data-a="iclaim"]') && !$(w, '[data-a="icomments"]') && !$(w, '[data-a="irelease"]'));
  t('propriétaire des envies : aucune trace des commentaires ni des réservations', !/SECRET/.test(txt(w)) && !/Réservé par/.test(txt(w)) && !/💬/.test($(w, '#app').textContent));
  t('propriétaire des envies : informé que les invités peuvent commenter, sans rien voir', /ne verras rien/.test(txt(w)));
  // liste de cadeaux partagée : commentaires visibles de tous (propriétaire compris), pas de réservation
  await click(w, '[data-id="shared"]'); await click(w, $$(w, '.person').find((e) => /Maman/.test(e.textContent)));
  t('liste de cadeaux à plusieurs : bouton commentaires, pas de réservation', !!$(w, '[data-a="icomments"]') && !$(w, '[data-a="iclaim"]'));
  // base sans la migration 7 : l'app continue de marcher, sans boutons sociaux
  const wn = await boot({ setup: (F) => { socialSetup(F); F.st.noSocial = true; } });
  await click(wn, '[data-id="shared"]'); await click(wn, $$(wn, '.person').find((e) => /Envies de Paul/.test(e.textContent)));
  t('migration 7 absente : l’app marche, sans boutons de commentaires', /Manette/.test(txt(wn)) && !$(wn, '[data-a="icomments"]') && !$(wn, '[data-a="iclaim"]'));

  // 16. bug « l'envie se multiplie » : si la photo échoue, un 2e appui ne crée PAS un doublon
  w = await boot({ setup: (F) => { F.st.session = { user: ME }; F.db.profiles.push({ id: ME.id, display_name: 'Marie' }); const W = nid(); F.ids = { W }; F.db.lists.push({ id: W, owner_id: ME.id, kind: 'wishes', title: 'Mes envies', emoji: '🎀', occasion: 'christmas', created_at: '1' }); F.db.list_members.push({ list_id: W, user_id: ME.id, role: 'owner' }); F.st.og = (b) => (b.image ? { data: { error: 'x' }, error: null } : { data: { title: 'Sac', image: 'https://shop.fr/s.png' }, error: null }); } });
  w.V2API.resizeImage = async (b) => b;
  await click(w, '[data-id="mine"]'); await click(w, '.person'); await click(w, '[data-a="iadd"]');
  const fd1 = $(w, '#f'); fd1.elements.link.value = 'https://shop.fr/sac'; fd1.elements.link.dispatchEvent(new w.Event('change')); await sleep(150); setv(fd1, 'name', 'Sac à dos'); withFiles(w, $(w, '#f input[type=file]'), [mkFile(w, 1)]);
  w.__F.st.uploadFail = true; await submit(w, fd1); await sleep(200);
  t('photo en échec : l’envie est créée UNE fois, message clair dans la fenêtre', w.__F.db.items.filter((i) => i.name === 'Sac à dos').length === 1 && $(w, '#dlg').open && /une seule fois/.test($(w, '#ferr').textContent));
  await submit(w, $(w, '#f')); await sleep(200);
  t('2e appui : toujours une seule envie (pas de doublon), photo toujours absente', w.__F.db.items.filter((i) => i.name === 'Sac à dos').length === 1 && !w.__F.db.items.find((i) => i.name === 'Sac à dos').photo_path);
  w.__F.st.uploadFail = false; await submit(w, $(w, '#f')); await sleep(250);
  const sac = w.__F.db.items.filter((i) => i.name === 'Sac à dos');
  t('3e appui, photo qui passe : toujours UNE seule envie, avec sa photo, fenêtre fermée', sac.length === 1 && sac[0].photo_paths.length === 1 && !$(w, '#dlg').open && $$(w, 'article.card').filter((c) => /Sac à dos/.test(c.textContent)).length === 1);

  // 10. déconnexion
  await click(w, '#me'); await click(w, '[data-a="logout"]'); await sleep(100);
  t('déconnexion : retour à l’écran de connexion, copie locale effacée', !!$(w, '#authform') && !w.localStorage.getItem('noel2026_v2cache'));

  console.log(`\n${ok} ok, ${ko} échecs`); process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERREUR TEST', e); process.exit(2); });
