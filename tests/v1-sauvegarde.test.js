const {JSDOM}=require('jsdom');const fs=require('fs');
const html=fs.readFileSync(__dirname+'/../index.html','utf8').replace(/<link[^>]*fonts[^>]*>/g,'');
const seed={wishes:[{id:'w1',name:'Lampe',price:'30',prio:"J'adorerais",cat:'Maison',status:'Envie',fav:true,photo:'data:image/jpeg;base64,AAAA',link:'https://x.fr',notes:'beige'}],
 people:[{id:'p1',name:'Maman',emoji:'🎀',budget:'100',gifts:[{id:'g1',name:'Écharpe',price:'25',spent:'22',bought:true,wrapped:false,notes:'secret',link:''}]}],inbox:[{id:'i1',t:'Plaid — 40 €'}]};
function boot(ls,opts={}){
 return new JSDOM(html,{runScripts:'dangerously',url:'https://x.github.io/Liste-cadeau/index.html',pretendToBeVisual:true,
  beforeParse(w){w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
   for(const[k,v]of Object.entries(ls))w.localStorage.setItem(k,v);
   if(opts.full){const o=w.Storage.prototype.setItem;w.Storage.prototype.setItem=function(k,v){if(k==='noel2026')throw new Error('quota');return o.call(this,k,v)}}}});
}
let ok=0,ko=0;const t=(n,c)=>{c?ok++:ko++;console.log((c?'✓':'✗')+' '+n)};
// 1. chargement normal + home sans div orpheline
let d=boot({noel2026:JSON.stringify(seed)}),w=d.window,doc=w.document;
t('accueil rendu',doc.querySelector('#app .stats'));
t('6 stats dans .stats',doc.querySelectorAll('.stats > .stat').length===6);
t('bloc sauvegarde présent',/Ma sauvegarde/.test(doc.body.textContent));
// 2. snapshot complet
const snap=w.eval('snapshot()');
t('export contient tout',snap.data.wishes[0].photo&&snap.data.people[0].gifts[0].spent==='22'&&snap.data.inbox.length===1&&snap.version===1);
// 3. conversions sans perte (envie -> cadeau -> envie)
w.eval("A.wgive('w1')"); // ouvre le choix de personne
doc.querySelector('[data-i="0"]').click();
let g=w.eval('S.people[0].gifts.find(g=>g.name==="Lampe")');
t('envie→cadeau garde photo/prio/cat/fav',g&&g.photo&&g.prio==="J'adorerais"&&g.cat==='Maison'&&g.fav===true);
w.eval(`A.gwish('${g.id}')`);
let wi=w.eval('S.wishes.find(x=>x.name==="Lampe")');
t('cadeau→envie restaure tout',wi&&wi.photo&&wi.prio==="J'adorerais"&&wi.cat==='Maison'&&wi.fav===true&&wi.status==='Envie');
// 4. gbuy ne perd plus le prix dépensé
w.eval("A.gbuy('g1')");let a=w.eval("S.people[0].gifts[0]");t('décocher vide spent (totaux inchangés)',a.bought===false&&a.spent===''&&a.spentPrev==='22');
w.eval("A.gbuy('g1')");a=w.eval("S.people[0].gifts[0]");t('recocher restaure 22',a.bought===true&&a.spent==='22'&&!('spentPrev' in a));
// 5. import : validations
t('rejette JSON invalide',w.eval("parseBackup('pas du json')")===null);
t('rejette structure fausse',w.eval('parseBackup(JSON.stringify({wishes:1}))')===null);
t('accepte l’export',w.eval('parseBackup(JSON.stringify(snapshot()))')!==null);
t('accepte l’ancien format brut',w.eval('parseBackup(JSON.stringify(S))')!==null);
// 6. restauration + copie de sécurité
const before=JSON.stringify(w.eval('S'));
w.eval("restoreData({wishes:[],people:[],inbox:[]})");
t('copie avant restauration conservée',w.localStorage.getItem('noel2026_avant_restauration')===before);
t('données remplacées',w.eval('S.wishes.length===0'));
// 7. JSON corrompu : jamais écrasé en silence
d=boot({noel2026:'{corrompu'});w=d.window;
t('donnée illisible mise de côté',Object.keys(w.localStorage).some(k=>k.startsWith('noel2026_corrompu_'))&&w.localStorage.getItem('noel2026')==='{corrompu');
// 8. ancien format partiel (sans inbox)
d=boot({noel2026:JSON.stringify({wishes:[],people:[{id:'p',name:'X',emoji:'a'}]})});w=d.window;
t('ancien format partiel ne plante pas',w.document.querySelector('#app .stats')&&w.eval('S.inbox.length===0&&S.people[0].gifts.length===0'));
// 9. quota plein : message visible
d=boot({noel2026:JSON.stringify(seed)},{full:true});w=d.window;
t('save() retourne false',w.eval('save()')===false);t('toast d’alerte affiché',w.document.querySelector('#toast.on')&&/pleine/.test(w.document.querySelector('#toast').textContent));
console.log(`\n${ok} ok, ${ko} échecs`);process.exit(ko?1:0);
