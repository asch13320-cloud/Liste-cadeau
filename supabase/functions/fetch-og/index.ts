// Edge Function « fetch-og » (verify_jwt = true : réservée aux utilisateurs connectés).
//  - { url }    → titre / image / description / prix (si la page les déclare)
//  - { image }  → télécharge l'image d'un produit (≤ 3,5 Mo) pour l'enregistrer comme VRAIE photo
//                 (évite les images bloquées par les sites marchands).
// Sécurité : URL validée, adresses privées refusées (y compris après redirection), délai court, taille limitée.
import { isPrivateIp, parseMetadata, validateUrl } from './og.js';

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
