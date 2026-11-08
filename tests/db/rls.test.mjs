// Tests des migrations Supabase sur un Postgres local (PGlite) : droits, invitations, migration.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..', '..');
const db = new PGlite();
await db.exec(fs.readFileSync(path.join(dir, 'supabase-stub.sql'), 'utf8'));
for (const f of fs.readdirSync(path.join(root, 'supabase', 'migrations')).sort())
  await db.exec(fs.readFileSync(path.join(root, 'supabase', 'migrations', f), 'utf8'));

let ok = 0, ko = 0;
const t = (n, c) => { c ? ok++ : ko++; console.log((c ? '✓ ' : '✗ ') + n); };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = { A: id(1), B: id(2), C: id(3), D: id(4), E: id(5), F: id(6), G: id(7), H: id(8) };
const EMAIL = { F: 'f@x.fr', G: 'g@x.fr' };
for (const [k, v] of Object.entries(U)) await db.query('insert into auth.users (id,email) values ($1,$2)', [v, EMAIL[k] || k.toLowerCase() + '@x.fr']);

const q = (s, p) => db.query(s, p).then((r) => r.rows);
const as = async (u, fn) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${U[u]}',false); select set_config('request.jwt.claims','{"sub":"${U[u]}","email":"${EMAIL[u] || u.toLowerCase() + '@x.fr'}"}',false)`);
  try { return await fn(); } finally { await db.exec("reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false)"); }
};
const anon = async (fn) => { await db.exec('set role anon'); try { return await fn(); } finally { await db.exec('reset role'); } };
const err = async (p) => { try { await p; return null; } catch (e) { return e.message || String(e); } };
const link = async (u, list, role, ttl = 24, max = 1, email = null, anonFlag = false) =>
  (await as(u, () => q('select create_invite_link($1,$2,$3,$4,$5,$6) r', [list, role, ttl, max, email, anonFlag])))[0].r.token;

// --- profils
t('profil créé automatiquement', (await q('select count(*)::int n from profiles'))[0].n === 8);

// --- liste de A
const L = (await as('A', () => q("insert into lists (owner_id,title) values ($1,'Noël de Maman') returning id", [U.A])))[0].id;
t('le créateur devient propriétaire', (await q('select role from list_members where list_id=$1', [L]))[0].role === 'owner');
const I1 = (await as('A', () => q("insert into items (list_id,name,est_price,notes) values ($1,'Écharpe',25,'beige') returning id", [L])))[0].id;
t('étranger : ne voit ni la liste ni les cadeaux', await as('D', async () => (await q('select 1 from lists')).length === 0 && (await q('select 1 from items')).length === 0));
t('étranger : ne peut pas ajouter de cadeau', !!(await as('D', () => err(q("insert into items (list_id,name) values ($1,'x')", [L])))));
t('propriétaire ne peut pas usurper created_by', !!(await as('A', () => err(q("insert into items (list_id,name,created_by) values ($1,'x',$2)", [L, U.B])))));

// --- collaborateur
const tokC = await link('A', L, 'collaborator', 24, 1);
t('jeton jamais stocké en clair', (await q('select count(*)::int n from invite_links where token_hash=$1', [tokC]))[0].n === 0);
t('collaborateur : redeem OK', (await as('B', () => q('select redeem_invite($1) r', [tokC])))[0].r.role === 'collaborator');
t('lien à usage unique : 2e personne refusée', /invalid_or_expired_invite/.test(await as('D', () => err(q('select redeem_invite($1)', [tokC])))));
t('collaborateur : voit les cadeaux', await as('B', async () => (await q('select 1 from items')).length === 1));
const I2 = (await as('B', () => q("insert into items (list_id,name) values ($1,'Gants') returning id", [L])))[0].id;
t('collaborateur : ajoute, modifie et supprime', await as('B', async () => {
  const u = await q("update items set name='Gants chauds', bought=true, wrapped=true, spent=12 where id=$1 returning id", [I2]);
  const u2 = await q("update items set est_price=30 where id=$1 returning id", [I1]);
  const d = await q('delete from items where id=$1 returning id', [I2]);
  return u.length === 1 && u2.length === 1 && d.length === 1; }));
