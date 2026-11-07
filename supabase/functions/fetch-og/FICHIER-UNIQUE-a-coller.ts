// Fonction « fetch-og » en UN SEUL fichier (à coller dans Supabase > Edge Functions > Via Editor).
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

// Edge Function « fetch-og » : lit le titre / l'image / la description / le prix (si la page les déclare)
// d'un lien produit. Appelée depuis le navigateur avec le jeton de l'utilisateur connecté (verify_jwt = true).
// Sécurité : URL validée (pas d'adresses privées, pas de redirection vers l'interne), délai court, taille limitée.

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://asch13320-cloud.github.io').split(',').map((s) => s.trim());
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

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

async function hostIsPublic(host: string): Promise<boolean> {
  if (/^[\d.]+$/.test(host) || host.includes(':')) return !isPrivateIp(host);
  const ips: string[] = [];
  for (const type of ['A', 'AAAA'] as const) {
    try { ips.push(...(await Deno.resolveDns(host, type))); } catch { /* pas d'enregistrement de ce type */ }
  }
  return ips.length > 0 && ips.every((ip) => !isPrivateIp(ip));
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value); total += value.length;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  const all = new Uint8Array(Math.min(total, MAX_BYTES)); let o = 0;
  for (const c of chunks) { const part = c.subarray(0, all.length - o); all.set(part, o); o += part.length; if (o >= all.length) break; }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);

  let target: string;
  try { target = String((await req.json()).url ?? ''); } catch { return json(req, { error: 'invalid_body' }, 400); }

  let v = validateUrl(target);
  if (!v.ok) return json(req, { error: v.reason }, 400);
  let current = v.url!;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await hostIsPublic(current.hostname.replace(/^\[|\]$/g, '')))) return json(req, { error: 'private_address' }, 400);
      const res = await fetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ListeCadeauBot/1.0)', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'fr,en;q=0.8' },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) break;
        const next = validateUrl(new URL(loc, current).href);
        if (!next.ok) return json(req, { error: 'redirect_blocked' }, 400);
        current = next.url!; continue; // chaque redirection est revalidée
      }
      if (!res.ok) return json(req, { partial: true, reason: `http_${res.status}`, title: null, image: null, description: null, price: null, currency: null });
      const type = res.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml/i.test(type)) return json(req, { partial: true, reason: 'not_html', title: null, image: null, description: null, price: null, currency: null });
      const meta = parseMetadata(await readLimited(res), current.href);
      const found = !!(meta.title || meta.image || meta.description || meta.price);
      return json(req, { ...meta, source: current.hostname, partial: !(meta.title && meta.image), reason: found ? undefined : 'no_metadata' });
    }
    return json(req, { partial: true, reason: 'too_many_redirects', title: null, image: null, description: null, price: null, currency: null });
  } catch (e) {
    // Site qui bloque, délai dépassé… : l'application propose alors la saisie manuelle.
    return json(req, { partial: true, reason: e instanceof DOMException && e.name === 'TimeoutError' ? 'timeout' : 'fetch_failed', title: null, image: null, description: null, price: null, currency: null });
  }
});
