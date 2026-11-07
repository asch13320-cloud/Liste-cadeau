// Edge Function « fetch-og » : lit le titre / l'image / la description / le prix (si la page les déclare)
// d'un lien produit. Appelée depuis le navigateur avec le jeton de l'utilisateur connecté (verify_jwt = true).
// Sécurité : URL validée (pas d'adresses privées, pas de redirection vers l'interne), délai court, taille limitée.
import { isPrivateIp, parseMetadata, validateUrl } from './og.js';

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
