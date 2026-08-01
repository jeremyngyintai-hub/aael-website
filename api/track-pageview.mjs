// AAEL — 每日網頁瀏覽量計數
// 用途：喺網頁載入嗰陣被一個輕量 beacon 叫用，喺 Upstash Redis 度將今日嘅
//       瀏覽次數 +1。同 chat.mjs 用緊嘅同一個 Upstash 戶口，唔使新開。
//
// 環境變數（已經有，唔使新加）：
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

function todayKey() {
  // 香港時間（UTC+8）嘅日期，同 chat.mjs 用返一致嘅計算方式，
  // 確保兩個計數器都喺香港夜晚12點一齊截數，唔會錯開。
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  // 用 GET 方便前端用 <img> 或者 fetch(no-cors) 打，唔使處理 CORS preflight
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    try {
      const key = `aael:pageviews:${todayKey()}`;
      const r = await fetch(`${url}/incr/${key}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      if (data.result === 1) {
        // 首次建立呢個 key，設定 48 小時後過期，避免 key 無限累積
        await fetch(`${url}/expire/${key}/172800`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    } catch (err) {
      console.error('track-pageview 出錯', err);
      // 靜默失敗，唔好因為計數失敗而影響用戶睇網頁
    }
  }

  // 回一張 1x1 透明 GIF，等前端可以用 <img> 方式呼叫（唔會被廣告攔截器當做 tracking pixel 咁易擋）
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64'));
}
