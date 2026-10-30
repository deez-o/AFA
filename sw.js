/* FraserFlow service worker: lets FraserFlow be installed as an app and open without reception.
   - FraserFlow's own files: always fetched fresh when online (so updates arrive straight away), kept for offline
   - libraries and fonts from CDNs (fixed versions): kept after the first load
   - data (Supabase) and /api: never touched, always live */
const CACHE='fraserflow-v6';
const SHELL=['/','/manifest.json','/icons/icon-192.png','/icons/icon-512.png','/icons/apple-touch-icon.png','/icons/favicon-32.png'];
const CDN=/^https:\/\/(cdn\.tailwindcss\.com|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});

self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    if(url.pathname.startsWith('/api/'))return;
    /* network first; the saved copy only when offline. Pages are kept without their ?query (e.g. /?app=1) */
    const key=req.mode==='navigate'?url.pathname:req;
    e.respondWith(fetch(req).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(key,copy))}return res})
      .catch(()=>caches.match(key,{ignoreSearch:req.mode==='navigate'}).then(r=>r||caches.match(req,{ignoreSearch:true})).then(r=>r||Response.error())));
    return;
  }
  if(CDN.test(req.url)){
    e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(res=>{if(res.ok||res.type==='opaque'){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy))}return res})));
  }
});