t('collaborateur : ne modifie pas la liste', await as('B', async () => (await q("update lists set title='piraté' where id=$1 returning id", [L])).length === 0));
t('collaborateur : ne supprime pas la liste', await as('B', async () => (await q('delete from lists where id=$1 returning id', [L])).length === 0));
t('collaborateur : ne crée pas d’invitation', /forbidden/.test(await as('B', () => err(q("select create_invite_link($1,'reader')", [L])))));
t('collaborateur : ne voit pas les invitations', await as('B', async () => (await q('select 1 from invite_links')).length === 0));
t('collaborateur : voit les membres et leurs profils', await as('B', async () => (await q('select 1 from list_members where list_id=$1', [L])).length === 2 && (await q('select 1 from profiles')).length === 2));
t('collaborateur : insertion directe de membre interdite', !!(await as('B', () => err(q("insert into list_members values ($1,$2,'owner')", [L, U.B])))));
t('collaborateur : ne s’auto-promeut pas', await as('B', async () => (await q("update list_members set role='owner' where user_id=$1 returning 1", [U.B])).length === 0));

// --- lecteur
const tokR = await link('A', L, 'reader', 24, 5);
t('lecteur : redeem OK', (await as('C', () => q('select redeem_invite($1) r', [tokR])))[0].r.role === 'reader');
t('lecteur : consulte', await as('C', async () => (await q('select 1 from items')).length === 1));
t('lecteur : ne peut PAS ajouter', !!(await as('C', () => err(q("insert into items (list_id,name) values ($1,'x')", [L])))));
t('lecteur : ne peut PAS modifier', await as('C', async () => (await q("update items set name='hack' where id=$1 returning id", [I1])).length === 0));
t('lecteur : ne peut PAS supprimer', await as('C', async () => (await q('delete from items where id=$1 returning id', [I1])).length === 0));
t('lecteur : modifications bien absentes', (await q('select name from items where id=$1', [I1]))[0].name === 'Écharpe');
t('lecteur : ne voit que sa propre ligne de membre', await as('C', async () => (await q('select 1 from list_members')).length === 1));
t('lecteur : voit le profil du propriétaire mais pas celui des autres membres', await as('C', async () => { const r = await q('select id from profiles'); return r.length === 2 && r.some((x) => x.id === U.A) && !r.some((x) => x.id === U.B); }));
t('lecteur : ne s’auto-promeut pas', await as('C', async () => (await q("update list_members set role='owner' where user_id=$1 returning 1", [U.C])).length === 0));
t('lecteur : pas d’insertion de membre', !!(await as('C', () => err(q("insert into list_members values ($1,$2,'collaborator')", [L, U.C])))));
t('lien reader ne rétrograde pas un collaborateur', (await as('B', () => q('select redeem_invite($1) r', [tokR])))[0].r.role === 'collaborator');

// --- invitations : expiration, révocation, e-mail
const tokX = await link('A', L, 'reader', 24, 5);
await as('A', () => q("update invite_links set expires_at = now() - interval '1 minute' where token_hash=encode(sha256(convert_to($1,'utf8')),'hex')", [tokX]));
t('lien expiré refusé', /invalid_or_expired_invite/.test(await as('D', () => err(q('select redeem_invite($1)', [tokX])))));
const tokV = await link('A', L, 'reader', 24, 5);
await as('A', () => q("update invite_links set revoked_at = now() where token_hash=encode(sha256(convert_to($1,'utf8')),'hex')", [tokV]));
t('lien révoqué refusé', /invalid_or_expired_invite/.test(await as('D', () => err(q('select redeem_invite($1)', [tokV])))));
t('jeton inconnu refusé', /invalid_or_expired_invite/.test(await as('D', () => err(q("select redeem_invite('nimporte')")))));
const tokE = await link('A', L, 'collaborator', 24, 1, 'F@X.fr');
t('lien lié à un e-mail : mauvais compte refusé', /invalid_or_expired_invite/.test(await as('G', () => err(q('select redeem_invite($1)', [tokE])))));
t('lien lié à un e-mail : bon compte accepté', (await as('F', () => q('select redeem_invite($1) r', [tokE])))[0].r.role === 'collaborator');
t('durée invalide refusée', /invalid_ttl/.test(await as('A', () => err(q("select create_invite_link($1,'reader',0)", [L])))));
t('rôle owner non invitable', /invalid_role/.test(await as('A', () => err(q("select create_invite_link($1,'owner')", [L])))));
t('non connecté : redeem refusé', !!(await anon(() => err(q('select redeem_invite($1)', [tokR])))));
t('non connecté : création de lien refusée', !!(await anon(() => err(q("select create_invite_link($1,'reader')", [L])))));

