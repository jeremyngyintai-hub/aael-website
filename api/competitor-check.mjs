// AAEL — 競爭對手（bhueasy.hk）內容變動監察
//
// ⚠️ 技術限制講明：呢個做法係「攞成頁面文字內容，計一個 hash 值，
//    同上次記錄比對」——簡單直接，但都有缺陷：
//      · 網頁入面如果有時間戳、瀏覽次數、隨機排序嘅內容等會不斷變化嘅
//        小部分，都會令個 hash 唔同，造成「假警報」（其實冇實質內容更新）。
//      · 對方如果改版／換網站結構，會直接觸發一次警報，但唔會話你知
//        「邊度變咗」，你需要自己開返兩個網站比較。
//      · 呢個唔係專業級嘅監察工具（例如 Visualping、Distill.io 呢類
//        專門做網頁監察嘅服務，會更準確、可以指定監察範圍），
//        但作為零成本、粗略嘅「有冇更新」警報已經夠用。
//    如果日後發現太多假警報，可以考慮改用專門服務，或者將呢個
//    endpoint 改為淨係監察頁面某一部分（例如只攞 <main> 標籤內容）。
//
// 由邊度觸發：GitHub Actions 排程（見 .github/workflows/competitor-check.yml），
//            建議每日一次。
//
// 環境變數：
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（儲存上次嘅 hash）
//   DISCORD_WEBHOOK_URL / DISCORD_ALERTS_WEBHOOK_URL
//   COMPETITOR_CHECK_SECRET

import crypto from 'node:crypto';
import { notifyDiscord } from './discord-notify.mjs';

const TARGET_URL = 'https://bhueasy.hk';
const HASH_KEY = 'aael:competitor:bhueasy:hash';

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

  let html;
  try {
    const r = await fetch(TARGET_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AAELMonitor/1.0)' } });
    html = await r.text();
  } catch (err) {
    res.status(200).json({ ok: false, error: `攞唔到對方網站：${String(err)}` });
    return;
  }

  const text = extractText(html);
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

  const prevRes = await fetch(`${url}/get/${HASH_KEY}`, { headers });
  const prevData = await prevRes.json();
  const prevHash = prevData.result;

  if (prevHash && prevHash !== hash) {
    await notifyDiscord({
      title: '👀 bhueasy.hk 內容可能有更新',
      color: 0x3498db,
      description: `偵測到內容變動（可能係假警報，見程式碼註解嘅技術限制說明）。\n[開啟對方網站](${TARGET_URL})`,
      webhookUrl: process.env.DISCORD_COMPETITOR_WEBHOOK_URL || process.env.DISCORD_ALERTS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL,
    });
  }

  // 記低今次嘅 hash，等下次比對
  await fetch(`${url}/set/${HASH_KEY}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'text/plain' },
    body: hash,
  });

  res.status(200).json({ ok: true, changed: !!(prevHash && prevHash !== hash), hash });
}
