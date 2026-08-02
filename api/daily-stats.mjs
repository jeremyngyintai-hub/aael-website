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

import { notifyDiscord } from '../lib/discord-notify.mjs';

function todayKey() {
  // 香港時間（UTC+8），同 chat.mjs／track-pageview.mjs 保持一致。
  // 額外減 45 分鐘：GitHub Actions 排程經常延遲幾分鐘至半個鐘，如果 23:59 嘅
  // 排程拖到過咗香港午夜先執行，唔減呢 45 分鐘就會讀咗「新嘅一日」（全部係零），
  // 成日嘅摘要就白白走失。減咗之後，00:00–00:44 之間先執行都仲係總結緊啱啱完嗰日。
  return new Date(Date.now() + 8 * 3600 * 1000 - 45 * 60000).toISOString().slice(0, 10);
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

async function readList(url, token, key) {
  if (!url || !token) return [];
  try {
    const r = await fetch(`${url}/lrange/${key}/0/-1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    return (data.result || []).map((q) => decodeURIComponent(q));
  } catch {
    return [];
  }
}

function pastDates(n) {
  // 過去 n 日嘅香港日期字串（唔包括今日）
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(new Date(Date.now() + 8 * 3600 * 1000 - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

async function checkAnomaly(url, token, todayCount) {
  if (!url || !token || todayCount === null) return null;
  const dates = pastDates(7);
  const counts = await Promise.all(dates.map((d) => readCount(url, token, `aael:pageviews:${d}`)));
  const valid = counts.filter((c) => c !== null && c > 0);
  if (valid.length < 3) return null; // 數據太少，唔夠判斷
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  if (avg > 0 && todayCount > avg * 3 && todayCount - avg > 20) {
    return { avg: Math.round(avg), today: todayCount };
  }
  return null;
}
async function readTopPages(url, token, key, limit = 5) {
  if (!url || !token) return [];
  try {
    const r = await fetch(`${url}/zrevrange/${key}/0/${limit - 1}/withscores`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    const flat = data.result || []; // [page1, score1, page2, score2, ...]
    const pages = [];
    for (let i = 0; i < flat.length; i += 2) {
      pages.push({ page: decodeURIComponent(flat[i]), count: parseInt(flat[i + 1], 10) });
    }
    return pages;
  } catch {
    return [];
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
  const topPages = await readTopPages(url, token, `aael:pageviews:top:${date}`);
  const zeroHits = await readList(url, token, `aael:zerohit:${date}`);
  const anomaly = await checkAnomaly(url, token, pageviews);

  const fields = [
    {
      name: '📄 網頁瀏覽量（全站）',
      value: pageviews === null ? '未能讀取' : `${pageviews} 次${anomaly ? ' ⚠️' : ''}`,
      inline: true,
    },
    {
      name: '🤖 AI Pro 查詢次數',
      value: chatUsage === null ? '未能讀取（可能今日未有人用過）' : `${chatUsage} 次`,
      inline: true,
    },
  ];

  if (topPages.length) {
    const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
    const lines = topPages.map((p, i) => `${medals[i] || i + 1 + '.'} ${p.page || '首頁'} — ${p.count} 次`);
    fields.push({ name: '🔥 今日熱門頁面', value: lines.join('\n'), inline: false });
  }

  if (anomaly) {
    fields.push({
      name: '⚠️ 異常流量',
      value: `今日 ${anomaly.today} 次，遠高於過去 7 日平均（${anomaly.avg} 次）——建議留意是否爬蟲或異常流量。`,
      inline: false,
    });
  }

  if (zeroHits.length) {
    const sample = zeroHits.slice(-8); // 最多顯示 8 條，避免訊息過長
    fields.push({
      name: `❓ AI Pro 搵唔到相關文章嘅問題（共 ${zeroHits.length} 條）`,
      value: sample.map((q) => `• ${q}`).join('\n').slice(0, 1000),
      inline: false,
    });
  }

  await notifyDiscord({
    title: `📊 AAEL 網站每日摘要 — ${date}`,
    color: 0xce8f5a,
    fields,
    // 用專屬 #📊-daily-stats 頻道嘅 webhook；未設定嘅話 fallback 用返共用嗰個
    webhookUrl: process.env.DISCORD_STATS_WEBHOOK_URL,
  });

  res.status(200).json({ ok: true, date, pageviews, chatUsage });
}
