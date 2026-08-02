// AAEL — 靜默式系統健康檢查
// 用途：定時（例如每 6 小時）check 一次網站嘅 /api/health。
//       平時完全冇聲氣，一旦偵測到問題（API key 失效、伺服器出錯等）
//       先推送警報去 Discord——唔想成日收到「一切正常」嘅騷擾式通知。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/health-check.yml）
//
// 環境變數：
//   AAEL_SITE_URL — 預設 https://aael.online
//   DISCORD_WEBHOOK_URL — 出事先推送去邊個頻道（可以指定
//     DISCORD_ALERTS_WEBHOOK_URL 分去獨立嘅警報頻道，未設定就 fallback
//     用返共用嗰個）
//   HEALTH_CHECK_SECRET — 防止亂 call

import { notifyDiscord } from './discord-notify.mjs';

export default async function handler(req, res) {
  const secret = process.env.HEALTH_CHECK_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(401).json({ error: '密碼不正確' });
    return;
  }

  const siteUrl = process.env.AAEL_SITE_URL || 'https://aael.online';
  const webhookUrl =
    process.env.DISCORD_HEALTH_WEBHOOK_URL ||
    process.env.DISCORD_ALERTS_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL;

  let healthData, healthOk, fetchError;
  try {
    const r = await fetch(`${siteUrl}/api/health`);
    healthData = await r.json();
    // health.mjs 本身有一個「結果」欄位：'設定完整，可以開始測試' 代表一切正常
    healthOk = r.ok && healthData?.結果 === '設定完整，可以開始測試';
  } catch (err) {
    fetchError = String(err);
    healthOk = false;
  }

  if (healthOk) {
    // 一切正常：靜默返，唔發任何 Discord 訊息
    res.status(200).json({ ok: true, alerted: false });
    return;
  }

  // 出事：推送警報
  const notes = healthData?.notes?.join('\n') || fetchError || '未知錯誤';
  await notifyDiscord({
    title: '🚨 網站健康檢查異常',
    color: 0xe74c3c,
    description: `\`${siteUrl}/api/health\` 回報唔正常，請盡快檢查。`,
    fields: [{ name: '詳情', value: notes.slice(0, 900), inline: false }],
    webhookUrl,
  });

  res.status(200).json({ ok: true, alerted: true, notes });
}
