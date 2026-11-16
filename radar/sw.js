const CACHE='econradar-v16',SHELL=['../shared/motion.css?v=1','../shared/motion.mjs?v=1','./','./index.html','./style.css?v=13','./app.mjs?v=16','./core.mjs?v=8','./graph.mjs?v=1','./vendor/d3.min.js','./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png','./config.json'];
// The paper files change twice a week: always try the network first, fall back to the last copy offline.
const FRESH=/\/(data\/(?:newsletter\/)?[^/]+\.json|config\.json|focus\.json)$/;
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil((async()=>{await Promise.all((await caches.keys()).filter(k=>(k.startsWith('econradar-')||k.startsWith('literature-radar-'))&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim();})()));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin)return;
 if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).then(r=>{if(r.ok)e.waitUntil(caches.open(CACHE).then(c=>c.put('./index.html',r.clone())));return r;}).catch(()=>caches.match('./index.html')));return;}
 if(FRESH.test(u.pathname)){e.respondWith(fetch(e.request,{cache:'no-cache'}).then(r=>{if(r.ok)e.waitUntil(caches.open(CACHE).then(c=>c.put(e.request,r.clone())));return r;}).catch(()=>caches.match(e.request,{ignoreSearch:true})));return;}
 e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{if(r.ok)e.waitUntil(caches.open(CACHE).then(c=>c.put(e.request,r.clone())));return r;})));});
