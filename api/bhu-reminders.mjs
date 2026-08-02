// AAEL — BHU 認證到期自動提醒
// 用途：每日由排程觸發一次，讀返所有透過 #rem-form 登記嘅認證到期記錄，
//       計返每個記錄仲有幾多日到期，喺 90／30／7 日呢幾個節點自動推送
//       提醒去 Discord，等你唔使人手記住逐個客戶嘅到期日。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/bhu-reminders.yml）
//
// 環境變數（已經有，唔使新加）：
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   DISCORD_BHU_WEBHOOK_URL — 提醒推送去邊個頻道
//   BHU_REMINDERS_SECRET — 防止亂 call（自己隨便諗一串字）

import { notifyDiscord } from './discord-notify.mjs';

const THRESHOLDS = [90, 30, 7]; // 到期前幾多日提醒（可自行增減）

function hkTodayStr() {
  // 香港時間（UTC+8）嘅「今日」日期字串 YYYY-MM-DD
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysUntil(dateStr) {
  // 兩個日期都當做 UTC 午夜嘅日曆日嚟比較，避免時區/夏令時間之類嘅計算陷阱
  const todayMs = Date.parse(hkTodayStr() + 'T00:00:00Z');
  const targetMs = Date.parse(dateStr + 'T00:00:00Z');
  return Math.round((targetMs - todayMs) / 86400000);
}

export default async function handler(req, res) {
  const secret = process.env.BHU_REMINDERS_SECRET;
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
  const headers = { Authorization: `Bearer ${token}` };

  // 攞返所有已登記嘅 BHU 續期記錄 id
  const idsRes = await fetch(`${url}/smembers/aael:bhu:index`, { headers });
  const idsData = await idsRes.json();
  const ids = idsData.result || [];

  let checked = 0;
  let reminded = 0;
  const reminders = [];

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
        reminders.push({ ...record, days });
      }
    } catch (err) {
      console.error(`讀取記錄 ${id} 失敗`, err);
    }
  }

  for (const rec of reminders) {
    await notifyDiscord({
      title: `⏰ 認證即將到期 — 仲有 ${rec.days} 日`,
      color: rec.days <= 7 ? 0xe74c3c : rec.days <= 30 ? 0xf39c12 : 0xce8f5a,
      fields: [
        { name: '姓名／公司', value: rec.name, inline: true },
        { name: '聯絡方式', value: rec.contact, inline: true },
        { name: '樓宇地址', value: rec.address, inline: false },
        { name: '認證屆滿日期', value: rec.expiry, inline: true },
        { name: '認證簽發方', value: rec.issuer || '（未填）', inline: true },
      ],
      webhookUrl: process.env.DISCORD_BHU_REMINDERS_WEBHOOK_URL || process.env.DISCORD_BHU_WEBHOOK_URL,
    });
    reminded++;
  }

  res.status(200).json({ ok: true, checked, reminded });
}
