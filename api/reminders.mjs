// AAEL — 法定死線廣播 + BHU 續期提醒（合併版）
//
// 用途：將原本 deadline-broadcast.mjs 同 bhu-reminders.mjs 兩個獨立
//       endpoint 合併做一個，純粹為咗慳返一個 Vercel Serverless Function
//       名額（Hobby Plan 最多 12 個）。兩個檢查邏輯完全冇變，
//       各自繼續推去唔同 Discord 頻道。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/reminders.yml）
//
// 環境變數：
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   DISCORD_DEADLINE_WEBHOOK_URL — 法定死線廣播推送去邊
//   DISCORD_BHU_REMINDERS_WEBHOOK_URL — BHU到期提醒推送去邊
//   DISCORD_WEBHOOK_URL / DISCORD_BHU_WEBHOOK_URL — fallback
//   BHU_REMINDERS_SECRET — 沿用返呢一個做防亂 call（唔使新加 secret）

import { notifyDiscord } from '../lib/discord-notify.mjs';

const THRESHOLDS = [90, 30, 7];

const DEADLINES = [
  { date: '2027-02-28', label: '簡樸房寬限期登記截止' },
  { date: '2030-02-28', label: '簡樸房 36 個月寬限期結束（此後出租須持有效認證）' },
];

function hkTodayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysUntil(dateStr) {
  const todayMs = Date.parse(hkTodayStr() + 'T00:00:00Z');
  const targetMs = Date.parse(dateStr + 'T00:00:00Z');
  return Math.round((targetMs - todayMs) / 86400000);
}

/* ---------- (a) 法定死線廣播 ---------- */
async function checkDeadlines() {
  const due = DEADLINES.map((d) => ({ ...d, days: daysUntil(d.date) })).filter((d) =>
    THRESHOLDS.includes(d.days)
  );
  for (const d of due) {
    await notifyDiscord({
      title: `📢 法定死線提醒 — 仲有 ${d.days} 日`,
      color: d.days <= 7 ? 0xe74c3c : d.days <= 30 ? 0xf39c12 : 0xce8f5a,
      description: `**${d.label}**\n日期：${d.date}\n\n可考慮提早部署相關營銷內容或者提醒團隊跟進。`,
      webhookUrl: process.env.DISCORD_DEADLINE_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL,
    });
  }
  return due.length;
}

/* ---------- (b) BHU 續期提醒 ---------- */
async function checkBhuReminders(url, token) {
  if (!url || !token) return { checked: 0, reminded: 0 };
  const headers = { Authorization: `Bearer ${token}` };

  const idsRes = await fetch(`${url}/smembers/aael:bhu:index`, { headers });
  const idsData = await idsRes.json();
  const ids = idsData.result || [];

  let checked = 0;
  let reminded = 0;

  for (const id of ids) {
    checked++;
    try {
      const r = await fetch(`${url}/get/aael:bhu:${id}`, { headers });
      const data = await r.json();
      if (!data.result) continue;
      const record = JSON.parse(data.result);
      if (!record.expiry) continue;

      const days = daysUntil(record.expiry);
      if (THRESHOLDS.includes(days)) {
        await notifyDiscord({
          title: `⏰ 認證即將到期 — 仲有 ${days} 日`,
          color: days <= 7 ? 0xe74c3c : days <= 30 ? 0xf39c12 : 0xce8f5a,
          fields: [
            { name: '姓名／公司', value: record.name, inline: true },
            { name: '聯絡方式', value: record.contact, inline: true },
            { name: '樓宇地址', value: record.address, inline: false },
            { name: '認證屆滿日期', value: record.expiry, inline: true },
            { name: '認證簽發方', value: record.issuer || '（未填）', inline: true },
          ],
          webhookUrl: process.env.DISCORD_BHU_REMINDERS_WEBHOOK_URL || process.env.DISCORD_BHU_WEBHOOK_URL,
        });
        reminded++;
      }
    } catch (err) {
      console.error(`讀取記錄 ${id} 失敗`, err);
    }
  }
  return { checked, reminded };
}

export default async function handler(req, res) {
  const secret = process.env.BHU_REMINDERS_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(401).json({ error: '密碼不正確' });
    return;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  const deadlinesBroadcast = await checkDeadlines();
  const bhu = await checkBhuReminders(url, token);

  res.status(200).json({ ok: true, deadlinesBroadcast, bhu });
}
