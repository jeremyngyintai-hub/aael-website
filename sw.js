// AAEL AI Pro — Service Worker
// 快取策略：
//   · HTML 頁面（首頁、知識庫文章、AI Pro）— stale-while-revalidate：
//     即時由快取回應（快、可離線），同時背景更新快取，下次造訪自動較新
//   · /api/ 底下所有請求 — 永遠唔快取，直接連網絡（AI 回應必須係即時、真實）
//   · 圖片／字型／圖示 — cache-first：呢類檔案幾乎唔會變，長期快取慳流量
//
// 版本號：每次有實質內容更新，記得改呢個字串，令舊裝置嘅 service worker
// 知道要換一批新快取，而唔係永遠沿用舊版本。
const CACHE_VERSION = 'aael-pwa-v1';
const STATIC_CACHE = CACHE_VERSION + '-static';
const PAGES_CACHE = CACHE_VERSION + '-pages';

// 安裝時預先快取嘅「App Shell」—— 令訪客第一次用完之後，即使冇網絡，
// 都可以打開已經開過或者預載嘅頁面，包括全部 33 篇知識庫文章。
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/ai-assistant.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon.png',
  "/guide-bd-codes-of-practice.html",
  "/guide-bd-order.html",
  "/guide-bhu-enforcement.html",
  "/guide-bhu-meters.html",
  "/guide-bhu-rejection.html",
  "/guide-bhu-renewal.html",
  "/guide-bhu-standards.html",
  "/guide-bhu-timeline.html",
  "/guide-buildings-ordinance.html",
  "/guide-dmc.html",
  "/guide-fsd-direction.html",
  "/guide-fsd-licensing.html",
  "/guide-handover-inspection.html",
  "/guide-hyd-hoarding-permit.html",
  "/guide-industrial.html",
  "/guide-leakage.html",
  "/guide-mbis.html",
  "/guide-minor-works.html",
  "/guide-mwis.html",
  "/guide-oc-tender.html",
  "/guide-pre-purchase.html",
  "/guide-restaurant-licence.html",
  "/guide-rooftop-ubw.html",
  "/guide-spalling.html",
  "/guide-specified-professional.html",
  "/guide-structural-wall.html",
  "/guide-subsidy.html",
  "/guide-survey-report.html",
  "/guide-swd-rche-licensing.html",
  "/guide-td-parking-tia.html",
  "/guide-ubw.html",
  "/guide-wsd-plumbing.html",
  "/guide-cisp-ordinance.html",
  "/guide-sfbc-2025.html",
  "/guide-extension-of-time.html",
  "/guide-retention-final-account.html",
  "/guide-dispute-resolution.html",
  "/guide-project-management-roles.html",
  "/certification-partners.html",
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(PAGES_CACHE).then(cache =>
      // 逐個 add，某一個失敗（例如日後刪走咗某篇文章）唔會累成個安裝失敗
      Promise.allSettled(PRECACHE_URLS.map(url => cache.add(url)))
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('aael-pwa-') && k !== STATIC_CACHE && k !== PAGES_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isStaticAsset(url) {
  return /\.(png|jpg|jpeg|webp|svg|ico|woff2?|ttf)$/i.test(url.pathname);
}

function isHtmlOrRoot(request, url) {
  return request.mode === 'navigate' || /\.html$/i.test(url.pathname) || url.pathname === '/';
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST（例如 /api/chat）一律直接放行，唔攔截
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部資源（字型 CDN 等）唔處理

  // /api/ 永遠唔快取 —— AI 回應、每日名額都必須係即時數據
  if (isApiRequest(url)) return;

  if (isStaticAsset(url)) {
    // cache-first：圖示、字型呢類靜態資源幾乎唔變
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => cached))
    );
    return;
  }

  if (isHtmlOrRoot(req, url)) {
    // stale-while-revalidate：先用快取即時顯示，背景靜靜update，
    // 令離線都睇到嘢，返嚟有網絡又自動變返最新版本
    event.respondWith(
      caches.open(PAGES_CACHE).then(async cache => {
        const cached = await cache.match(req);
        const networkFetch = fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => null);
        return cached || (await networkFetch) || new Response(
          '<h1>離線中</h1><p>暫時無法連接，請檢查網絡連線後重試。</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })
    );
  }
});
