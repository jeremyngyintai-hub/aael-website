// AAEL — 法定死線自動廣播
// 用途：簡樸房規管有幾個關鍵日子（登記期完結、寬限期完結等），
//       喺呢啲日子臨近時自動推送提示去 Discord，等你提早部署營銷內容
//       或者提醒團隊跟進。
//
// 日子嚟源：同網站首頁、guide-bhu-timeline.html 等文章一致嘅官方公布日期。
//           如果政府後續更新日期，記得同時更新呢度同網站內文。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/deadline-broadcast.yml），
//            建議每日一次。
//
// 環境變數：
//   DISCORD_WEBHOOK_URL（或者 DISCORD_ALERTS_WEBHOOK_URL）
//   DEADLINE_BROADCAST_SECRET

import { notifyDiscord } from './discord-notify.mjs';

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

export default async function handler(req, res) {
  const secret = process.env.DEADLINE_BROADCAST_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(401).json({ error: '密碼不正確' });
    return;
  }

  const due = DEADLINES.map((d) => ({ ...d, days: daysUntil(d.date) })).filter((d) =>
    THRESHOLDS.includes(d.days)
  );

  for (const d of due) {
    await notifyDiscord({
      title: `📢 法定死線提醒 — 仲有 ${d.days} 日`,
      color: d.days <= 7 ? 0xe74c3c : d.days <= 30 ? 0xf39c12 : 0xce8f5a,
      description: `**${d.label}**\n日期：${d.date}\n\n可考慮提早部署相關營銷內容或者提醒團隊跟進。`,
      webhookUrl:
        process.env.DISCORD_DEADLINE_WEBHOOK_URL ||
        process.env.DISCORD_ALERTS_WEBHOOK_URL ||
        process.env.DISCORD_WEBHOOK_URL,
    });
  }

  res.status(200).json({ ok: true, checked: DEADLINES.length, broadcast: due.length });
}
