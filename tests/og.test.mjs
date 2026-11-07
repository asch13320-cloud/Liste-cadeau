import { isPrivateIp, validateUrl, parseMetadata, parsePrice } from '../supabase/functions/fetch-og/og.js';
let ok = 0, ko = 0; const t = (n, c) => { c ? ok++ : ko++; console.log((c ? '✓ ' : '✗ ') + n); };
for (const ip of ['127.0.0.1','10.0.0.5','172.16.0.1','172.31.255.1','192.168.1.1','169.254.169.254','0.0.0.0','100.64.0.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1','::ffff:7f00:1','999.1.1.1','224.0.0.1'])
  t('IP privée refusée : ' + ip, isPrivateIp(ip) === true);
for (const ip of ['8.8.8.8','93.184.216.34','2606:4700:4700::1111','172.32.0.1']) t('IP publique acceptée : ' + ip, isPrivateIp(ip) === false);
for (const u of ['ftp://x.fr','file:///etc/passwd','javascript:alert(1)','http://localhost/x','http://intranet/x','http://x.local/','http://user:pw@x.fr/','http://x.fr:8080/','http://127.0.0.1/','http://[::1]/','http://169.254.169.254/latest/meta-data','http://2130706433/','http://0x7f000001/','pas une url'])
  t('URL refusée : ' + u, validateUrl(u).ok === false);
t('URL https valide acceptée', validateUrl('https://www.exemple.fr/produit?id=1').ok === true);

const html1 = `<html><head><title>Ignoré &amp; co</title>
<meta property="og:title" content="Lampe &quot;Soleil&quot; &amp; abat-jour">
<meta property="og:description" content="Une   lampe
douce">
<meta property="og:image" content="/img/lampe.jpg">
<meta property="product:price:amount" content="29,90"><meta property="product:price:currency" content="EUR"></head></html>`;
const m1 = parseMetadata(html1, 'https://boutique.fr/p/1');
t('OG : titre décodé', m1.title === 'Lampe "Soleil" & abat-jour');
t('OG : description nettoyée', m1.description === 'Une lampe douce');
t('OG : image relative → absolue', m1.image === 'https://boutique.fr/img/lampe.jpg');
t('OG : prix et devise', m1.price === 29.9 && m1.currency === 'EUR');

const html2 = `<head><title>Plaid</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Plaid doux","image":["https://cdn.x.fr/a.jpg"],"offers":{"@type":"Offer","price":"39.50","priceCurrency":"EUR"}}]}</script></head>`;
const m2 = parseMetadata(html2, 'https://x.fr');
t('JSON-LD : titre, image, prix', m2.title === 'Plaid doux' && m2.image === 'https://cdn.x.fr/a.jpg' && m2.price === 39.5 && m2.currency === 'EUR');
const m3 = parseMetadata('<head><title>Seulement un titre</title></head>', 'https://x.fr');
t('sans prix déclaré : prix = null (jamais inventé)', m3.price === null && m3.currency === null && m3.title === 'Seulement un titre' && m3.image === null);
const m4 = parseMetadata('<meta property="og:image" content="javascript:alert(1)"><meta property="og:title" content="x">', 'https://x.fr');
t('image non http(s) ignorée', m4.image === null);
t('HTML cassé / vide sans erreur', parseMetadata('<<<meta ', 'https://x.fr').title === null && parseMetadata('', 'https://x.fr').price === null);
t('parsePrice : formats', parsePrice('1 299,00 €') === 1299 && parsePrice('12.5') === 12.5 && parsePrice('gratuit') === null && parsePrice('0') === null && parsePrice(null) === null);
console.log(`\n${ok} ok, ${ko} échecs`); process.exit(ko ? 1 : 0);
