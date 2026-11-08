// Fonction « fetch-og » en UN SEUL fichier (à coller dans Supabase > Edge Functions > fetch-og > Code).
// Elle regroupe og.js et index.ts du dossier supabase/functions/fetch-og/.

// Fonctions pures (testables sous Node et Deno) : validation d'URL anti-SSRF et lecture des métadonnées.

function isPrivateIp(ip) {
  const s = String(ip).toLowerCase().trim();
  const v4 = s.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    if ([a, b, +v4[3], +v4[4]].some((n) => n > 255)) return true;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true;
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true; // IPv4 mappée en hexadécimal : on refuse
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith('2001:db8');
  }
  return true; // format inconnu : on refuse
}

function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: 'invalid_protocol' };
  if (u.username || u.password) return { ok: false, reason: 'credentials_not_allowed' };
  if (u.port && !['80', '443'].includes(u.port)) return { ok: false, reason: 'port_not_allowed' };
  if (String(raw).length > 2000) return { ok: false, reason: 'url_too_long' };
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
      h.endsWith('.lan') || h.endsWith('.home') || !h.includes('.') && !h.includes(':'))
    return { ok: false, reason: 'host_not_allowed' };
  if ((/^[\d.]+$/.test(h) || h.includes(':')) && isPrivateIp(h)) return { ok: false, reason: 'private_address' };
  if (/^0x[0-9a-f]+$/i.test(h) || /^\d+$/.test(h)) return { ok: false, reason: 'host_not_allowed' };
  return { ok: true, url: u };
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decode = (s) => String(s).replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENT[m])
  .replace(/&#(\d{1,6});/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
  .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } });
const clean = (s, max) => { const v = decode(s).replace(/\s+/g, ' ').trim(); return v ? v.slice(0, max) : null; };

function parsePrice(v) {
  if (v == null) return null;
  const m = String(v).replace(/\s/g, '').match(/(\d{1,6}(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function absUrl(v, base) {
  try { const u = new URL(decode(v).trim(), base); return ['http:', 'https:'].includes(u.protocol) && u.href.length <= 2000 ? u.href : null; }
  catch { return null; }
}

function jsonLdProducts(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        const t = [].concat(n['@type'] || []);
        if (t.includes('Product')) out.push(n);
        if (n['@graph']) walk(n['@graph']);
      };
      walk(JSON.parse(m[1]));
    } catch { /* JSON-LD invalide : on ignore */ }
  }
  return out;
}

// Ne renvoie que ce que la page déclare réellement. Le prix reste null s'il n'est pas fourni.
function parseMetadata(html, baseUrl) {
  const head = html.slice(0, 400000);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []);
    const content = val[1] ?? val[2];
    if (key && content != null && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = content;
  }
  const titleTag = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const prod = jsonLdProducts(head)[0];
  const offer = prod ? [].concat(prod.offers || [])[0] : null;
  const ldImage = prod ? [].concat(prod.image || [])[0] : null;
  const ldPrice = offer ? (offer.price ?? offer.lowPrice) : null;

  const title = clean(meta['og:title'] || meta['twitter:title'] || (prod && prod.name) || titleTag || '', 300);
  const description = clean(meta['og:description'] || meta['twitter:description'] || meta['description'] || (prod && prod.description) || '', 1000);
  const imgRaw = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || (typeof ldImage === 'string' ? ldImage : ldImage && ldImage.url);
  const image = imgRaw ? absUrl(imgRaw, baseUrl) : null;
  const priceRaw = meta['product:price:amount'] ?? meta['og:price:amount'] ?? meta['twitter:data1'] ?? ldPrice;
  const price = parsePrice(priceRaw);
  const currency = price == null ? null : clean(meta['product:price:currency'] || meta['og:price:currency'] || (offer && offer.priceCurrency) || '', 3);
  return { title, image, description, price, currency };
}

