// AAEL — 系統健康 + SSL 憑證檢查（合併版）
//
// 用途：將原本 health-check-notify.mjs 同 ssl-check.mjs 兩個獨立 endpoint
//       合併做一個，純粹係為咗慳返一個 Vercel Serverless Function 名額
//       （Hobby Plan 最多 12 個，/api 入面每個檔案都計一個）。
//       兩個檢查嘅邏輯完全冇變，各自繼續推去唔同 Discord 頻道。
//
// ⚠️ SSL 監察範圍澄清：呢個監察緊 aael.online 個 SSL 憑證（HTTPS 加密證書）
//    幾時到期，唔係「域名註冊」到期。域名註冊到期建議直接用 Namecheap
//    自己嘅 email 提醒，會準過自建監察。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/system-check.yml）
//
// 環境變數：
//   AAEL_SITE_URL / AAEL_SITE_HOST
//   DISCORD_HEALTH_WEBHOOK_URL — 網站健康檢查推送去邊
//   DISCORD_SSL_WEBHOOK_URL — SSL 憑證檢查推送去邊
//   DISCORD_ALERTS_WEBHOOK_URL / DISCORD_WEBHOOK_URL — fallback
//   HEALTH_CHECK_SECRET — 沿用返呢一個做防亂 call（唔使新加 secret）

import tls from 'node:tls';
import { notifyDiscord } from '../lib/discord-notify.mjs';

const SSL_WARN_DAYS = 14;

/* ---------- 網站健康檢查 ---------- */
async function checkHealth(siteUrl) {
  try {
    const r = await fetch(`${siteUrl}/api/health`);
    const data = await r.json();
    const ok = r.ok && data?.結果 === '設定完整，可以開始測試';
    return { ok, notes: data?.notes?.join('\n') || '' };
  } catch (err) {
    return { ok: false, notes: String(err) };
  }
}

/* ---------- SSL 憑證檢查 ---------- */
function getCertExpiry(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) {
        reject(new Error('攞唔到憑證資料'));
        return;
      }
      resolve(new Date(cert.valid_to));
    });
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('連線逾時'));
    });
  });
}

export default async function handler(req, res) {
  const secret = process.env.HEALTH_CHECK_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(401).json({ error: '密碼不正確' });
    return;
  }

  const siteUrl = process.env.AAEL_SITE_URL || 'https://aael.online';
  const host = process.env.AAEL_SITE_HOST || 'aael.online';
  const results = {};

  // (a) 網站健康檢查——出事先出聲
  const health = await checkHealth(siteUrl);
  results.health = health.ok;
  if (!health.ok) {
    await notifyDiscord({
      title: '🚨 網站健康檢查異常',
      color: 0xe74c3c,
      description: `\`${siteUrl}/api/health\` 回報唔正常，請盡快檢查。`,
      fields: [{ name: '詳情', value: (health.notes || '未知錯誤').slice(0, 900), inline: false }],
      webhookUrl:
        process.env.DISCORD_HEALTH_WEBHOOK_URL ||
        process.env.DISCORD_ALERTS_WEBHOOK_URL ||
        process.env.DISCORD_WEBHOOK_URL,
    });
  }

  // (b) SSL 憑證檢查——出事先出聲
  try {
    const expiry = await getCertExpiry(host);
    const daysLeft = Math.round((expiry.getTime() - Date.now()) / 86400000);
    results.sslDaysLeft = daysLeft;
    if (daysLeft <= SSL_WARN_DAYS) {
      await notifyDiscord({
        title: '🚨 SSL 憑證即將到期',
        color: 0xe74c3c,
        description: `\`${host}\` 嘅 SSL 憑證仲有 **${daysLeft} 日**到期（${expiry.toISOString().slice(0, 10)}）。\n正常情況 Vercel 會自動續期，但建議手動登入 Vercel Dashboard 確認一下。`,
        webhookUrl:
          process.env.DISCORD_SSL_WEBHOOK_URL ||
          process.env.DISCORD_ALERTS_WEBHOOK_URL ||
          process.env.DISCORD_WEBHOOK_URL,
      });
    }
  } catch (err) {
    results.sslError = String(err.message || err);
    await notifyDiscord({
      title: '🚨 SSL 憑證檢查失敗',
      color: 0xe74c3c,
      description: `連接 \`${host}\` 失敗：${String(err.message || err)}`,
      webhookUrl:
        process.env.DISCORD_SSL_WEBHOOK_URL ||
        process.env.DISCORD_ALERTS_WEBHOOK_URL ||
        process.env.DISCORD_WEBHOOK_URL,
    });
  }

  res.status(200).json({ ok: true, ...results });
}
