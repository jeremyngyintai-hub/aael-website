// AAEL Discord 通知輔助函式
// 用途：喺任何其他 serverless function（例如表格提交）call notifyDiscord()，
//       就會將訊息推送去 Discord 頻道。唔係 slash command 部分，純粹係「推送」。
//
// 環境變數：
//   DISCORD_WEBHOOK_URL（必需）— Discord 頻道嘅 Incoming Webhook 網址
//   取得方法：Discord 頻道設定 → Integrations → Webhooks → New Webhook → Copy URL
//
// 注意（PDPO）：如果訊息入面包含客戶個人資料（姓名、電話、地址），
// 確保呢個 webhook 推送去嘅頻道係內部私人頻道，唔係公開／访客可見嘅頻道。

/**
 * 推送一個 embed 訊息去 Discord
 * @param {object} opts
 * @param {string} opts.title      - embed 標題
 * @param {string} [opts.description] - embed 內文
 * @param {Array<{name:string,value:string,inline?:boolean}>} [opts.fields] - 欄位列表
 * @param {number} [opts.color]    - embed 左邊色條，十進制顏色值（預設用 AAEL 銅色）
 * @param {string} [opts.url]      - 標題可點擊嘅連結
 */
export async function notifyDiscord({ title, description, fields = [], color = 0xce8f5a, url, webhookUrl }) {
  const webhook = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.warn('DISCORD_WEBHOOK_URL 未設定，跳過 Discord 通知');
    return { skipped: true };
  }

  const payload = {
    username: 'AAEL Bot',
    embeds: [
      {
        title,
        description,
        url,
        color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('Discord webhook 推送失敗', r.status, text);
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (err) {
    console.error('Discord webhook 推送出錯', err);
    return { ok: false, error: String(err) };
  }
}

/**
 * 快捷函式：新查詢／表格提交通知
 */
export async function notifyNewInquiry({ source, name, contact, address, message }) {
  const fields = [
    { name: '姓名 / 公司', value: name || '（未填）', inline: true },
    { name: '聯絡方式', value: contact || '（未填）', inline: true },
  ];
  if (address) fields.push({ name: '樓宇地址', value: address, inline: false });
  if (message) fields.push({ name: '查詢內容', value: message.slice(0, 900), inline: false });

  return notifyDiscord({
    title: `📩 新查詢 — ${source || '網站表格'}`,
    color: 0x92491a,
    fields,
  });
}

/**
 * 快捷函式：部署 / 系統狀態通知（可選，配合 Vercel Deploy Hook 或手動呼叫）
 */
export async function notifyDeployStatus({ status, url, commit }) {
  return notifyDiscord({
    title: status === 'success' ? '✅ 部署成功' : '⚠️ 部署異常',
    description: url ? `[查看網站](${url})` : undefined,
    color: status === 'success' ? 0x2ecc71 : 0xe74c3c,
    fields: commit ? [{ name: 'Commit', value: commit, inline: false }] : [],
  });
}
