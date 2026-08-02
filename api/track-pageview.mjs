// AAEL — 每日網頁瀏覽量計數（含熱門文章排行）
// 用途：喺網頁載入嗰陣被一個輕量 beacon 叫用，喺 Upstash Redis 度：
//   (a) 將今日嘅總瀏覽次數 +1（同之前一樣）
//   (b) 將今日「呢一頁」嘅瀏覽次數 +1，記落一個排序集（sorted set），
//       等 daily-stats.mjs 可以攞到「今日最多人睇邊幾篇」。
//
// 環境變數（已經有，唔使新加）：
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

function todayKey() {
  // 香港時間（UTC+8），同 chat.mjs／daily-stats.mjs 保持一致
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function sanitizePage(raw) {
  if (!raw) return 'unknown';
  // 淨係保留字母、數字、連字號、底線、斜線、點——避免奇怪輸入寫壞 Redis key
  const clean = String(raw).replace(/[^a-zA-Z0-9\-_/.]/g, '').slice(0, 80);
  return clean || 'unknown';
}

export default async function handler(req, res) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const page = sanitizePage(req.query.page);
  const date = todayKey();

  if (url && token) {
    try {
      const headers = { Authorization: `Bearer ${token}` };

      // (a) 總瀏覽量 +1
      const totalKey = `aael:pageviews:${date}`;
      const r1 = await fetch(`${url}/incr/${totalKey}`, { headers });
      const d1 = await r1.json();
      if (d1.result === 1) {
        await fetch(`${url}/expire/${totalKey}/777600`, { headers }).catch(() => {});
      }

      // (b) 呢一頁今日嘅次數 +1（排序集，等日後可以攞 top N）
      const topKey = `aael:pageviews:top:${date}`;
      await fetch(`${url}/zincrby/${topKey}/1/${encodeURIComponent(page)}`, { headers }).catch(() => {});
      await fetch(`${url}/expire/${topKey}/777600`, { headers }).catch(() => {});
    } catch (err) {
      console.error('track-pageview 出錯', err);
      // 靜默失敗，唔好因為計數失敗而影響用戶睇網頁
    }
  }

  // 回一張 1x1 透明 GIF
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64'));
}

