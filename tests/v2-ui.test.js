// Test de l'interface V2 avec un faux client Supabase en mémoire (les DROITS réels sont testés dans db/rls.test.mjs).
const { JSDOM } = require('jsdom'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*fonts[^>]*>/g, '');
let ok = 0, ko = 0; const t = (n, c) => { c ? ok++ : ko++; console.log((c ? '✓ ' : '✗ ') + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex64 = (c) => c.repeat(64);
let uid = 0; const nid = () => '00000000-0000-4000-8000-' + String(++uid).padStart(12, '0');

function fakeSb(opts = {}) {
  const db = { lists: [], list_members: [], items: [], profiles: [], item_private_notes: [], inbox_items: [], invite_links: [] };
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
      const rows = db[table]; let out = [];
      if (q.op === 'insert') {
        out = [].concat(q.p).map((r) => {
          const base = { id: nid(), created_at: new Date().toISOString() };
          if (table === 'items') Object.assign(base, { version: 1, favorite: false, bought: false, wrapped: false, created_by: me() && me().id, photo_path: null, link_title: null });
          if (table === 'lists') Object.assign(base, { emoji: '🎀', budget: null });
          return { ...base, ...r };
        });
        out.forEach((r) => { rows.push(r); if (table === 'lists') db.list_members.push({ list_id: r.id, user_id: r.owner_id, role: 'owner' }); });
      } else if (q.op === 'update') {
        out = rows.filter((r) => q.f.every((f) => f(r))); out.forEach((r) => { Object.assign(r, q.p); if (table === 'items') r.version++; });
      } else if (q.op === 'delete') {
        out = rows.filter((r) => q.f.every((f) => f(r))); out.forEach((r) => rows.splice(rows.indexOf(r), 1));
      } else if (q.op === 'upsert') {
        const keys = (q.conflict || 'id').split(','); const r = q.p; const ex = rows.find((x) => keys.every((k) => x[k] === r[k]));
        if (ex) Object.assign(ex, r); else rows.push({ ...r }); out = [r];
      } else {
        out = rows.filter((r) => q.f.every((f) => f(r)));
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
      resetPasswordForEmail: async (e, o) => { st.reset = { e, o }; return { error: null }; }, updateUser: async (p) => { st.pw = p; return { error: null }; }
    },
    from,
    rpc: async (n, a) => { st.calls.push('rpc:' + n); if (st.offline) return { data: null, error: { message: 'Failed to fetch' } }; return st.rpc[n] ? st.rpc[n](a) : { data: null, error: { message: 'rpc inconnu ' + n } }; },
    storage: { from: () => ({
      upload: async (p, blob) => { st.uploads.push(p); return { data: { path: p }, error: null }; }, remove: async (ps) => { st.removed.push(...ps); return { data: [], error: null }; },
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
  t('sans session : écran de connexion, pas d’icône profil', !!$(w, '#authform') && /Retrouver mes listes/.test(txt(w)) && $(w, '#tabs').hidden && $(w, '#me').hidden);
  setv($(w, '#authform'), 'email', 'a@x.fr'); setv($(w, '#authform'), 'password', 'mauvais'); await submit(w, $(w, '#authform'));
  t('mauvais mot de passe : message clair', /E-mail ou mot de passe incorrect/.test($(w, '#aerr').textContent));
  await click(w, '[data-id="up"]'); setv($(w, '#authform'), 'email', 'n@x.fr'); setv($(w, '#authform'), 'password', 'court'); await submit(w, $(w, '#authform'));
  t('inscription : mot de passe trop court refusé côté client', /8 caractères/.test($(w, '#aerr').textContent) && !w.__F.st.signup);
  setv($(w, '#authform'), 'password', 'longmotdepasse'); setv($(w, '#authform'), 'name', 'Nina'); await submit(w, $(w, '#authform'));
  t('inscription : e-mail de confirmation annoncé, prénom transmis', /Vérifie ta boîte mail/.test(txt(w)) && w.__F.st.signup.options.data.display_name === 'Nina' && w.__F.st.signup.options.emailRedirectTo === 'https://asch13320-cloud.github.io/Liste-cadeau/');
  await click(w, '[data-id="reset"]'); setv($(w, '#resetform'), 'email', 'n@x.fr'); await submit(w, $(w, '#resetform'));
  t('mot de passe oublié : message neutre (ne révèle pas si le compte existe)', /Si cette adresse a un compte/.test(txt(w)) && w.__F.st.reset.e === 'n@x.fr');
  await click(w, '[data-id="in"]'); setv($(w, '#authform'), 'email', 'moi@x.fr'); setv($(w, '#authform'), 'password', 'motdepasse1'); await submit(w, $(w, '#authform')); await sleep(150);
  t('connexion : accueil affiché avec 4 onglets et l’icône profil en haut', !!$(w, '.cover') && $$(w, '#tabs button').length === 4 && !$(w, '#me').hidden);

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
  t('accueil : stats et listes', /Mes listes/.test(txt(w)) && !!$(w, '.stats'));
  t('XSS : le nom du cadeau est échappé', !$(w, '#app img[src="x"]'));
  await click(w, '[data-id="mine"]');
  t('« Mes listes » : seulement mes listes non collaboratives', $$(w, '.person').length === 1);
  const names = () => $$(w, '.person h4').map((x) => x.textContent);
  t('« Mes listes » : envies présentes', names().some((n) => /Mes envies/.test(n)));
  t('liste partagée avec un collaborateur : classée dans « À plusieurs »', !names().some((n) => /Maman/.test(n)));
  await click(w, '[data-id="collab"]'); t('« À plusieurs » : liste de Maman', names().some((n) => /Maman/.test(n)));
  await click(w, '[data-id="shared"]'); t('« Partagées avec moi » : liste de Paul, avec son prénom', names().some((n) => /Envies de Paul/.test(n)) && /de Paul/.test(txt(w)));
  await click(w, '.person'); 
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
  await click(w, '[data-id="collab"]'); await click(w, '.person');
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
  await click(w, '[data-id="collab"]'); await click(w, '.person'); await click(w, '[data-a="lshare"]');
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

  // 10. déconnexion
  await click(w, '#me'); await click(w, '[data-a="logout"]'); await sleep(100);
  t('déconnexion : retour à l’écran de connexion, copie locale effacée', !!$(w, '#authform') && !w.localStorage.getItem('noel2026_v2cache'));

  console.log(`\n${ok} ok, ${ko} échecs`); process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERREUR TEST', e); process.exit(2); });
