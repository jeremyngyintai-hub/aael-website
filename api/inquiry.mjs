// AAEL — 表格提交 → Discord 通知 + 記錄
//
// ⚠️ 架構變更說明：呢個 endpoint 原本仲會轉發去 FormSubmit，但發現
//    FormSubmit.co 有 Cloudflare 防機械人保護，會擋伺服器對伺服器嘅請求
//    （回 403 "Just a moment..." 驗證頁面）。呢類保護唔應該亦唔可靠去
//    用偽裝標頭迴避，所以改返做：瀏覽器繼續直接打 FormSubmit（同以前
//    一樣，證實冇問題），呢個 endpoint 淨係負責 (a) 推送去 Discord、
//    (b) 存落 Upstash 俾 /lookup 同 BHU 到期提醒排程用。
//
// ⚠️ PDPO 提示：Discord 頻道會出現客戶姓名、聯絡方式、地址等個人資料，
//    務必將相關頻道設做內部私人頻道，唔好俾未經授權人士睇到。
//
// 環境變數（已經有，唔使新加）：
//   DISCORD_FORM_WEBHOOK_URL / DISCORD_BHU_WEBHOOK_URL

import { notifyDiscord } from '../lib/discord-notify.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const { formType } = body;

  let discordFields, discordTitle;

  if (formType === 'bhu-renewal') {
    const { name, contact, address, units, expiry, issuer } = body;
    if (!name || !contact || !address) {
      res.status(400).json({ error: '缺少必要欄位' });
      return;
    }
    discordTitle = '🔔 新的認證到期提醒登記';
    discordFields = [
      { name: '姓名／公司', value: name, inline: true },
      { name: '聯絡方式', value: contact, inline: true },
      { name: '樓宇地址', value: address, inline: false },
    ];
    if (units) discordFields.push({ name: '單位數目', value: units, inline: true });
    if (expiry) discordFields.push({ name: '認證屆滿日期', value: expiry, inline: true });
    if (issuer) discordFields.push({ name: '認證簽發方', value: issuer, inline: true });
  } else {
    // 預設：一般查詢表格
    const { name, contact, address, message } = body;
    if (!name || !contact || !message) {
      res.status(400).json({ error: '缺少必要欄位' });
      return;
    }
    discordTitle = '📩 新查詢 — 網站聯絡表格';
    discordFields = [
      { name: '姓名', value: name, inline: true },
      { name: '聯絡方式', value: contact, inline: true },
    ];
    if (address) discordFields.push({ name: '樓宇地址', value: address, inline: false });
    discordFields.push({ name: '查詢內容', value: message.slice(0, 900), inline: false });
  }

  // (a) 推送去 Discord（PDPO：務必用私人頻道）
  const webhookUrl =
    formType === 'bhu-renewal'
      ? process.env.DISCORD_BHU_WEBHOOK_URL || process.env.DISCORD_FORM_WEBHOOK_URL
      : process.env.DISCORD_FORM_WEBHOOK_URL;

  await notifyDiscord({ title: discordTitle, color: 0x92491a, fields: discordFields, webhookUrl });

  // (b) 存落 Upstash，等 /lookup 指令可以之後搜返嚟；
  //     BHU 續期記錄仲會俾 bhu-reminders.mjs 排程用嚟自動提醒到期。
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (upstashUrl && upstashToken) {
    try {
      const headers = { Authorization: `Bearer ${upstashToken}` };
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prefix = formType === 'bhu-renewal' ? 'bhu' : 'inquiry';
      const record = JSON.stringify(
        formType === 'bhu-renewal'
          ? {
              type: 'bhu-renewal',
              name: body.name,
              contact: body.contact,
              address: body.address,
              units: body.units || '',
              expiry: body.expiry || '',
              issuer: body.issuer || '',
              registeredAt: new Date().toISOString(),
            }
          : {
              type: 'inquiry',
              name: body.name,
              contact: body.contact,
              address: body.address || '',
              message: body.message,
              registeredAt: new Date().toISOString(),
            }
      );
      await fetch(`${upstashUrl}/set/aael:${prefix}:${id}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'text/plain' },
        body: record,
      });
      await fetch(`${upstashUrl}/sadd/aael:${prefix}:index/${id}`, { headers });
    } catch (err) {
      console.error('表格記錄儲存失敗', err);
      // 靜默失敗：儲存唔到都唔應該影響用戶提交表格嘅結果
    }
  }

  res.status(200).json({ ok: true });
}
