// AAEL — 表格提交統一處理（Email + Discord 雙推送）
//
// 用途：取代前端直接打 FormSubmit，改為打呢個 endpoint。
//       呢度會做兩件事：(a) 一樣轉發去 FormSubmit，維持你原本嘅 email 通知；
//       (b) 額外推送一則訊息去 Discord 嘅 #📝-form-submissions 頻道。
//
// ⚠️ PDPO 提示：呢個頻道會出現客戶姓名、聯絡方式、地址等個人資料，
//    務必將 #📝-form-submissions 設做內部私人頻道，唔好俾未經授權人士睇到。
//
// 環境變數（已經有，唔使新加）：
//   DISCORD_WEBHOOK_URL — 需要指向 #📝-form-submissions 呢個頻道嘅 webhook
//   （如果想同 #📊-daily-stats 用唔同頻道嘅 webhook，可以另外加一個
//    DISCORD_FORM_WEBHOOK_URL 環境變數，並將下面 notifyDiscord 嗰處
//    改為讀呢個新變數 —— 預設為咗簡單，同其他通知共用同一個 webhook）

import { notifyDiscord } from '../lib/discord-notify.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const { formType } = body;

  let formSubmitPayload, discordFields, discordTitle;

  if (formType === 'bhu-renewal') {
    const { name, contact, address, units, expiry, issuer } = body;
    if (!name || !contact || !address) {
      res.status(400).json({ error: '缺少必要欄位' });
      return;
    }
    formSubmitPayload = {
      _subject: '【認證到期提醒登記】' + address,
      _url: 'https://aael.online/',
      登記類別: '簡樸房認證到期提醒',
      '姓名／公司': name,
      聯絡方式: contact,
      樓宇地址: address,
      單位數目: units || '',
      認證屆滿日期: expiry || '',
      認證簽發方: issuer || '',
      登記時間: new Date().toLocaleString('zh-HK'),
    };
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
    formSubmitPayload = {
      _subject: 'New inquiry via aael.online',
      _url: 'https://aael.online/',
      _template: 'table',
      Name: name,
      Contact: contact,
      'Building address': address || '(not given)',
      Inquiry: message,
    };
    discordTitle = '📩 新查詢 — 網站聯絡表格';
    discordFields = [
      { name: '姓名', value: name, inline: true },
      { name: '聯絡方式', value: contact, inline: true },
    ];
    if (address) discordFields.push({ name: '樓宇地址', value: address, inline: false });
    discordFields.push({ name: '查詢內容', value: message.slice(0, 900), inline: false });
  }

  // (a) 轉發去 FormSubmit，維持原本 email 通知
  let formSubmitOk = true;
  try {
    const r = await fetch('https://formsubmit.co/ajax/aaelhk.info@gmail.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Referer: 'https://aael.online/', // FormSubmit 靠呢個識別已啟用嘅表格；伺服器對伺服器請求原本冇呢個標頭，手動加返
      },
      body: JSON.stringify(formSubmitPayload),
    });
    formSubmitOk = r.ok;
    if (!formSubmitOk) {
      const errText = await r.text().catch(() => '');
      console.error('FormSubmit 回應唔正常', r.status, errText.slice(0, 300));
    }
  } catch (err) {
    console.error('FormSubmit 轉發失敗', err);
    formSubmitOk = false;
  }

  // (b) 推送去 Discord（PDPO：務必用私人頻道）
  // 一般查詢 同 BHU續期提醒登記 分開兩個頻道，用唔同 webhook：
  const webhookUrl =
    formType === 'bhu-renewal'
      ? process.env.DISCORD_BHU_WEBHOOK_URL || process.env.DISCORD_FORM_WEBHOOK_URL
      : process.env.DISCORD_FORM_WEBHOOK_URL;

  await notifyDiscord({ title: discordTitle, color: 0x92491a, fields: discordFields, webhookUrl });

  if (!formSubmitOk) {
    // FormSubmit 失敗，但 Discord 已經收到，仍然話俾前端知有問題，等前端顯示 fallback（mailto）
    res.status(502).json({ ok: false, error: 'FormSubmit 轉發失敗，但已記錄至 Discord' });
    return;
  }

  // (c) 存落 Upstash，等 /lookup 指令可以之後搜返嚟；
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
