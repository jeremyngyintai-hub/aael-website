// AAEL — 每週統計摘要 → Discord
// 用途：將過去 7 日嘅每日數據加埋一齊，睇返一週嘅總趨勢
//       （逐日摘要見 daily-stats.mjs，呢個係補充嘅週度視角）。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/weekly-stats.yml），
//            建議逢星期一朝早觸發，睇返上星期表現。
//
// 環境變數（已經有，唔使新加）：
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   DISCORD_STATS_WEBHOOK_URL
//   WEEKLY_STATS_SECRET（自己諗一串字防止亂 call）

import { notifyDiscord } from '../lib/discord-notify.mjs';

function hkDate(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * 86400000).toISOString().slice(0, 10);
}

async function readCount(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    return data.result ? parseInt(data.result, 10) : 0;
  } catch {
    return 0;
  }
}

async function readList(url, token, key) {
  try {
    const r = await fetch(`${url}/lrange/${key}/0/-1`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    return (data.result || []).map((q) => decodeURIComponent(q));
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  const secret = process.env.WEEKLY_STATS_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(401).json({ error: '密碼不正確' });
    return;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    res.status(500).json({ error: '未設定 Upstash 環境變數' });
    return;
  }

  // 過去 7 日（唔包括今日，因為今日仲未完）
  const dates = Array.from({ length: 7 }, (_, i) => hkDate(i + 1)).reverse();

  const pageviewsByDay = await Promise.all(dates.map((d) => readCount(url, token, `aael:pageviews:${d}`)));
  const chatByDay = await Promise.all(dates.map((d) => readCount(url, token, `aael:chat:${d}`)));

  const totalPageviews = pageviewsByDay.reduce((a, b) => a + b, 0);
  const totalChat = chatByDay.reduce((a, b) => a + b, 0);
  const avgPageviews = Math.round(totalPageviews / 7);
  const avgChat = Math.round(totalChat / 7);

  const dayLines = dates
    .map((d, i) => `${d.slice(5)}　📄${pageviewsByDay[i]}　🤖${chatByDay[i]}`)
    .join('\n');

  // 一週零命中問題整理：AI Pro 搵唔到相關文章嘅問題，就係你下一篇文章嘅選題依據。
  // （依賴 chat.mjs 將 aael:zerohit:{date} 嘅過期時間設做 9 日——2026-08 已修正，
  //   之前得 2 日過期，所以週報淨係見到最近兩日嘅零命中。）
  const zeroByDay = await Promise.all(dates.map((d) => readList(url, token, `aael:zerohit:${d}`)));
  const allZero = zeroByDay.flat();
  const uniqueZero = [...new Set(allZero)];

  const fields = [
    { name: '📄 總瀏覽量（7 日）', value: `${totalPageviews} 次（日均 ${avgPageviews}）`, inline: true },
    { name: '🤖 AI Pro 總查詢（7 日）', value: `${totalChat} 次（日均 ${avgChat}）`, inline: true },
    { name: '逐日明細', value: dayLines, inline: false },
  ];

  if (allZero.length) {
    const sample = uniqueZero.slice(-10); // 最多顯示 10 條，避免訊息過長
    fields.push({
      name: `📝 本週 AI Pro 搵唔到文章嘅問題（共 ${allZero.length} 條，去重後 ${uniqueZero.length} 條）→ 文章選題參考`,
      value: sample.map((q) => `• ${q}`).join('\n').slice(0, 1000),
      inline: false,
    });
  }

  await notifyDiscord({
    title: `📅 AAEL 網站每週摘要 — ${dates[0]} 至 ${dates[6]}`,
    color: 0x92491a,
    fields,
    webhookUrl: process.env.DISCORD_WEEKLY_WEBHOOK_URL || process.env.DISCORD_STATS_WEBHOOK_URL,
  });

  res.status(200).json({ ok: true, dates, totalPageviews, totalChat });
}
