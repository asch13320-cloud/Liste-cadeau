/* Interface V2 — même esprit que la V1 (carnet de découpages), données dans Supabase. */
(function (root) {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safe = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  const eur = (n) => (Math.round((+n || 0) * 100) / 100).toLocaleString('fr-FR') + ' €';
  const has = (v) => v !== '' && v != null;
  const plural = (n, a, b) => (n > 1 ? b : a);

  const PRIO = { love: "J'adorerais", like: "J'aime bien", maybe: 'Pourquoi pas' };
  const CAT = { beauty: 'Beauté', clothes: 'Vêtements', home: 'Maison', tech: 'Tech', leisure: 'Loisirs', other: 'Autre' };
  const STAT = { idea: 'Idée', wish: 'Envie', received: 'Reçu' };
  const SI = { idea: '💭', wish: '⭐', received: '🎁' };
  const ROLE = { owner: 'Propriétaire', collaborator: 'Collaborateur', reader: 'Lecteur' };
  const opts = (o) => Object.entries(o);
  const ISO = (d) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

  const S = { loading: true, user: null, tab: 'home', lid: null, filter: 'all', busy: false, offline: !navigator.onLine, cached: false, rt: false, recovery: false, pub: null, authMode: 'in', notice: '', backupDone: false, dirty: false };
  let D = null, api = null, sb = null, unsub = null, poll = null, pubPoll = null, refreshing = null, entering = false;
  const PH = {}; // chemin photo -> { url, exp }

  // ------------------------------------------------------------------ utilitaires
  function toast(m) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'alert'); document.body.appendChild(t); }
    t.textContent = m; t.className = 'on'; clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 6500);
  }
  const fail = (e) => { console.warn(e); toast(api ? api.friendly(e) : String(e.message || e)); };
  const mayWrite = () => { if (S.offline || S.cached) { toast('⚠️ Hors-ligne : tu peux consulter, mais pas modifier pour l’instant.'); return false; } return true; };
  const list = (id) => D && D.lists.find((l) => l.id === id);
  const itemsOf = (id) => (D && D.items[id]) || [];
  const canEdit = (l) => l && (l.role === 'owner' || l.role === 'collaborator');
  const nameOf = (uid) => (D.me.id === uid ? 'Moi' : D.names[uid] || 'Un membre');
  const memberCount = (l) => (D.members[l.id] || []).length;
  const isCollab = (l) => l.role === 'collaborator' || (l.role === 'owner' && (D.members[l.id] || []).some((m) => m.role === 'collaborator'));
  const baseUrl = () => (root.CFG && root.CFG.site) || location.href.split('#')[0];
  const price = (t) => { const m = String(t).match(/(\d+[.,]?\d*)\s*€/); return m ? +m[1].replace(',', '.') : ''; };
  const clean = (t) => String(t).replace(/[—–-]?\s*\d+[.,]?\d*\s*€/, '').trim() || t;
  const newId = () => root.V2API.newId();

  // ------------------------------------------------------------------ boîtes de dialogue
  function modal(html) {
    const d = $('#dlg'); d.innerHTML = html;
    if (!d.open) d.showModal();
    return d;
  }
  const closeModal = () => { const d = $('#dlg'); if (d.open) d.close(); };

  function field(f) {
    const id = 'f_' + f.k, lab = `<label for="${id}">${f.l}`;
    if (f.t === 'html') return f.html;
    if (f.t === 'sel') return `${lab}<select id="${id}" name="${f.k}">${f.o.map(([v, t]) => `<option value="${esc(v)}" ${v === f.v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    if (f.t === 'area') return `${lab}<textarea id="${id}" name="${f.k}" rows="3" maxlength="2000">${esc(f.v)}</textarea></label>`;
    if (f.t === 'photo') return `${lab}<input id="${id}" type="file" name="${f.k}" accept="image/*">${f.has ? `<span style="font-weight:600"><input type="checkbox" name="${f.k}_remove"> Supprimer la photo actuelle</span>` : ''}</label>`;
    if (f.t === 'check') return `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="${f.k}" ${f.v ? 'checked' : ''}> ${f.l}</label>`;
    const num = f.t === 'number';
    return `${lab}<input id="${id}" name="${f.k}" type="${f.t || 'text'}" ${num ? 'step="any" inputmode="decimal" min="0"' : ''} value="${esc(f.v)}" ${f.r ? 'required' : ''} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''} ${f.max ? `maxlength="${f.max}"` : ''} autocomplete="${f.ac || 'off'}"></label>`;
  }

  // Formulaire modal : l'erreur s'affiche DANS la fenêtre (une alerte en dessous serait cachée).
  function form({ title, sub, fields, submit = 'Enregistrer', onSubmit, after }) {
    const d = modal(`<form id="f" novalidate><h3>${title}</h3>${sub ? `<p class="sub">${sub}</p>` : ''}${fields.map(field).join('')}<p class="err" id="ferr" role="alert"></p>
      <div class="row"><button type="button" class="ghost" data-close>Annuler</button><button class="pri" id="fsub">${submit}</button></div></form>`);
    const f = $('#f', d);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const b = $('#fsub'), er = $('#ferr'); er.textContent = '';
      for (const el of f.querySelectorAll('[required]')) if (!String(el.value).trim()) { er.textContent = 'Merci de remplir : ' + (el.labels[0] ? el.labels[0].firstChild.textContent : el.name); el.focus(); return; }
      if (!mayWrite()) return;
      b.disabled = true; b.textContent = '…';
      try {
        const fd = new FormData(f), o = {};
        for (const k of fd.keys()) o[k] = fd.get(k);
        f.querySelectorAll('input[type=checkbox]').forEach((c) => { o[c.name] = c.checked; });
        const res = await onSubmit(o, f);
        if (res !== false) closeModal();
      } catch (x) { er.textContent = api.friendly(x); console.warn(x); }
      finally { b.disabled = false; b.textContent = submit; }
    };
    if (after) after(f);
    return f;
  }

  function choose(title, options, sub) {
    return new Promise((resolve) => {
      const d = modal(`<h3>${title}</h3>${sub ? `<p class="sub">${sub}</p>` : ''}<div class="pk">${options.map((o, i) => `<button data-i="${i}">${esc(o.l)}</button>`).join('')}</div><div class="row"><button class="ghost" data-close>Annuler</button></div>`);
      let done = false;
      d.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { done = true; closeModal(); resolve(options[b.dataset.i].v); }; });
      d.addEventListener('close', () => { if (!done) resolve(undefined); }, { once: true });
    });
  }
  const confirmDel = (what, extra) => choose('Supprimer ?', [{ v: 1, l: '🗑️ Oui, supprimer' }], what + (extra ? ' ' + extra : '')).then((v) => v === 1);

  // ------------------------------------------------------------------ photos (liens signés temporaires)
  async function hydratePhotos() {
    const imgs = [...document.querySelectorAll('img[data-photo]')];
    const need = [...new Set(imgs.map((i) => i.dataset.photo).filter((p) => !PH[p] || PH[p].exp < Date.now() + 60000))];
    if (need.length && !S.offline) {
      try { const r = await api.signPhotos(need); Object.entries(r).forEach(([p, u]) => { PH[p] = { url: u, exp: Date.now() + 3500 * 1000 }; }); } catch (e) { console.warn(e); }
    }
    imgs.forEach((i) => { const p = PH[i.dataset.photo]; if (p && i.getAttribute('src') !== p.url) i.src = p.url; });
  }
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.dataset.fb !== undefined) { const d = document.createElement('div'); d.className = 'ph'; d.style.cssText = 'height:96px;display:grid;place-items:center;font-size:44px'; d.textContent = '✂️'; t.replaceWith(d); }
  }, true);

  // ------------------------------------------------------------------ chargement des données
  const CACHE = 'noel2026_v2cache';
  function saveCache() { try { localStorage.setItem(CACHE, JSON.stringify({ uid: S.user.id, at: Date.now(), D })); } catch (e) { /* trop gros : tant pis */ } }
  function loadCache(uid) { try { const c = JSON.parse(localStorage.getItem(CACHE)); return c && c.uid === uid ? c.D : null; } catch (e) { return null; } }

  async function load() {
    S.busy = true; syncChip();
    try {
      D = await api.loadAll(S.user);
      S.cached = false; S.offline = false; saveCache();
    } catch (e) {
      if (api.isNetworkError(e)) {
        const c = loadCache(S.user.id);
        if (c) { D = c; S.cached = true; S.offline = true; toast('Hors-ligne : dernière version enregistrée affichée (lecture seule).'); } else throw e;
      } else throw e;
    } finally { S.busy = false; }
  }
  const typing = () => { const a = document.activeElement; return a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && $('#app').contains(a); };
  async function refresh(force) {
    if (!S.user) return;
    if (refreshing) return refreshing;
    if (!force && typing()) { S.dirty = true; return; }
    refreshing = (async () => {
      try { await load(); if (S.lid && !list(S.lid)) { S.lid = null; if (S.tab === 'detail') S.tab = 'mine'; } render(); }
      catch (e) { fail(e); S.offline = api.isNetworkError(e); syncChip(); }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  document.addEventListener('focusout', () => { if (S.dirty) setTimeout(() => { if (!typing()) { S.dirty = false; refresh(); } }, 150); });
  let rdb; const refreshSoon = () => { clearTimeout(rdb); rdb = setTimeout(() => refresh(), 500); };

  function startSync() {
    stopSync();
    unsub = api.subscribe(S.user.id, refreshSoon, (s) => { S.rt = s === 'SUBSCRIBED'; syncChip(); });
    poll = setInterval(() => { if (!document.hidden && !S.offline) refresh(); }, 45000);
  }
  function stopSync() { if (unsub) unsub(); unsub = null; clearInterval(poll); poll = null; S.rt = false; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) refresh(); });
  root.addEventListener('online', () => { S.offline = false; syncChip(); refresh(true); });
  root.addEventListener('offline', () => { S.offline = true; syncChip(); });

  function syncChip() {
    const c = $('#sync'); if (!c) return;
    if (!S.user) { c.hidden = true; return; }
    c.hidden = false;
    const bad = S.offline || S.cached;
    c.className = 'sync' + (bad ? ' bad' : '');
    c.textContent = bad ? '⚠ Hors-ligne' : S.busy ? '↻ Synchronisation…' : S.rt ? '● En direct' : '● À jour';
    c.title = bad ? 'Pas de connexion : lecture seule' : S.rt ? 'Les modifications des autres apparaissent aussitôt' : 'Actualisation régulière';
  }

  // ------------------------------------------------------------------ entrée / sortie
  async function enter(user) {
    if (entering || (S.user && S.user.id === user.id && D)) return;
    entering = true; S.user = user; S.loading = false;
    try {
      await load(); startSync();
      const tok = sessionStorage.getItem('noel_join');
      if (tok) { sessionStorage.removeItem('noel_join'); await joinWith(tok, true); }
    } catch (e) { fail(e); }
    finally { entering = false; }
    S.pub = S.pub && S.pub.keep ? S.pub : null;
    render();
  }
  function leave() { stopSync(); clearInterval(pubPoll); S.user = null; D = null; S.tab = 'home'; S.lid = null; S.pub = null; try { localStorage.removeItem(CACHE); } catch (e) { /* ignore */ } render(); }

  async function joinWith(token, silent) {
    const r = await api.redeem(token);
    await load();
    S.tab = 'detail'; S.lid = r.list_id; S.pub = null;
    if (!silent) render();
    toast('✅ Tu as rejoint la liste (' + ROLE[r.role].toLowerCase() + ').');
  }

  // ------------------------------------------------------------------ routes par le « # »
  function parseHash() {
    const m = /^#(join|view)\/([a-f0-9]{64})$/.exec(location.hash || '');
    return m ? { type: m[1], token: m[2] } : null;
  }
  const clearHash = () => history.replaceState(null, '', location.pathname + location.search);
  async function route() {
    const r = parseHash();
    if (!r) return;
    if (r.type === 'join') {
      if (S.user) { try { await joinWith(r.token); } catch (e) { fail(e); } clearHash(); render(); }
      else { sessionStorage.setItem('noel_join', r.token); S.authMode = 'in'; S.notice = 'Connecte-toi ou crée un compte pour rejoindre la liste.'; clearHash(); render(); }
    } else { clearHash(); await openPublic(r.token); }
  }
  async function openPublic(token) {
    S.pub = { token, data: null, err: '', loading: true, keep: true }; render();
    const go = async () => {
      try { const d = await api.publicView(token); S.pub.data = d; S.pub.err = d ? '' : 'Ce lien n’est plus valide (expiré ou révoqué).'; }
      catch (e) { S.pub.err = api.friendly(e); }
      S.pub.loading = false; if (S.pub && S.pub.token === token) render();
    };
    await go(); clearInterval(pubPoll);
    pubPoll = setInterval(() => { if (S.pub && !document.hidden && !typing()) go(); else if (!S.pub) clearInterval(pubPoll); }, 20000);
  }

  // ------------------------------------------------------------------ cartes
  const btn = (a, id, l, c) => `<button data-a="${a}" data-id="${esc(id)}" class="${c || ''}">${l}</button>`;
  function itemPhoto(it, h) {
    if (it.photo_path) return `<img class="ph" data-photo="${esc(it.photo_path)}" data-fb alt="" style="height:${h}px;object-fit:cover" loading="lazy">`;
    if (safe(it.link_image)) return `<img class="ph" src="${esc(it.link_image)}" referrerpolicy="no-referrer" loading="lazy" data-fb alt="" style="height:${h}px;object-fit:cover">`;
    return `<div class="ph" style="height:${h - 16}px;display:grid;place-items:center;font-size:44px">${it.bought ? '🎁' : '✂️'}</div>`;
  }

  function itemCard(l, it) {
    const ed = canEdit(l), w = l.kind === 'wishes', note = D.notes[it.id];
    const tags = [];
    if (w && it.priority) tags.push(`<span class="tag p${['love', 'like', 'maybe'].indexOf(it.priority)}">${esc(PRIO[it.priority])}</span>`);
    if (w && it.category) tags.push(`<span class="tag">${esc(CAT[it.category])}</span>`);
    if (has(it.est_price)) tags.push(`<span class="tag">${eur(it.est_price)}</span>`);
    const acts = [];
    if (ed && w) acts.push(btn('inext', it.id, (SI[it.status] || '⭐') + ' · changer', 'on'));
    if (ed && !w) acts.push(btn('ibuy', it.id, it.bought ? '✓ Trouvé !' : '🛍️ Trouvé ?', it.bought ? 'on' : ''), btn('iwrap', it.id, it.wrapped ? '🎀 Emballé !' : '🎀 Emballer', it.wrapped ? 'on' : ''));
    if (ed) acts.push(btn('iedit', it.id, '✎'), btn('imove', it.id, w ? '🎁 Pour qui ?' : '→ Autre liste'));
    if (safe(it.link)) acts.push(`<a href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">Voir le produit ↗</a>`);
    if (ed) acts.push(btn('idel', it.id, '×'));
    return `<article class="card ${it.favorite ? 'fav' : ''}">${itemPhoto(it, 112)}
      <div class="top"><h4 class="wish-title">${esc(it.name)}</h4>${w ? (ed ? btn('ifav', it.id, it.favorite ? '💖' : '☆', 'heart') : (it.favorite ? '<span class="heart">💖</span>' : '')) : `<span class="tag">${has(it.est_price) ? eur(it.est_price) : '–'}</span>`}</div>
      ${tags.length && w ? `<div class="tags">${tags.join('')}</div>` : ''}
      ${!w && it.bought && has(it.spent) ? `<div class="note">Dépensé : ${eur(it.spent)}</div>` : ''}
      ${it.link_title && it.link_title !== it.name ? `<p class="note">🔗 ${esc(it.link_title)}</p>` : ''}
      ${it.notes ? `<p class="note">${w ? '✎' : '🔒'} ${esc(it.notes)}</p>` : ''}
      ${note ? `<p class="private">🔐 Ma note perso : ${esc(note)}</p>` : ''}
      <div class="acts">${acts.join('')}</div></article>`;
  }

  function listCard(l) {
    const its = itemsOf(l.id), b = its.filter((i) => i.bought).length, mc = memberCount(l);
    const badges = [`<span class="badge ${l.role === 'owner' ? 'pine' : l.role === 'collaborator' ? 'red' : 'blue'}">${ROLE[l.role]}</span>`];
    if (l.role !== 'reader' && mc > 1) badges.push(`<span class="badge">👥 ${mc}</span>`);
    return `<button class="person tap" data-a="lopen" data-id="${l.id}"><div class="top"><h4>${esc(l.emoji)} ${esc(l.title)}</h4><span class="small-label">${its.length} ${plural(its.length, 'idée', 'idées')}</span></div>
      <div class="bar"><i style="width:${l.kind === 'gifts_for' && its.length ? (b / its.length) * 100 : 0}%"></i></div>
      <span class="small-label">${l.kind === 'wishes' ? 'Liste d’envies' : `${b} ${plural(b, 'trouvé', 'trouvés')} · budget ${has(l.budget) ? eur(l.budget) : 'libre'}`}</span><div style="margin-top:6px">${badges.join('')}${l.role === 'reader' && l.owner_id !== D.me.id && D.names[l.owner_id] ? `<span class="badge">de ${esc(D.names[l.owner_id])}</span>` : ''}</div></button>`;
  }

  // ------------------------------------------------------------------ vues
  function sum(a) { return a.reduce((s, x) => s + (+x || 0), 0); }

  function viewHome() {
    const gl = D.lists.filter((l) => l.kind === 'gifts_for' && canEdit(l)), gi = gl.flatMap((l) => itemsOf(l.id));
    const favs = D.lists.filter((l) => l.kind === 'wishes' && l.role === 'owner').flatMap((l) => itemsOf(l.id).filter((i) => i.favorite).map((i) => [l, i])).slice(0, 3);
    const bud = sum(gl.map((l) => l.budget)), sp = sum(gi.map((i) => i.spent));
    const myW = D.lists.filter((l) => l.kind === 'wishes' && l.role === 'owner');
    return `<section class="cover"><div class="cover-copy"><div class="edition">Édition spéciale · Hiver 2026</div><h2>La magie<br>des envies.</h2><p>Un petit carnet de choses qui me feraient plaisir…</p></div><div class="cover-stamp">100%<br>envies<br> choisies</div><div class="cover-art">🎄</div></section>
    <form id="qa" class="qa"><input name="q" placeholder="Une idée à découper et garder…" aria-label="Idée en vrac" maxlength="1000"><button class="pri">Coller ✂</button></form>
    <div class="section-head"><h2>Dans mon atelier</h2><span class="paper-note">Le compte à rebours est lancé</span></div>
    <div class="stats"><div class="stat"><b>${gl.length}</b><span>carnets</span></div><div class="stat"><b>${gi.length}</b><span>cadeaux notés</span></div><div class="stat"><b>${sum(myW.map((l) => itemsOf(l.id).length))}</b><span>mes envies</span></div>
    <div class="stat pine"><b>${gi.filter((i) => i.bought).length}</b><span>trouvés</span></div><div class="stat pine"><b>${gi.filter((i) => i.wrapped).length}</b><span>emballés</span></div><div class="stat red"><b>${eur(sp)}</b><span>dépensés</span></div></div>
    <div class="section-head"><h2>Mes listes</h2><span class="paper-note">Pour les gens que j'aime ♥</span></div>
    ${D.lists.length ? `<div>${D.lists.slice(0, 6).map(listCard).join('')}</div>${D.lists.length > 6 ? btn('tab', 'mine', 'Voir toutes mes listes') : ''}` : '<p class="empty">Ta première liste n’attend que son titre. 🎀</p>' + btn('lnew', 0, '＋ Créer une liste', 'pri')}
    <div class="section-head"><h2>Mon coin des coups de cœur</h2><span class="paper-note">À garder sous le coude</span></div>
    ${favs.length ? `<div class="scrap-grid">${favs.map(([l, i]) => itemCard(l, i)).join('')}</div>` : '<p class="empty">Ajoute des étoiles à tes envies pour les retrouver ici.</p>'}
    <div class="card"><div class="top"><div><div class="small-label">La hotte en préparation</div><h4>Budget restant</h4></div><strong style="font:700 23px var(--display);color:var(--pine)">${eur(bud - sp)}</strong></div><p class="note">Sur ${eur(bud)} prévus pour tous les carnets.</p></div>
    <div class="card"><div class="top"><div><div class="small-label">Les bouts de papier qui traînent</div><h4>Mon tiroir à idées 💡</h4></div><span class="tag">${D.inbox.length}</span></div><div class="acts">${btn('tab', 'vrac', 'Ouvrir le tiroir', 'on')}</div></div>`;
  }

  function viewVrac() {
    return `<button class="ghost" data-a="tab" data-id="home">← Atelier</button><div class="section-head"><div><div class="small-label">Les bouts de papier qui traînent</div><h2>Mon tiroir à idées 💡</h2></div></div><p class="intro">On note vite, on rangera plus tard.</p>
    <form id="qa" class="qa"><input name="q" placeholder="Une idée…" aria-label="Idée" maxlength="1000"><button class="pri">Coller ✂</button></form>
    ${D.inbox.length ? `<div class="scrap-grid">${D.inbox.map((v) => `<article class="card"><div class="small-label">À classer</div><h4>${esc(v.text)}</h4><div class="acts" style="margin-top:12px">${btn('vgive', v.id, '🎁 Pour qui ?')}${btn('vwish', v.id, '🎀 Mes envies')}${btn('vdel', v.id, '×')}</div></article>`).join('')}</div>` : '<p class="empty">Ton tiroir est vide. Profite, ça ne durera pas. 😌</p>'}`;
  }

  function viewLists(kind) {
    const L = D.lists.filter((l) => (kind === 'mine' ? l.role === 'owner' : kind === 'collab' ? isCollab(l) : l.role === 'reader'));
    if (kind === 'mine') {
      const mine = L.filter((l) => !isCollab(l));
      return `<div class="section-head"><div><div class="small-label">Mes carnets à moi</div><h2>Mes listes 🎀</h2></div><span class="paper-note">${mine.length} ${plural(mine.length, 'liste', 'listes')}</span></div>
      <p class="intro">Mes envies, et mes carnets de cadeaux pour les autres.</p>${btn('lnew', 0, '＋ Créer une liste', 'pri')}<div style="margin-top:14px">${mine.map(listCard).join('') || '<p class="empty">Crée ta première liste. ✨</p>'}</div>`;
    }
    if (kind === 'collab') {
      return `<div class="section-head"><div><div class="small-label">À plusieurs, c'est mieux</div><h2>Listes collaboratives 🤝</h2></div><span class="paper-note">${L.length}</span></div>
      <p class="intro">Préparez ensemble les cadeaux de quelqu'un : tout le monde ajoute, modifie et coche en direct.</p>
      <div class="acts" style="margin-bottom:14px">${btn('lnewc', 0, '＋ Nouvelle liste collaborative', 'pri')}${btn('ljoin', 0, '🔗 Rejoindre avec un lien')}</div>${L.map(listCard).join('') || '<p class="empty">Aucune liste collaborative pour l’instant.</p>'}`;
    }
    return `<div class="section-head"><div><div class="small-label">Les listes des autres</div><h2>Partagées avec moi 💌</h2></div><span class="paper-note">${L.length}</span></div>
      <p class="intro">Tu peux les consulter, mais pas les modifier. Elles se mettent à jour toutes seules.</p>
      <div class="acts" style="margin-bottom:14px">${btn('ljoin', 0, '🔗 Ouvrir un lien reçu')}</div>${L.map(listCard).join('') || '<p class="empty">Personne n’a encore partagé de liste avec toi.</p>'}`;
  }

  function viewDetail() {
    const l = list(S.lid); if (!l) return '<p class="empty">Cette liste n’existe plus.</p>';
    const all = itemsOf(l.id), ed = canEdit(l), w = l.kind === 'wishes', F = S.filter;
    const filters = w ? [['all', 'Tout'], ['idea', 'Idée'], ['wish', 'Envie'], ['received', 'Reçu']] : [['all', 'Tout'], ['todo', 'À trouver'], ['bought', 'Trouvés'], ['wrapped', 'Emballés']];
    const shown = all.filter((i) => F === 'all' || (w ? i.status === F : F === 'todo' ? !i.bought : F === 'bought' ? i.bought : i.wrapped));
    const sp = sum(all.map((i) => i.spent)), pc = has(l.budget) && +l.budget ? Math.min(100, (sp / l.budget) * 100) : 0;
    const back = l.role === 'reader' ? 'shared' : isCollab(l) ? 'collab' : 'mine';
    return `<button class="ghost" data-a="tab" data-id="${back}">← Retour</button>
    <div class="section-head"><div><div class="small-label">${w ? 'Liste d’envies' : 'Le carnet de'}</div><h2>${esc(l.emoji)} ${esc(l.title)}</h2></div><span class="paper-note">${ROLE[l.role]}</span></div>
    ${l.role === 'reader' ? '<p class="banner">👀 Lecture seule : tu vois cette liste en direct, mais tu ne peux pas la modifier.</p>' : ''}
    ${!w ? `<div class="card"><div class="top"><div><div class="small-label">La hotte</div><h4>${all.length} ${plural(all.length, 'idée', 'idées')} à préparer</h4></div><b style="font:700 22px var(--display)">${eur(sp)}</b></div>${has(l.budget) ? `<p class="note">Dépensé sur ${eur(l.budget)} prévus</p>` : ''}<div class="bar"><i style="width:${pc}%"></i></div></div>` : ''}
    <div class="acts" style="margin:12px 0">${ed ? btn('iadd', l.id, '＋ Ajouter', 'on') : ''}${l.role === 'owner' ? btn('lshare', l.id, '👥 Partager') + btn('ledit', l.id, '✎ Modifier') + btn('ldel', l.id, 'Supprimer') : l.role === 'collaborator' ? btn('lmembers', l.id, '👥 Membres') + btn('lleave', l.id, 'Quitter') : btn('lleave', l.id, 'Quitter la liste')}</div>
    <div class="chips">${filters.map(([k, t]) => `<button class="chip ${F === k ? 'on' : ''}" data-a="filter" data-id="${k}">${t}</button>`).join('')}</div>
    ${shown.length ? `<div class="scrap-grid">${shown.map((i) => itemCard(l, i)).join('')}</div>` : `<p class="empty">${all.length ? 'Rien dans ce filtre.' : ed ? 'La page est encore blanche… à toi de la remplir ! ✂️' : 'Cette liste est vide pour le moment.'}</p>`}`;
  }

  function legacyData() {
    try {
      const o = JSON.parse(localStorage.getItem('noel2026'));
      if (!o || !Array.isArray(o.wishes) || !Array.isArray(o.people)) return null;
      o.inbox = Array.isArray(o.inbox) ? o.inbox : []; return o;
    } catch (e) { return null; }
  }
  function viewProfile() {
    const L = legacyData(), n = L ? { w: L.wishes.length, g: sum(L.people.map((p) => (p.gifts || []).length)), p: L.people.length, i: L.inbox.length } : null;
    let rep = null; try { rep = JSON.parse(localStorage.getItem('noel2026_v2_import')); } catch (e) { /* ignore */ }
    return `<div class="section-head"><div><div class="small-label">Mon compte</div><h2>Profil 👤</h2></div></div>
    <div class="card"><div class="small-label">Connectée avec</div><h4>${esc(D.me.email)}</h4>
      <form id="nameform" class="qa" style="margin-top:10px"><input name="name" value="${esc(D.me.name)}" placeholder="Mon prénom (vu par les membres)" maxlength="60" aria-label="Prénom"><button class="pri">Enregistrer</button></form></div>
    <div class="card"><h4>Changer mon mot de passe</h4><form id="pwform" class="qa" style="margin-top:8px"><input name="pw" type="password" minlength="8" autocomplete="new-password" placeholder="Nouveau mot de passe (8+ caractères)" aria-label="Nouveau mot de passe"><button class="pri">Changer</button></form></div>
    <div class="section-head"><h2>Mes données 💾</h2></div>
    <div class="card"><p class="note">Une copie de toutes tes listes, à garder si tu veux.</p><div class="acts">${btn('cexport', 0, '⬇ Exporter mes listes (JSON)', 'on')}${btn('ccopy', 0, '📋 Copier')}</div></div>
    <div class="section-head"><h2>Mon ancienne version 📦</h2></div>
    <div class="card">${n ? `<p class="note">Sur cet appareil : <b>${n.w}</b> ${plural(n.w, 'envie', 'envies')}, <b>${n.p}</b> ${plural(n.p, 'carnet', 'carnets')} (${n.g} ${plural(n.g, 'cadeau', 'cadeaux')}), <b>${n.i}</b> ${plural(n.i, 'idée', 'idées')} en vrac.</p>
      <p class="note"><b>Rien n’est supprimé</b> de cet appareil, même après l’import. Tu peux relancer l’import sans créer de doublons.</p>
      <div class="acts">${btn('lbackup', 0, '1. ⬇ Sauvegarder (JSON)', S.backupDone ? 'on' : '')}${btn('limport', 0, '2. ⬆ Importer dans mon compte', 'pri')}</div>
      ${S.backupDone ? '<p class="okmsg">✓ Sauvegarde faite.</p>' : '<p class="note">Fais d’abord la sauvegarde (étape 1).</p>'}
      ${rep ? `<p class="note">Dernier import : ${esc(ISO(rep.at))} — ${esc(rep.summary)}</p>` : ''}` : '<p class="note">Aucune donnée de l’ancienne version sur cet appareil.</p>'}
      <div class="acts"><a class="btnlink" href="local.html">Ouvrir l’ancienne version (sans compte)</a></div></div>
    <div class="card"><div class="acts">${btn('logout', 0, 'Me déconnecter', 'on')}</div><p class="note">Synchronisation : ${S.offline ? 'hors-ligne' : S.rt ? 'en direct' : 'régulière'} · version 2</p></div>`;
  }

  // ------------------------------------------------------------------ écrans sans compte
  function viewAuth() {
    const m = S.authMode;
    return `<div class="auth"><div class="seg"><button class="${m === 'in' ? 'on' : ''}" data-a="amode" data-id="in">Connexion</button><button class="${m === 'up' ? 'on' : ''}" data-a="amode" data-id="up">Créer un compte</button></div>
    ${S.notice ? `<p class="banner">${esc(S.notice)}</p>` : ''}
    ${m === 'reset' ? `<form id="resetform" novalidate><h3 style="margin:0">Mot de passe oublié</h3><label>Adresse e-mail<input name="email" type="email" autocomplete="email" required></label><p class="err" id="aerr"></p><button class="pri">Recevoir un lien</button><button type="button" class="ghost" data-a="amode" data-id="in">← Retour</button></form>`
      : `<form id="authform" novalidate data-mode="${m}"><h3 style="margin:0">${m === 'in' ? 'Retrouver mes listes' : 'Créer mon compte'}</h3>
      ${m === 'up' ? '<label>Prénom (vu par les personnes avec qui tu partages)<input name="name" maxlength="60" autocomplete="given-name"></label>' : ''}
      <label>Adresse e-mail<input name="email" type="email" autocomplete="email" required></label>
      <label>Mot de passe${m === 'up' ? ' (8 caractères minimum)' : ''}<input name="password" type="password" minlength="8" autocomplete="${m === 'in' ? 'current-password' : 'new-password'}" required></label>
      <p class="err" id="aerr" role="alert"></p><button class="pri">${m === 'in' ? 'Me connecter' : 'Créer mon compte'}</button>
      ${m === 'in' ? '<button type="button" class="ghost" data-a="amode" data-id="reset">Mot de passe oublié ?</button>' : ''}</form>`}
    <p class="note" style="text-align:center;margin-top:16px">Tes anciennes données (sur cet appareil) ne sont pas perdues.<br><a href="local.html">Ouvrir l’ancienne version sans compte</a></p></div>`;
  }
  function viewRecovery() {
    return `<div class="auth"><form id="recform" novalidate><h3 style="margin:0">Nouveau mot de passe</h3><label>Mot de passe (8 caractères minimum)<input name="pw" type="password" minlength="8" autocomplete="new-password" required></label><p class="err" id="aerr" role="alert"></p><button class="pri">Enregistrer</button></form></div>`;
  }
  function viewPublic() {
    const p = S.pub, d = p.data;
    if (p.loading) return '<p class="empty">Chargement…</p>';
    if (!d) return `<div class="auth"><p class="banner">${esc(p.err || 'Lien invalide.')}</p>${btn('pubclose', 0, '← Retour', 'ghost')}</div>`;
    return `<div class="section-head"><div><div class="small-label">Liste partagée avec toi</div><h2>${esc(d.list.emoji)} ${esc(d.list.title)}</h2></div><span class="paper-note">Lecture seule</span></div>
    <p class="banner">👀 Tu vois cette liste en direct (mise à jour automatique). Tu ne peux pas la modifier.</p>
    <div class="acts" style="margin-bottom:12px">${btn('pubkeep', 0, S.user ? '📌 Garder dans mes listes partagées' : '🔑 Me connecter pour la garder', 'on')}${btn('pubclose', 0, S.user ? 'Fermer' : 'Accueil')}</div>
    ${d.items.length ? `<div class="scrap-grid">${d.items.map((i) => `<article class="card ${i.favorite ? 'fav' : ''}">${safe(i.link_image) ? `<img class="ph" src="${esc(i.link_image)}" referrerpolicy="no-referrer" loading="lazy" data-fb alt="" style="height:112px;object-fit:cover">` : '<div class="ph" style="height:96px;display:grid;place-items:center;font-size:44px">✂️</div>'}
      <div class="top"><h4 class="wish-title">${esc(i.name)}</h4>${i.favorite ? '<span class="heart">💖</span>' : ''}</div>
      <div class="tags">${i.priority ? `<span class="tag p${['love', 'like', 'maybe'].indexOf(i.priority)}">${esc(PRIO[i.priority] || '')}</span>` : ''}${i.category ? `<span class="tag">${esc(CAT[i.category] || '')}</span>` : ''}${has(i.est_price) ? `<span class="tag">${eur(i.est_price)}</span>` : ''}</div>
      ${i.notes ? `<p class="note">✎ ${esc(i.notes)}</p>` : ''}${safe(i.link) ? `<div class="acts"><a href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">Voir le produit ↗</a></div>` : ''}</article>`).join('')}</div>` : '<p class="empty">Cette liste est vide pour le moment.</p>'}
    <p class="note" style="margin-top:12px">Les photos ne sont visibles qu’avec un compte (📌 « Garder »).</p>`;
  }

  // ------------------------------------------------------------------ rendu
  const TABS = [['home', '🏠', 'Atelier'], ['mine', '🎀', 'Mes listes'], ['collab', '🤝', 'À plusieurs'], ['shared', '💌', 'Partagées'], ['profile', '👤', 'Profil']];
  function render() {
    const app = $('#app'), tabs = $('#tabs');
    syncChip();
    if (S.pub) { app.innerHTML = viewPublic(); tabs.hidden = true; return; }
    if (S.recovery) { app.innerHTML = viewRecovery(); tabs.hidden = true; return; }
    if (S.loading && !S.user) { app.innerHTML = '<p class="empty">Chargement…</p>'; tabs.hidden = true; return; }
    if (!S.user || !D) { app.innerHTML = viewAuth(); tabs.hidden = true; return; }
    const v = { home: viewHome, vrac: viewVrac, mine: () => viewLists('mine'), collab: () => viewLists('collab'), shared: () => viewLists('shared'), detail: viewDetail, profile: viewProfile }[S.tab] || viewHome;
    app.innerHTML = (S.offline || S.cached ? '<p class="banner">⚠️ Hors-ligne : tu vois la dernière version enregistrée. Les modifications sont désactivées tant que la connexion n’est pas revenue.</p>' : '') + v();
    tabs.hidden = false; tabs.className = 'tabs five';
    const active = S.tab === 'detail' ? (list(S.lid) ? (list(S.lid).role === 'reader' ? 'shared' : isCollab(list(S.lid)) ? 'collab' : 'mine') : 'mine') : S.tab === 'vrac' ? 'home' : S.tab;
    tabs.innerHTML = TABS.map((t) => `<button class="${active === t[0] ? 'on' : ''}" data-a="tab" data-id="${t[0]}"><span>${t[1]}</span>${t[2]}</button>`).join('');
    hydratePhotos();
  }

  // ------------------------------------------------------------------ formulaires
  function listForm(l, forceKind) {
    const edit = !!l;
    return form({
      title: edit ? 'Modifier la liste' : forceKind === 'collab' ? 'Nouvelle liste collaborative 🤝' : 'Nouvelle liste 🎀',
      sub: edit || forceKind ? '' : 'Une liste d’envies se partage ; un carnet de cadeaux reste secret (partagé seulement avec ceux que tu invites).',
      fields: [
        { k: 'title', l: 'Titre', v: l ? l.title : '', r: 1, max: 120, ph: forceKind ? 'Cadeaux de Maman' : '' },
        { k: 'emoji', l: 'Emoji', v: l ? l.emoji : '🎀', max: 16 },
        ...(edit ? [] : forceKind ? [] : [{ k: 'kind', l: 'Type', t: 'sel', v: 'wishes', o: [['wishes', 'Mes envies (que je pourrai partager)'], ['gifts_for', 'Cadeaux pour quelqu’un (secret)']] }]),
        ...(!edit || l.kind === 'gifts_for' ? [{ k: 'budget', l: 'Budget prévu (€) — carnet de cadeaux seulement', t: 'number', v: l ? l.budget : '' }] : [])
      ],
      onSubmit: async (o) => {
        if (edit) { await api.updateList(l.id, { title: o.title, emoji: o.emoji, ...(l.kind === 'gifts_for' ? { budget: o.budget } : {}) }); await refresh(true); return; }
        const kind = forceKind ? 'gifts_for' : o.kind;
        const nl = await api.createList({ title: o.title, emoji: o.emoji, kind, budget: o.budget });
        await refresh(true); S.tab = 'detail'; S.lid = nl.id; S.filter = 'all'; render();
        if (forceKind) setTimeout(() => openShare(nl.id), 100);
        return;
      }
    });
  }

  function itemForm(l, it) {
    const w = l.kind === 'wishes', edit = !!it;
    let lp = it && (it.link_title || it.link_image) ? { title: it.link_title, image: it.link_image, description: it.link_description, price: it.link_price, url: it.link } : null;
    return form({
      title: edit ? 'Modifier ' + (w ? 'l’envie' : 'le cadeau') : w ? 'Nouvelle envie 🎀' : 'Nouveau cadeau pour ' + esc(l.title),
      fields: [
        { k: 'link', l: 'Lien du produit (facultatif)', t: 'url', v: it ? it.link : '', ph: 'https://…', ac: 'url' },
        { t: 'html', html: '<div id="lp"></div>' },
        { k: 'name', l: 'Cadeau', v: it ? it.name : '', r: 1, max: 200 },
        { k: 'est_price', l: 'Prix (€)', t: 'number', v: it ? it.est_price : '' },
        ...(w ? [{ k: 'priority', l: 'Priorité', t: 'sel', v: it ? it.priority || 'like' : 'like', o: opts(PRIO) }, { k: 'category', l: 'Catégorie', t: 'sel', v: it ? it.category || 'other' : 'other', o: opts(CAT) }, { k: 'status', l: 'Statut', t: 'sel', v: it ? it.status || 'wish' : 'wish', o: opts(STAT) }]
          : [{ k: 'spent', l: 'Dépensé réellement (€)', t: 'number', v: it ? it.spent : '' }]),
        { k: 'notes', l: w ? 'Notes (couleur, taille, modèle… — vues par les personnes qui voient la liste)' : '🔒 Notes (vues par tous les membres de la liste)', t: 'area', v: it ? it.notes : '' },
        { k: 'private', l: '🔐 Ma note perso (visible par moi seulement)', t: 'area', v: it ? D.notes[it.id] || '' : '' },
        { k: 'photo', l: 'Photo (depuis le téléphone ou l’ordinateur)', t: 'photo', has: !!(it && it.photo_path) }
      ],
      onSubmit: async (o) => {
        const patch = { name: o.name, est_price: o.est_price, link: o.link, notes: o.notes };
        if (w) Object.assign(patch, { priority: o.priority, category: o.category, status: o.status }); else patch.spent = o.spent;
        const sameLink = lp && o.link && lp.url === o.link;
        Object.assign(patch, sameLink ? { link_title: lp.title, link_image: lp.image, link_description: lp.description, link_price: lp.price } : { link_title: null, link_image: null, link_description: null, link_price: null });
        const file = $('#f input[type=file]').files[0];
        if (file && !/^image\//.test(file.type)) throw new Error('Ce fichier n’est pas une image.');
        let saved;
        if (edit) saved = await api.updateItem(it, patch);
        else saved = await api.createItem(l.id, patch, newId());
        const extra = {};
        try {
          if (file) { const path = await api.uploadPhoto(l.id, saved.id, file); if (saved.photo_path) await api.removePhoto(saved.photo_path).catch(() => {}); extra.photo_path = path; }
          else if (o.photo_remove && saved.photo_path) { await api.removePhoto(saved.photo_path).catch(() => {}); extra.photo_path = null; }
          if (Object.keys(extra).length) saved = await api.updateItem(saved, extra);
          await api.setPrivateNote(saved.id, o.private);
        } catch (e) { await refresh(true); throw new Error('Le cadeau est enregistré, mais : ' + api.friendly(e)); }
        await refresh(true);
      },
      after: (f) => {
        const link = f.elements.link, box = $('#lp', f);
        const showLp = () => {
          if (!lp) { box.innerHTML = ''; return; }
          box.innerHTML = `<div class="linkprev">${safe(lp.image) ? `<img src="${esc(lp.image)}" referrerpolicy="no-referrer" alt="" data-fb>` : ''}<div><b>${esc(lp.title || '')}</b>${lp.description ? `<div class="note">${esc(String(lp.description).slice(0, 140))}</div>` : ''}
            <div class="acts" style="margin-top:4px">${lp.title ? '<button type="button" id="usetitle">Utiliser le titre</button>' : ''}${lp.price ? `<button type="button" id="useprice">Prix du site : ${eur(lp.price)}</button>` : ''}</div></div></div>`;
          const ut = $('#usetitle', box), up = $('#useprice', box);
          if (ut) ut.onclick = () => { f.elements.name.value = lp.title; };
          if (up) up.onclick = () => { f.elements.est_price.value = lp.price; };
        };
        showLp();
        link.addEventListener('change', async () => {
          const v = link.value.trim(); lp = null; showLp();
          if (!v) return;
          try { api.safeUrl(v); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
          if (S.offline) return;
          box.innerHTML = '<p class="note">Je regarde le produit…</p>';
          const r = await api.linkPreview(v);
          if (r && (r.title || r.image)) { lp = { title: r.title, image: r.image, description: r.description, price: r.price, url: v }; if (!f.elements.name.value.trim() && r.title) f.elements.name.value = r.title; showLp(); }
          else box.innerHTML = '<p class="note">Aperçu automatique impossible pour ce site : saisis le titre à la main et ajoute une photo si tu veux. Le lien est conservé.</p>';
        });
      }
    });
  }

  // ------------------------------------------------------------------ partage / membres
  const linkFor = (tok, anon) => baseUrl() + (anon ? '#view/' : '#join/') + tok;
  async function copyText(t) { try { await navigator.clipboard.writeText(t); return true; } catch (e) { return false; } }

  async function openShare(lid, created) {
    const l = list(lid); if (!l) return;
    let invites = []; if (l.role === 'owner' && !S.offline) { try { invites = await api.listInvites(lid); } catch (e) { fail(e); } }
    const mem = D.members[lid] || [], now = Date.now();
    const active = invites.filter((i) => !i.revoked_at && new Date(i.expires_at) > now && i.uses < i.max_uses);
    modal(`<h3>👥 ${esc(l.title)}</h3>
      <h4>Membres</h4>${mem.map((m) => `<div class="member"><span>${esc(nameOf(m.user_id))} <span class="badge">${ROLE[m.role]}</span></span>${l.role === 'owner' && m.role !== 'owner' ? `<span><select data-role="${m.user_id}" aria-label="Rôle"><option value="collaborator" ${m.role === 'collaborator' ? 'selected' : ''}>Collaborateur</option><option value="reader" ${m.role === 'reader' ? 'selected' : ''}>Lecteur</option></select> <button data-rm="${m.user_id}" aria-label="Retirer">×</button></span>` : ''}</div>`).join('') || '<p class="note">Personne d’autre pour l’instant.</p>'}
      ${l.role === 'owner' ? `<h4>Inviter</h4><p class="sub"><b>Collaborateur</b> : peut tout modifier. <b>Lecteur</b> : voit la liste, ne peut rien changer.</p>
      <form id="invform" novalidate style="display:grid;gap:8px"><label>Rôle<select name="role"><option value="collaborator">Collaborateur</option><option value="reader">Lecteur</option></select></label>
      <label>Validité<select name="ttl"><option value="24">1 jour</option><option value="168" selected>7 jours</option><option value="720">30 jours</option></select></label>
      <label>Utilisations<select name="max"><option value="1">1 personne</option><option value="5">5 personnes</option><option value="20">20 personnes</option></select></label>
      <label>E-mail (facultatif : le lien ne marchera que pour ce compte)<input name="email" type="email" autocomplete="off"></label>
      ${l.kind === 'wishes' ? '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="anon"> Lecture seule sans compte (n’importe qui avec le lien)</label>' : ''}
      <p class="err" id="ierr" role="alert"></p><button class="pri">Créer le lien</button></form><div id="newlink">${created || ''}</div>
      <h4>Liens actifs</h4>${active.length ? active.map((i) => `<div class="member"><span>${ROLE[i.role]}${i.allow_anonymous ? ' · sans compte' : ''}${i.email ? ' · ' + esc(i.email) : ''}<br><span class="small-label">expire le ${esc(ISO(i.expires_at))} · ${i.uses}/${i.max_uses}</span></span><button data-rev="${i.id}">Révoquer</button></div>`).join('') + '<p class="sub">Pour ta sécurité, un lien n’est visible qu’à sa création.</p>' : '<p class="note">Aucun lien actif.</p>'}` : `<p class="sub">Seul le propriétaire gère les invitations.</p>`}
      <div class="row"><button class="ghost" data-close>Fermer</button></div>`);
    const d = $('#dlg');
    d.querySelectorAll('[data-role]').forEach((s) => { s.onchange = async () => { if (!mayWrite()) return; try { await api.setMemberRole(lid, s.dataset.role, s.value); await refresh(true); openShare(lid); } catch (e) { fail(e); } }; });
    d.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => { if (!mayWrite() || !(await confirmDel('Retirer ce membre de la liste ?'))) return openShare(lid); try { await api.removeMember(lid, b.dataset.rm); await refresh(true); } catch (e) { fail(e); } openShare(lid); }; });
    d.querySelectorAll('[data-rev]').forEach((b) => { b.onclick = async () => { if (!mayWrite()) return; try { await api.revokeInvite(b.dataset.rev); } catch (e) { fail(e); } openShare(lid); }; });
    const f = $('#invform', d);
    if (f) f.onsubmit = async (e) => {
      e.preventDefault(); if (!mayWrite()) return;
      const fd = new FormData(f), er = $('#ierr'), email = String(fd.get('email') || '').trim().toLowerCase(), anon = !!fd.get('anon'); er.textContent = '';
      if (anon && email) { er.textContent = 'Un lien sans compte ne peut pas être réservé à une adresse e-mail.'; return; }
      const role = anon ? 'reader' : fd.get('role');
      try {
        const r = await api.createInvite({ list: lid, role, ttl: +fd.get('ttl'), maxUses: +fd.get('max'), email, anonymous: anon });
        const url = linkFor(r.token, anon);
        const mailto = email ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Invitation à une liste de cadeaux')}&body=${encodeURIComponent('Voici ton lien : ' + url)}` : '';
        const html = `<h4>✅ Lien créé</h4><p class="sub">Copie-le maintenant : il ne sera plus affiché ensuite.</p><input class="copybox" readonly value="${esc(url)}" id="lnk" aria-label="Lien">
          <div class="acts" style="margin-top:6px"><button id="cp" class="on">📋 Copier</button>${navigator.share ? '<button id="shr">📤 Partager</button>' : ''}${mailto ? `<a class="btnlink" href="${esc(mailto)}">✉ Écrire à ${esc(email)}</a>` : ''}</div>`;
        await openShare(lid, html);
        const cp = $('#cp'); if (cp) { $('#lnk').select(); cp.onclick = async () => { cp.textContent = (await copyText(url)) ? '✓ Copié' : 'Sélectionne et copie le lien'; }; }
        const sh = $('#shr'); if (sh) sh.onclick = () => navigator.share({ title: 'Invitation', url }).catch(() => {});
      } catch (x) { er.textContent = api.friendly(x); }
    };
  }

  async function joinDialog() {
    form({
      title: 'Rejoindre avec un lien', sub: 'Colle ici le lien (ou le code) que tu as reçu.', submit: 'Rejoindre',
      fields: [{ k: 'lnk', l: 'Lien', r: 1, max: 600, ph: 'https://…#join/…' }],
      onSubmit: async (o) => {
        const m = /([a-f0-9]{64})/.exec(String(o.lnk).trim().toLowerCase());
        if (!m) throw new Error('Ce lien n’a pas le bon format.');
        const isView = /#view\//.test(o.lnk);
        if (isView) { closeModal(); await openPublic(m[1]); return false; }
        await joinWith(m[1]);
      }
    });
  }

  // ------------------------------------------------------------------ export JSON / migration
  async function downloadJSON(name, obj, kind) {
    const json = JSON.stringify(obj, null, 2);
    try {
      if (navigator.canShare && root.File) { try { const file = new File([json], name, { type: 'application/json' }); if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; } } catch (e) { if (e && e.name === 'AbortError') return false; } }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 60000);
      toast('✅ ' + (kind || 'Sauvegarde') + ' téléchargée : cherche « ' + name + ' » dans tes Téléchargements.'); return true;
    } catch (e) { return copyFallback(json); }
  }
  async function copyFallback(json) {
    if (await copyText(json)) { toast('✅ Copié dans le presse-papiers : colle-le dans une note.'); return true; }
    modal(`<h3>Copie ce texte 📋</h3><textarea class="copybox" rows="8" readonly id="cpt">${esc(json)}</textarea><div class="row"><button class="ghost" data-close>Fermer</button></div>`); $('#cpt').select(); return true;
  }
  function cloudSnapshot() {
    return { app: 'liste-cadeau', version: 2, exportedAt: new Date().toISOString(), lists: D.lists.map((l) => ({ ...l, items: itemsOf(l.id).map((i) => ({ ...i, my_private_note: D.notes[i.id] || null })) })), inbox: D.inbox };
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  async function runImport() {
    if (!mayWrite()) return;
    const L = legacyData(); if (!L) return toast('Aucune donnée locale à importer.');
    if (!S.backupDone) return toast('Fais d’abord la sauvegarde (étape 1).');
    const payload = JSON.parse(JSON.stringify(L)), photos = {};
    L.wishes.forEach((w) => { if (w.photo) photos['w:' + w.id] = w.photo; });
    L.people.forEach((p) => (p.gifts || []).forEach((g) => { if (g.photo) photos[p.id + '|g:' + g.id] = g.photo; }));
    payload.wishes.forEach((w) => { if (w.photo) w.photo = '1'; });
    payload.people.forEach((p) => (p.gifts || []).forEach((g) => { if (g.photo) g.photo = '1'; }));
    modal('<h3>Import en cours…</h3><p class="sub">Ne ferme pas l’application.</p>');
    let res, up = 0, upFail = 0, upSkip = 0;
    try {
      res = await api.importLegacy({ wishes: payload.wishes, people: payload.people, inbox: payload.inbox });
      const before = await api.verifyLegacy(), have = {}; before.items.forEach((i) => { have[i.id] = i; });
      const plegacy = {}; before.lists.forEach((l) => { plegacy[l.id] = l.legacy_key; });
      for (const m of res.items) {
        if (!m.has_photo) continue;
        const cur = have[m.item_id]; if (!cur) continue;
        if (cur.photo_path) { upSkip++; continue; }
        const src = m.legacy.startsWith('w:') ? photos[m.legacy] : photos[String(plegacy[m.list_id] || '').replace(/^p:/, '') + '|' + m.legacy];
        const blob = root.V2API.dataUrlToBlob(src);
        if (!blob) { upFail++; continue; }
        try { const path = await api.uploadPhoto(m.list_id, m.item_id, blob, true); await api.updateItem({ id: cur.id, version: cur.version }, { photo_path: path }); up++; } catch (e) { console.warn(e); upFail++; }
      }
    } catch (e) { closeModal(); return fail(e); }
    // vérification : on compare ce que contient l'ancienne version avec ce qu'il y a maintenant dans le compte
    const after = await api.verifyLegacy(); await refresh(true);
    const lk = {}; after.lists.forEach((l) => { lk[l.id] = l.legacy_key; });
    const server = new Set(after.items.map((i) => (lk[i.list_id] || '') + '|' + i.legacy_key)), inboxSrv = new Set(after.inbox.map((i) => i.legacy_key));
    const expW = [...new Set(L.wishes.map((w) => 'w:' + w.id))], expG = [...new Set(L.people.flatMap((p) => (p.gifts || []).map((g) => 'p:' + p.id + '|g:' + g.id)))], expI = [...new Set(L.inbox.map((i) => 'i:' + i.id))];
    const okW = expW.filter((k) => server.has('wishes|' + k)).length, okG = expG.filter((k) => server.has(k)).length, okI = expI.filter((k) => inboxSrv.has(k)).length;
    const okL = L.people.filter((p) => after.lists.some((l) => l.legacy_key === 'p:' + p.id)).length;
    const expPhotos = Object.keys(photos).length, okPhotos = after.items.filter((i) => i.photo_path).length;
    const line = (n, a, b) => `<p class="${a === b ? 'okmsg' : 'err'}">${a === b ? '✓' : '✗'} ${n} : ${a} / ${b}</p>`;
    const all = okW === expW.length && okG === expG.length && okI === expI.length && okL === L.people.length;
    const summary = `envies ${okW}/${expW.length}, cadeaux ${okG}/${expG.length}, idées ${okI}/${expI.length}, photos ${okPhotos}/${expPhotos}`;
    try { localStorage.setItem('noel2026_v2_import', JSON.stringify({ at: new Date().toISOString(), summary })); } catch (e) { /* ignore */ }
    modal(`<h3>${all ? '✅ Import terminé' : '⚠️ Import à vérifier'}</h3>${line('Envies', okW, expW.length)}${line('Carnets', okL, L.people.length)}${line('Cadeaux', okG, expG.length)}${line('Idées en vrac', okI, expI.length)}${line('Photos', Math.min(okPhotos, expPhotos), expPhotos)}
      <p class="note">Déjà présents (ignorés, rien n’est écrasé) : ${res.skipped_existing}. Photos ajoutées : ${up}${upFail ? `, échecs : ${upFail}` : ''}.</p>
      <p class="note"><b>Tes données locales n’ont pas été supprimées.</b> Tu peux relancer l’import sans risque de doublons.</p><div class="row"><button class="pri" data-close>OK</button></div>`);
    S.tab = 'mine'; render();
  }

  // ------------------------------------------------------------------ actions
  const WRITE = new Set(['inext', 'ibuy', 'iwrap', 'ifav', 'idel', 'imove', 'ldel', 'lleave', 'vdel', 'vwish', 'vgive']);
  async function patchItem(id, patch) {
    const it = findItem(id); if (!it) return;
    try { await api.updateItem(it, patch); await refresh(true); } catch (e) { fail(e); if (e.conflict) await refresh(true); }
  }
  function findItem(id) { for (const k of Object.keys(D.items)) { const i = D.items[k].find((x) => x.id === id); if (i) return i; } return null; }
  const itemList = (it) => list(it.list_id);

  async function pickTargetList(title, filterFn, sub) {
    const ls = D.lists.filter(filterFn);
    if (!ls.length) { toast('Crée d’abord une liste pour pouvoir y ranger ça.'); return null; }
    return choose(title, ls.map((l) => ({ v: l.id, l: l.emoji + ' ' + l.title })), sub);
  }
  async function moveItem(it, targetId) {
    const t = list(targetId); if (!t || !canEdit(t)) throw new Error('forbidden');
    const f = { name: it.name, est_price: it.est_price, link: it.link, notes: it.notes, link_title: it.link_title, link_image: it.link_image, link_description: it.link_description, link_price: it.link_price };
    if (t.kind === 'wishes') Object.assign(f, { priority: it.priority || 'like', category: it.category || 'other', status: it.status || 'wish', favorite: it.favorite });
    const nid = newId(); let created = await api.createItem(targetId, f, nid);
    if (it.photo_path) { try { const to = `${targetId}/${nid}/${newId()}.jpg`; await api.copyPhoto(it.photo_path, to); created = await api.updateItem(created, { photo_path: to }); } catch (e) { console.warn('photo non déplacée', e); } }
    await api.deleteItem(it);
  }

  const ACT = {
    tab: (id) => { S.tab = id; S.lid = null; S.filter = 'all'; render(); window.scrollTo(0, 0); },
    amode: (id) => { S.authMode = id; S.notice = ''; render(); },
    filter: (id) => { S.filter = id; render(); },
    lopen: (id) => { S.tab = 'detail'; S.lid = id; S.filter = 'all'; render(); window.scrollTo(0, 0); },
    lnew: () => listForm(), lnewc: () => listForm(null, 'collab'), ljoin: () => joinDialog(),
    ledit: (id) => listForm(list(id)), lshare: (id) => openShare(id), lmembers: (id) => openShare(id),
    ldel: async (id) => {
      const l = list(id), n = itemsOf(id).length;
      if (!(await confirmDel('« ' + l.title + ' » et ses ' + n + ' ' + plural(n, 'cadeau', 'cadeaux') + ' seront supprimés pour tous les membres.'))) return;
      try { await api.deleteList(id, itemsOf(id).map((i) => i.photo_path).filter(Boolean)); S.tab = 'mine'; S.lid = null; await refresh(true); } catch (e) { fail(e); }
    },
    lleave: async (id) => {
      if (!(await choose('Quitter cette liste ?', [{ v: 1, l: 'Oui, quitter' }], 'Tu ne la verras plus (le propriétaire peut te réinviter).'))) return;
      try { await api.removeMember(id, D.me.id); S.tab = 'shared'; S.lid = null; await refresh(true); } catch (e) { fail(e); }
    },
    iadd: (id) => itemForm(list(id)), iedit: (id) => { const it = findItem(id); itemForm(itemList(it), it); },
    inext: (id) => { const it = findItem(id); const o = ['idea', 'wish', 'received']; return patchItem(id, { status: o[(o.indexOf(it.status) + 1) % 3] }); },
    ifav: (id) => patchItem(id, { favorite: !findItem(id).favorite }),
    ibuy: (id) => { const it = findItem(id), b = !it.bought; const p = { bought: b }; if (b && !has(it.spent) && has(it.est_price)) p.spent = it.est_price; return patchItem(id, p); },
    iwrap: (id) => patchItem(id, { wrapped: !findItem(id).wrapped }),
    idel: async (id) => { const it = findItem(id); if (!(await confirmDel('« ' + it.name + ' »'))) return; try { await api.deleteItem(it); await refresh(true); } catch (e) { fail(e); } },
    imove: async (id) => {
      const it = findItem(id), l = itemList(it), toWish = l.kind === 'gifts_for';
      const t = await pickTargetList(toWish ? 'Dans quelle liste ?' : 'Pour qui ?', (x) => x.id !== l.id && canEdit(x) && (toWish ? true : x.kind === 'gifts_for'), 'L’idée sera déplacée (photo et notes partagées comprises ; ta note perso reste sur l’original).');
      if (!t) return; try { await moveItem(it, t); await refresh(true); toast('✅ Déplacé.'); } catch (e) { fail(e); }
    },
    vdel: async (id) => { try { await api.deleteIdea(id); await refresh(true); } catch (e) { fail(e); } },
    vwish: async (id) => {
      const v = D.inbox.find((x) => x.id === id); if (!v) return;
      try {
        let ws = D.lists.filter((l) => l.kind === 'wishes' && l.role === 'owner'), target;
        if (!ws.length) target = (await api.createList({ title: 'Mes envies', emoji: '🎀', kind: 'wishes' })).id;
        else if (ws.length === 1) target = ws[0].id; else target = await pickTargetList('Dans quelle liste d’envies ?', (l) => l.kind === 'wishes' && l.role === 'owner');
        if (!target) return;
        await api.createItem(target, { name: clean(v.text), est_price: price(v.text), priority: 'like', category: 'other', status: 'idea' });
        await api.deleteIdea(id); await refresh(true); toast('✅ Rangée dans tes envies.');
      } catch (e) { fail(e); }
    },
    vgive: async (id) => {
      const v = D.inbox.find((x) => x.id === id); if (!v) return;
      const t = await pickTargetList('Pour qui ?', (l) => l.kind === 'gifts_for' && canEdit(l)); if (!t) return;
      try { await api.createItem(t, { name: clean(v.text), est_price: price(v.text) }); await api.deleteIdea(id); await refresh(true); toast('✅ Ajoutée au carnet.'); } catch (e) { fail(e); }
    },
    cexport: () => downloadJSON('noel2026-mes-listes-' + stamp() + '.json', cloudSnapshot(), 'Export'),
    ccopy: () => copyFallback(JSON.stringify(cloudSnapshot(), null, 2)),
    lbackup: async () => { const L = legacyData(); if (!L) return; if (await downloadJSON('noel2026-sauvegarde-' + stamp() + '.json', { app: 'liste-cadeau', version: 1, exportedAt: new Date().toISOString(), data: L })) { S.backupDone = true; render(); } },
    limport: () => runImport(),
    logout: async () => { try { await api.signOut(); } catch (e) { fail(e); } leave(); },
    pubclose: () => { clearInterval(pubPoll); S.pub = null; render(); },
    pubkeep: async () => {
      const tok = S.pub.token;
      if (!S.user) { sessionStorage.setItem('noel_join', tok); S.pub = null; S.authMode = 'in'; S.notice = 'Connecte-toi (ou crée un compte) pour garder cette liste.'; return render(); }
      try { await joinWith(tok); } catch (e) { fail(e); }
    }
  };

  document.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-close]'); if (c) { closeModal(); return; }
    const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
    const a = b.dataset.a; if (!ACT[a]) return;
    if (WRITE.has(a) && !mayWrite()) return;
    b.disabled = true;
    try { await ACT[a](b.dataset.id, b); } catch (x) { fail(x); } finally { b.disabled = false; }
  });

  document.addEventListener('submit', async (e) => {
    const id = e.target.id; if (!['qa', 'authform', 'resetform', 'recform', 'nameform', 'pwform'].includes(id)) return;
    e.preventDefault();
    const fd = new FormData(e.target), err = $('#aerr');
    try {
      if (id === 'qa') { const q = String(fd.get('q') || '').trim(); if (!q || !mayWrite()) return; await api.addIdea(q); e.target.reset(); await refresh(true); if (S.tab === 'home') ACT.tab('vrac'); }
      else if (id === 'nameform') { await api.setName(D.me.id, fd.get('name')); await refresh(true); toast('✅ Prénom enregistré.'); }
      else if (id === 'pwform') { const p = String(fd.get('pw') || ''); if (p.length < 8) return toast('8 caractères minimum.'); await api.setPassword(p); e.target.reset(); toast('✅ Mot de passe changé.'); }
      else {
        const email = String(fd.get('email') || '').trim().toLowerCase(); if (err) err.textContent = '';
        const btn = e.target.querySelector('button.pri'); if (btn) btn.disabled = true;
        try {
          if (id === 'resetform') { await api.resetPassword(email); S.authMode = 'in'; S.notice = 'Si cette adresse a un compte, un e-mail vient de partir avec un lien pour choisir un nouveau mot de passe.'; render(); }
          else if (id === 'recform') { const p = String(fd.get('pw') || ''); if (p.length < 8) { err.textContent = '8 caractères minimum.'; return; } await api.setPassword(p); S.recovery = false; toast('✅ Mot de passe changé.'); const s = await api.getSession(); if (s) await enter(s.user); else render(); }
          else if (e.target.dataset.mode === 'up') {
            const pw = String(fd.get('password') || ''); if (pw.length < 8) { err.textContent = 'Mot de passe : 8 caractères minimum.'; return; }
            const r = await api.signUp(email, pw, fd.get('name'));
            if (r.session) await enter(r.session.user); else { S.authMode = 'in'; S.notice = 'Compte créé. Vérifie ta boîte mail : clique sur le lien de confirmation, puis connecte-toi ici.'; render(); }
          } else { const r = await api.signIn(email, String(fd.get('password') || '')); await enter(r.session.user); }
        } finally { if (btn) btn.disabled = false; }
      }
    } catch (x) { if (err) err.textContent = api.friendly(x); else fail(x); }
  });

  // ------------------------------------------------------------------ démarrage
  async function boot(client) {
    sb = client; api = root.V2API.makeApi(sb, root.CFG);
    const days = Math.max(0, Math.ceil((new Date(2026, 11, 25) - new Date()) / 864e5));
    $('#cd').textContent = days ? 'J-' + days + ' ✨' : 'C’est Noël ! 🎅';
    sb.auth.onAuthStateChange((ev, session) => {
      setTimeout(async () => {
        try {
          if (ev === 'INITIAL_SESSION' && !session) { S.loading = false; render(); }
          else if (ev === 'PASSWORD_RECOVERY') { S.recovery = true; S.loading = false; render(); }
          else if (ev === 'SIGNED_OUT' && S.user) leave();
          else if ((ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION') && session && !S.recovery) await enter(session.user);
        } catch (e) { fail(e); }
      }, 0);
    });
    const hr = parseHash();
    render(); setTimeout(() => { if (S.loading && !S.user) { S.loading = false; render(); } }, 5000);
    if (hr) setTimeout(route, 400);
    root.addEventListener('hashchange', () => { if (parseHash()) route(); });
  }

  root.V2 = { boot, S, render, _test: { get D() { return D; }, set D(v) { D = v; }, ACT, legacyData, runImport, viewHome, itemCard, esc } };
})(typeof window !== 'undefined' ? window : globalThis);
