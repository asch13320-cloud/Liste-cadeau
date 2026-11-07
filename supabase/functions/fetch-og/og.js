// Fonctions pures (testables sous Node et Deno) : validation d'URL anti-SSRF et lecture des métadonnées.

export function isPrivateIp(ip) {
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

export function validateUrl(raw) {
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

export function parsePrice(v) {
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
export function parseMetadata(html, baseUrl) {
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
