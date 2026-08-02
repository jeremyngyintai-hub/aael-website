// AAEL — 網頁變動監察（同業 + 屋宇署新聞公報）
//
// v2 變更：由單一網站（bhueasy.hk）改成「目標清單」通用監察器。
//   而家監察緊：
//     1. bhueasy.hk — 同業競爭對手
//     2. 屋宇署新聞公報（當前年份頁）— 有新公報就會觸發通知，
//        簡樸房規管期間，官方新公告 = 你嘅文章選題同客戶通知素材
//   日後想加目標，喺 TARGETS 加一行就得，唔使新開 function。
//
// ⚠️ 技術限制（同 v1 一樣）：呢個做法係「攞成頁面文字內容，計一個 hash 值，
//    同上次記錄比對」——簡單直接，但都有缺陷：
//      · 網頁入面如果有時間戳、隨機排序等會不斷變化嘅小部分，
//        會令個 hash 唔同，造成「假警報」（其實冇實質內容更新）。
//      · 唔會話你知「邊度變咗」，你需要自己開返個網站睇。
//    屋宇署新聞公報頁係一個新聞列表，有新公報先會變，誤報機會相對低。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/competitor-check.yml），
//            每朝 10:30 一次。
//
// 環境變數（全部已有，唔使新加）：
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（儲存上次嘅 hash）
//   DISCORD_COMPETITOR_WEBHOOK_URL / DISCORD_ALERTS_WEBHOOK_URL / DISCORD_WEBHOOK_URL
//   COMPETITOR_CHECK_SECRET

import crypto from 'node:crypto';
import { notifyDiscord } from '../lib/discord-notify.mjs';

function hkYear() {
  // 香港時間（UTC+8）嘅年份——屋宇署新聞公報係按年份分頁
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 4);
}

// 監察目標清單。hashKey 一經使用就唔好改名，否則會當成「第一次見」而靜默重置。
// bhueasy 沿用 v1 嘅舊 key，確保升級呢一刻唔會產生假警報。
const TARGETS = [
  {
    id: 'bhueasy',
    name: 'bhueasy.hk（同業）',
    emoji: '👀',
    url: 'https://bhueasy.hk',
    hashKey: 'aael:competitor:bhueasy:hash',
  },
  {
    id: 'bd-press',
    name: `屋宇署新聞公報（${hkYear()}年）`,
    emoji: '📰',
    url: `https://www.bd.gov.hk/tc/whats-new/press-releases/${hkYear()}/index.html`,
    hashKey: `aael:watch:bd-press-${hkYear()}:hash`, // 逐年一個 key，跨年自動換新頁
  },
];

function extractText(html) {
  // 粗略去除 script/style/HTML tag，只留文字內容嚟計 hash，
  // 減少因為 HTML 結構微調（但文字冇變）而誤報
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function checkTarget(target, upstashUrl, headers) {
  let html;
  try {
    const r = await fetch(target.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AAELMonitor/1.0)' },
    });
    if (!r.ok) return { id: target.id, ok: false, error: `HTTP ${r.status}` };
    html = await r.text();
  } catch (err) {
    return { id: target.id, ok: false, error: String(err) };
  }

  const text = extractText(html);
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

  const prevRes = await fetch(`${upstashUrl}/get/${target.hashKey}`, { headers });
  const prevData = await prevRes.json();
  const prevHash = prevData.result;
  const changed = !!(prevHash && prevHash !== hash);

  if (changed) {
    await notifyDiscord({
      title: `${target.emoji} ${target.name} 內容可能有更新`,
      color: target.id === 'bd-press' ? 0xce8f5a : 0x3498db,
      description: `偵測到內容變動（有機會係假警報，詳見程式碼註解）。\n[開啟頁面](${target.url})`,
      webhookUrl:
        process.env.DISCORD_COMPETITOR_WEBHOOK_URL ||
        process.env.DISCORD_ALERTS_WEBHOOK_URL ||
        process.env.DISCORD_WEBHOOK_URL,
    });
  }

  // 記低今次嘅 hash，等下次比對
  await fetch(`${upstashUrl}/set/${target.hashKey}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'text/plain' },
    body: hash,
  });

  return { id: target.id, ok: true, changed, hash };
}

export default async function handler(req, res) {
  const secret = process.env.COMPETITOR_CHECK_SECRET;
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

  // 逐個 check：一個目標失敗唔應該影響其他目標
  const results = [];
  for (const target of TARGETS) {
    results.push(await checkTarget(target, url, headers));
  }

  res.status(200).json({ ok: true, results });
}
