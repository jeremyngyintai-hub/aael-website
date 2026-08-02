// AAEL — SSL 憑證到期監察
//
// ⚠️ 重要澄清：呢個監察嘅係 aael.online 個 SSL 憑證（HTTPS 加密證書）
//    幾時到期，唔係「域名註冊」（喺 Namecheap 續嗰個）幾時到期。
//    兩樣嘢完全獨立：
//      · SSL 憑證：Vercel 用 Let's Encrypt 自動簽發同續期，正常情況下
//        唔使人手理，呢個監察主要係「以防萬一自動續期失敗」嘅保險網。
//      · 域名註冊：呢個要你自己去 Namecheap 續費，唔會自動做，
//        亦冇可靠嘅免費 API 可以查詢到期日（要用 WHOIS 服務，
//        大部分收費或者有查詢次數限制），所以呢個功能暫時未包括域名
//        註冊到期監察——建議你直接喺 Namecheap 開啟佢自己嘅到期
//        email 提醒，會比自建可靠好多。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/ssl-check.yml），
//            建議每週一次已經足夠（SSL 憑證通常提前 30 日先開始續期）。
//
// 環境變數：
//   AAEL_SITE_HOST — 預設 aael.online（唔連 https://）
//   DISCORD_WEBHOOK_URL / DISCORD_ALERTS_WEBHOOK_URL
//   SSL_CHECK_SECRET

import tls from 'node:tls';
import { notifyDiscord } from './discord-notify.mjs';

const WARN_DAYS = 14; // 憑證少於呢個日數就警報

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
  const secret = process.env.SSL_CHECK_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(401).json({ error: '密碼不正確' });
    return;
  }

  const host = process.env.AAEL_SITE_HOST || 'aael.online';

  try {
    const expiry = await getCertExpiry(host);
    const daysLeft = Math.round((expiry.getTime() - Date.now()) / 86400000);

    if (daysLeft <= WARN_DAYS) {
      await notifyDiscord({
        title: '🚨 SSL 憑證即將到期',
        color: 0xe74c3c,
        description: `\`${host}\` 嘅 SSL 憑證仲有 **${daysLeft} 日**到期（${expiry.toISOString().slice(0, 10)}）。\n正常情況 Vercel 會自動續期，但建議手動登入 Vercel Dashboard 確認一下。`,
        webhookUrl: process.env.DISCORD_SSL_WEBHOOK_URL || process.env.DISCORD_ALERTS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL,
      });
      res.status(200).json({ ok: true, alerted: true, daysLeft });
      return;
    }

    // 正常：靜默返，唔發訊息
    res.status(200).json({ ok: true, alerted: false, daysLeft });
  } catch (err) {
    // 連線本身失敗都算異常，值得警報（可能網站本身已經有事）
    await notifyDiscord({
      title: '🚨 SSL 憑證檢查失敗',
      color: 0xe74c3c,
      description: `連接 \`${host}\` 失敗：${String(err.message || err)}`,
      webhookUrl: process.env.DISCORD_SSL_WEBHOOK_URL || process.env.DISCORD_ALERTS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL,
    });
    res.status(200).json({ ok: false, error: String(err.message || err) });
  }
}