// Edge Function « fetch-og » (verify_jwt = true : réservée aux utilisateurs connectés).
//  - { url }    → titre / image / description / prix (si la page les déclare)
//  - { image }  → télécharge l'image d'un produit (≤ 3,5 Mo) pour l'enregistrer comme VRAIE photo
//                 (évite les images bloquées par les sites marchands).
// Sécurité : URL validée, adresses privées refusées (y compris après redirection), délai court, taille limitée.

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://asch13320-cloud.github.io').split(',').map((s) => s.trim());
const MAX_PAGE = 1_000_000;
const MAX_IMAGE = 3_500_000;
const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (compatible; ListeCadeauBot/1.0)';

function cors(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
const EMPTY = { title: null, image: null, description: null, price: null, currency: null };

async function hostIsPublic(host: string): Promise<boolean> {
  if (/^[\d.]+$/.test(host) || host.includes(':')) return !isPrivateIp(host);
  const ips: string[] = [];
  for (const type of ['A', 'AAAA'] as const) {
    try { ips.push(...(await Deno.resolveDns(host, type))); } catch { /* pas d'enregistrement de ce type */ }
  }
  return ips.length > 0 && ips.every((ip) => !isPrivateIp(ip));
}

class Blocked extends Error {
  reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}

// Télécharge en revalidant chaque redirection (anti-SSRF).
async function safeFetch(start: URL, accept: string): Promise<{ res: Response; url: URL }> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await hostIsPublic(current.hostname.replace(/^\[|\]$/g, '')))) throw new Blocked('private_address');
    const res = await fetch(current.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(7000),
      headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'fr,en;q=0.8' },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Blocked('bad_redirect');
      const next = validateUrl(new URL(loc, current).href);
      if (!next.ok) throw new Blocked('redirect_blocked');
      current = next.url!; continue;
    }
    return { res, url: current };
  }
  throw new Blocked('too_many_redirects');
}

async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared && declared > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''; const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);

  let body: { url?: string; image?: string };
  try { body = await req.json(); } catch { return json(req, { error: 'invalid_body' }, 400); }
  const wantImage = typeof body.image === 'string' && body.image.length > 0;
  const v = validateUrl(String(wantImage ? body.image : body.url ?? ''));
  if (!v.ok) return json(req, { error: v.reason }, 400);

  try {
    if (wantImage) {
      const { res } = await safeFetch(v.url!, 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8');
      if (!res.ok) return json(req, { error: `http_${res.status}` }, 502);
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) return json(req, { error: 'not_an_image' }, 415);
      const bytes = await readLimited(res, MAX_IMAGE);
      if (!bytes || !bytes.length) return json(req, { error: 'image_too_large' }, 413);
      return json(req, { contentType: type, base64: toBase64(bytes) });
    }

    const { res, url } = await safeFetch(v.url!, 'text/html,application/xhtml+xml');
    if (!res.ok) return json(req, { partial: true, reason: `http_${res.status}`, ...EMPTY });
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(type)) return json(req, { partial: true, reason: 'not_html', ...EMPTY });
    const raw = await readLimited(res, MAX_PAGE);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(raw ?? new Uint8Array());
    const meta = parseMetadata(html, url.href);
    const found = !!(meta.title || meta.image || meta.description || meta.price);
    return json(req, { ...meta, source: url.hostname, partial: !(meta.title && meta.image), reason: found ? undefined : 'no_metadata' });
  } catch (e) {
    // Site qui bloque, délai dépassé… : l'application propose alors la saisie manuelle.
    if (e instanceof Blocked) return json(req, wantImage ? { error: e.reason } : { partial: true, reason: e.reason, ...EMPTY }, wantImage ? 400 : 200);
    const reason = e instanceof DOMException && e.name === 'TimeoutError' ? 'timeout' : 'fetch_failed';
    return json(req, wantImage ? { error: reason } : { partial: true, reason, ...EMPTY }, wantImage ? 502 : 200);
  }
});