// --- notes privées
await as('A', () => q("insert into item_private_notes (item_id,notes) values ($1,'Elle déteste le beige')", [I1]));
t('notes privées : invisibles pour un collaborateur', await as('B', async () => (await q('select 1 from item_private_notes')).length === 0));
t('notes privées : invisibles pour un lecteur', await as('C', async () => (await q('select 1 from item_private_notes')).length === 0));
t('notes privées : pas d’écriture au nom d’un autre', !!(await as('B', () => err(q("insert into item_private_notes (item_id,user_id,notes) values ($1,$2,'x')", [I1, U.A])))));
t('notes privées : un étranger ne peut pas en créer', !!(await as('D', () => err(q("insert into item_private_notes (item_id,notes) values ($1,'x')", [I1])))));
t('notes privées : chacun les siennes', await as('B', async () => { await q("insert into item_private_notes (item_id,notes) values ($1,'note de B')", [I1]); return (await q('select notes from item_private_notes')).length === 1; }));
t('notes privées : propriétaire ne voit pas celles de B', await as('A', async () => (await q('select notes from item_private_notes')).every((r) => r.notes !== 'note de B')));

// --- conflits et intégrité
const v0 = (await q('select version from items where id=$1', [I1]))[0].version;
await as('B', () => q("update items set name='Écharpe en laine' where id=$1", [I1]));
t('conflit détecté (version périmée)', await as('A', async () => (await q("update items set name='autre' where id=$1 and version=$2 returning id", [I1, v0])).length === 0));
t('version incrémentée', (await q('select version from items where id=$1', [I1]))[0].version === v0 + 1);
t('list_id immuable', !!(await as('A', () => err(q('update items set list_id=gen_random_uuid() where id=$1', [I1])))));
t('owner_id immuable', !!(await as('A', () => err(q('update lists set owner_id=$2 where id=$1', [L, U.B])))));
t('données invalides refusées (prix négatif, lien javascript:)', !!(await as('A', () => err(q("insert into items (list_id,name,est_price) values ($1,'x',-1)", [L])))) && !!(await as('A', () => err(q("insert into items (list_id,name,link) values ($1,'x','javascript:alert(1)')", [L])))));

