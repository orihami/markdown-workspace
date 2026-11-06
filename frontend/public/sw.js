// オフラインでも画面を開けるようにする(仕様 6.5・8)。
// /api/ は通さない(保存は画面の保存係が IndexedDB を使って扱う。ここで覚えた古い内容を出さないため)
const CACHE = 'mw-shell-v2'

// 入れるときに、画面(/)と、その画面が読む部品(/assets/…)をまとめて覚える(最初に開いたすぐあとでも、つながらずに開けるように)
async function precache() {
  const c = await caches.open(CACHE)
  await c.addAll(['/manifest.webmanifest', '/icon.svg', '/icon-192.png'])
  const res = await fetch('/', { cache: 'no-store' })
  if (!res.ok) return
  const html = await res.clone().text()
  await c.put('/', res)
  const assets = [...new Set(html.match(/\/assets\/[^"'\s>]+/g) || [])]
  await c.addAll(assets)
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/assets/')) {
    // 名前に版が入っているので、一度取ったものはそのまま使う
    e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)) }
      return res
    })))
    return
  }
  if (req.mode === 'navigate') {
    // 画面はまずサーバーから(新しい版を出す)。届かなければ覚えておいた画面
    e.respondWith(withTimeout(fetch(req), 4000).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)) }
      return res
    }).catch(() => caches.match('/', { ignoreVary: true })))
    return
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)) }
    return res
  }).catch(() => caches.match(req, { ignoreVary: true })))
})
