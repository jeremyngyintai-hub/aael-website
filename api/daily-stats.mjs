// AAEL — 每日統計摘要 → Discord
// 用途：讀返今日嘅網頁瀏覽量（track-pageview.mjs 計嘅）同 AI Pro 使用量
//       （chat.mjs 本身已經有嘅每日限流計數器），砌成一則摘要推送去 Discord。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/daily-stats.yml），
//            每日固定時間自動打呢個 endpoint 一次。
//
// 環境變數（已經有，唔使新加）：
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   DISCORD_WEBHOOK_URL（要指向 #📊-daily-stats 呢個頻道嘅 webhook）
//
// 安全：加咗一個簡單密碼防止其他人亂 call 呢條網址（唔係好敏感，
//       但都係好習慣）。

import { notifyDiscord } from './discord-notify.mjs';

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function readCount(url, token, key) {
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    return data.result ? parseInt(data.result, 10) : 0;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const secret = process.env.DAILY_STATS_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(401).json({ error: '密碼不正確' });
    return;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const date = todayKey();

  const pageviews = await readCount(url, token, `aael:pageviews:${date}`);
  const chatUsage = await readCount(url, token, `aael:chat:${date}`);

  const fields = [
    {
      name: '📄 網頁瀏覽量（首頁）',
      value: pageviews === null ? '未能讀取' : `${pageviews} 次`,
      inline: true,
    },
    {
      name: '🤖 AI Pro 查詢次數',
      value: chatUsage === null ? '未能讀取（可能今日未有人用過）' : `${chatUsage} 次`,
      inline: true,
    },
  ];

  await notifyDiscord({
    title: `📊 AAEL 網站每日摘要 — ${date}`,
    color: 0xce8f5a,
    fields,
  });

  res.status(200).json({ ok: true, date, pageviews, chatUsage });
}