// --- photos (Storage)
const P = `${L}/${I1}/photo.jpg`;
await q("insert into storage.objects (bucket_id,name) values ('gift-photos',$1)", [P]);
t('photos : lecteur voit', await as('C', async () => (await q("select 1 from storage.objects where bucket_id='gift-photos'")).length === 1));
t('photos : étranger ne voit pas', await as('D', async () => (await q("select 1 from storage.objects where bucket_id='gift-photos'")).length === 0));
t('photos : lecteur ne peut pas envoyer', !!(await as('C', () => err(q("insert into storage.objects (bucket_id,name) values ('gift-photos',$1)", [`${L}/${I1}/x.jpg`])))));
t('photos : collaborateur peut envoyer', !(await as('B', () => err(q("insert into storage.objects (bucket_id,name) values ('gift-photos',$1)", [`${L}/${I1}/y.jpg`])))));
t('photos : chemin hors format refusé sans planter', !!(await as('B', () => err(q("insert into storage.objects (bucket_id,name) values ('gift-photos','abc/def.jpg')")))));
t('photos : lecteur ne supprime pas', await as('C', async () => (await q('delete from storage.objects where name=$1 returning 1', [P])).length === 0));
t('bucket privé, 3 Mo, images seulement', JSON.stringify((await q("select public,file_size_limit,allowed_mime_types from storage.buckets where id='gift-photos'"))[0]) === JSON.stringify({ public: false, file_size_limit: 3145728, allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'] }));

// --- lien public sans compte (lecture seule)
const W = (await as('A', () => q("insert into lists (owner_id,title) values ($1,'Mes envies') returning id", [U.A])))[0].id;
const W1 = (await as('A', () => q("insert into items (list_id,name,est_price,notes,bought,spent) values ($1,'Lampe',30,'bleue',true,28) returning id", [W])))[0].id;
await as('A', () => q("insert into item_private_notes (item_id,notes) values ($1,'secret perso')", [W1]));
const tokP = await link('A', W, 'reader', 48, 1, null, true);
const view = (await anon(() => q('select public_list_view($1) v', [tokP])))[0].v;
t('vue publique : contenu visible', view && view.items.length === 1 && view.items[0].name === 'Lampe' && view.list.title === 'Mes envies');
t('vue publique : aucune note privée, dépense ou statut d’achat', !JSON.stringify(view).includes('secret perso') && !('spent' in view.items[0]) && !('bought' in view.items[0]) && !('created_by' in view.items[0]));
t('vue publique : jeton inconnu → rien', (await anon(() => q("select public_list_view('x') v")))[0].v === null);
t('vue publique : lien non public → rien', (await anon(() => q('select public_list_view($1) v', [tokR])))[0].v === null);
t('lien public sur liste de cadeaux refusé', /anonymous_link_not_allowed/.test(await as('A', async () => { const g = (await q("insert into lists (owner_id,title,kind) values ($1,'Pour Papa','gifts_for') returning id", [U.A]))[0].id; return err(q("select create_invite_link($1,'reader',24,1,null,true)", [g])); })));
t('anonyme : aucun accès direct aux tables', !!(await anon(() => err(q('select * from items')))) && !!(await anon(() => err(q('select * from lists')))));
await as('A', () => q("update invite_links set revoked_at=now() where token_hash=encode(sha256(convert_to($1,'utf8')),'hex')", [tokP]));
t('vue publique : lien révoqué → rien', (await anon(() => q('select public_list_view($1) v', [tokP])))[0].v === null);

// --- suppression de membres
t('propriétaire ne peut pas être retiré', await as('A', async () => (await q("delete from list_members where user_id=$1 and list_id=$2 returning 1", [U.A, L])).length === 0));
t('collaborateur ne peut pas retirer le propriétaire', await as('B', async () => (await q("delete from list_members where user_id=$1 and list_id=$2 returning 1", [U.A, L])).length === 0));
t('propriétaire retire un lecteur', await as('A', async () => (await q("delete from list_members where user_id=$1 and list_id=$2 returning 1", [U.C, L])).length === 1));
t('ex-lecteur : plus d’accès', await as('C', async () => (await q('select 1 from items')).length === 0));
t('un membre peut quitter la liste', await as('B', async () => (await q("delete from list_members where user_id=$1 and list_id=$2 returning 1", [U.B, L])).length === 1));

// --- migration depuis l’ancienne version
const legacy = {
  wishes: [
    { id: 'w1', name: 'Lampe', price: '30', prio: "J'adorerais", cat: 'Maison', status: 'Envie', fav: true, link: 'https://x.fr/p', notes: 'beige', photo: 'data:image/jpeg;base64,AAAA' },
    { id: 'w2', name: 'Sérum', price: '12,5', prio: "J'aime bien", cat: 'Beauté', status: 'Idée', fav: false, link: 'javascript:alert(1)', notes: '' },
    { id: 'w3', name: 'Bizarre', price: 'abc', prio: 'Pourquoi pas', cat: 'Inconnue', status: 'Reçu', fav: false },
  ],
  people: [
    { id: 'p1', name: 'Maman', emoji: '🎀', budget: '100', gifts: [
      { id: 'g1', name: 'Écharpe', price: '25', spent: '22', bought: true, wrapped: false, notes: 'secret', link: '' },
      { id: 'g2', name: 'Gants', price: 15, spent: '', bought: false, wrapped: true, photo: 'data:image/jpeg;base64,BBBB', prio: "J'aime bien", cat: 'Vêtements' },
      { id: 'g2', name: 'Doublon même id', price: 1 } ] },
    { id: 'p2', name: 'Frère', emoji: '🎮', budget: '', gifts: [] },
  ],
  inbox: [{ id: 'i1', t: 'Plaid — 40 €' }, { id: 'i2', t: 'Bougie' }],
};
const r1 = (await as('H', () => q('select import_legacy($1::jsonb) r', [JSON.stringify(legacy)])))[0].r;
t('import : 3 listes (envies + 2 personnes)', r1.lists_created === 3);
t('import : 6 cadeaux (3 envies + 3 gifts valides… doublon ignoré)', r1.items_created === 5 && r1.skipped_existing === 1);
t('import : 2 idées en vrac', r1.inbox_created === 2);
const rows = await as('H', () => q("select i.*, l.title ltitle, l.kind from items i join lists l on l.id=i.list_id order by i.legacy_key"));
const by = (k) => rows.find((r) => r.legacy_key === k);
t('import : envie complète conservée', by('w:w1').name === 'Lampe' && +by('w:w1').est_price === 30 && by('w:w1').priority === 'love' && by('w:w1').category === 'home' && by('w:w1').status === 'wish' && by('w:w1').favorite === true && by('w:w1').notes === 'beige' && by('w:w1').link === 'https://x.fr/p');
t('import : prix « 12,5 » → 12.5', +by('w:w2').est_price === 12.5);
t('import : lien dangereux supprimé, valeurs inconnues neutres', by('w:w2').link === null && by('w:w3').est_price === null && by('w:w3').category === 'other');
t('import : cadeau pour une personne (prix, dépensé, acheté, notes)', +by('g:g1').est_price === 25 && +by('g:g1').spent === 22 && by('g:g1').bought === true && by('g:g1').notes === 'secret' && by('g:g1').ltitle === 'Maman' && by('g:g1').kind === 'gifts_for');
t('import : champs d’une conversion V1 conservés (emballé, priorité, catégorie)', by('g:g2').wrapped === true && by('g:g2').priority === 'like' && by('g:g2').category === 'clothes');
t('import : budget de la personne conservé', +(await as('H', () => q("select budget from lists where legacy_key='p:p1'")))[0].budget === 100);
t('import : photos signalées pour envoi', r1.items.filter((m) => m.has_photo).length === 2 && r1.items.every((m) => m.item_id && m.list_id));
await as('H', () => q("update items set name='Lampe modifiée', est_price=99 where legacy_key='w:w1'"));
const r2 = (await as('H', () => q('select import_legacy($1::jsonb) r', [JSON.stringify(legacy)])))[0].r;
t('relance : aucun doublon', r2.lists_created === 0 && r2.items_created === 0 && r2.inbox_created === 0);
t('relance : même nombre de lignes', (await as('H', () => q('select 1 from items'))).length === 5 && (await as('H', () => q('select 1 from lists'))).length === 3 && (await as('H', () => q('select 1 from inbox_items'))).length === 2);
t('relance : modifications faites depuis conservées', (await as('H', () => q("select name,est_price from items where legacy_key='w:w1'")))[0].name === 'Lampe modifiée');
t('relance : ids renvoyés identiques (photos réattachables)', r2.items.every((m) => r1.items.find((x) => x.legacy === m.legacy && x.item_id === m.item_id)));
t('import : invisible pour les autres', await as('A', async () => (await q("select 1 from lists where legacy_key is not null")).length === 0));
t('import : refuse un payload invalide', !!(await as('H', () => err(q("select import_legacy('[]'::jsonb)")))));
t('import : refusé hors connexion', !!(await anon(() => err(q("select import_legacy('{}'::jsonb)")))));
t('import : payload vide accepté', (await as('G', () => q("select import_legacy('{}'::jsonb) r")))[0].r.items_created === 0);


// --- import tolérant + erreurs détaillées (migration 4)
const imp = (u, payload) => as(u, () => q('select import_legacy($1::jsonb) r', [JSON.stringify(payload)]));
const rA = (await imp('H', { wishes: [{ id: 'z1', name: 'Booléens bizarres', fav: '', price: 25, prio: 'J’adorerais' }, null, 'texte', { name: 'Sans id' }], people: [{ id: 'pz', name: 'lili', emoji: 'lili', gifts: 'pas un tableau' }, { name: 'Sans id non plus', gifts: [{ name: 'g sans id', bought: 'on', wrapped: null }] }], inbox: [{ t: 'idée sans id' }, 5] }))[0].r;
t('import tolérant : booléen vide, null, texte, id manquant, gifts invalide → pas d’erreur', rA.items_created === 3 && rA.lists_created >= 1);
const same = { wishes: [{ id: 'z1', name: 'Booléens bizarres', fav: '', price: 25, prio: 'J’adorerais' }, null, 'texte', { name: 'Sans id' }], people: [{ id: 'pz', name: 'lili', emoji: 'lili', gifts: 'pas un tableau' }, { name: 'Sans id non plus', gifts: [{ name: 'g sans id', bought: 'on', wrapped: null }] }], inbox: [{ t: 'idée sans id' }, 5] };
const rB = (await imp('H', same))[0].r;
t('import tolérant : relance sans doublon, même sans id (clé par position)', rB.items_created === 0 && rB.lists_created === 0 && rB.inbox_created === 0);
t('import tolérant : « lili » comme nom ou emoji est un simple texte', (await as('H', () => q("select 1 from lists where title='lili'"))).length === 1);
await q("alter table items add constraint t_fail check (name <> 'Cadeau piège') not valid");
const e3 = await as('H', async () => { try { await q('select import_legacy($1::jsonb)', [JSON.stringify({ wishes: [], people: [{ id: 'p10', name: 'Carnet X', gifts: [{ id: 'g10', name: 'Cadeau piège' }] }], inbox: [] })]); return null; } catch (e) { return e; } });
await q('alter table items drop constraint t_fail');
if (!e3 || !/Cadeau piège/.test(e3.detail || '')) console.log('DEBUG e3:', e3 && { m: e3.message, d: e3.detail, h: e3.hint, c: e3.code });
t('erreur d’import : message d’origine conservé', e3 && /violates check constraint/.test(e3.message));
t('erreur d’import : indique le cadeau et le carnet fautifs', e3 && /Cadeau piège/.test(e3.detail || '') && /Carnet X/.test(e3.detail || ''));
t('erreur d’import : indique la ligne de la fonction', e3 && /import_legacy/.test(e3.hint || ''));
t('erreur d’import : code d’erreur d’origine conservé (23514)', e3 && e3.code === '23514');
t('erreur d’import : rien n’a été importé à moitié (transaction annulée)', (await as('H', () => q("select 1 from lists where legacy_key='p:p10'"))).length === 0);

// --- suppression en cascade
await as('A', () => q('delete from lists where id=$1', [L]));
t('suppression de liste : cadeaux, membres, invitations supprimés', (await q('select 1 from items where list_id=$1', [L])).length + (await q('select 1 from list_members where list_id=$1', [L])).length + (await q('select 1 from invite_links where list_id=$1', [L])).length === 0);

console.log(`\n${ok} ok, ${ko} échecs`);
process.exit(ko ? 1 : 0);
