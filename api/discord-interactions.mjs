// AAEL Discord Bot — Interactions Endpoint
// 用途：處理 Discord slash commands（/kb /deadline /status /contact /article）
//
// 呢個唔係傳統嗰種要長駐運行嘅 Discord bot（gateway websocket），
// 而係用 Discord 官方嘅 HTTP Interactions API：Discord 有人打 slash command，
// 就會 POST 一個請求嚟呢個 endpoint，處理完直接回覆——完全 fit Vercel serverless 嘅
// 「有請求先執行」模式，唔使額外起一部長駐伺服器。
//
// 環境變數：
//   DISCORD_PUBLIC_KEY（必需）— Discord Developer Portal → General Information → Public Key
//   AAEL_SITE_URL（可選，預設 https://aael.online）— 用嚟組成文章連結同 call /api/health
//
// 部署後記得去 Discord Developer Portal 將呢個 function 嘅網址
// （例如 https://aael.online/api/discord-interactions）設做 Interactions Endpoint URL。
// Discord 會即時發一個 PING 嚟驗證，簽名唔啱會設定唔到。
//
// 依賴套件：discord-interactions（signature 驗證）
//   package.json 需要：{ "dependencies": { "discord-interactions": "^4.4.0" } }

import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { waitUntil } from '@vercel/functions';
import { KB } from '../lib/kb.mjs';

const SITE_URL = process.env.AAEL_SITE_URL || 'https://aael.online';
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const APP_ID = process.env.DISCORD_APP_ID;

// Vercel serverless function 預設會自動解析 body（JSON），
// 但簽名驗證需要「未經解析嘅原始 bytes」，所以呢度關閉自動解析，自己讀 raw body。
export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ---------- /kb 搜尋知識庫（重用 kb.mjs，同 AI Pro 用緊同一份資料） ---------- */
function searchKB(query, limit = 3) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = KB.map((a) => {
    let score = 0;
    const hay = [a.title, a.title_en, a.lede, ...(a.k || [])].join(' ').toLowerCase();
    q.split(/\s+/).forEach((term) => {
      if (!term) return;
      if (a.title.toLowerCase().includes(term)) score += 5;
      if ((a.k || []).some((kw) => kw.toLowerCase().includes(term))) score += 3;
      if (hay.includes(term)) score += 1;
    });
    return { a, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((s) => s.a);
}

/* ---------- /deadline BHU 寬限期登記倒數 ---------- */
function bhuDeadline() {
  const deadline = new Date('2027-02-28T23:59:59+08:00');
  const now = new Date();
  const days = Math.ceil((deadline - now) / 86400000);
  return { days, deadline };
}

/* ---------- Upstash 共用讀取輔助 ---------- */
function upstashConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, headers: { Authorization: `Bearer ${token}` } };
}

function hkToday() {
  // 香港時間（UTC+8）日期，同 chat.mjs／track-pageview.mjs／daily-stats.mjs 保持一致
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function readCount(cfg, key) {
  try {
    const r = await fetch(`${cfg.url}/get/${key}`, { headers: cfg.headers });
    const d = await r.json();
    return d.result ? parseInt(d.result, 10) : 0;
  } catch {
    return 0;
  }
}

async function readList(cfg, key) {
  try {
    const r = await fetch(`${cfg.url}/lrange/${key}/0/-1`, { headers: cfg.headers });
    const d = await r.json();
    return (d.result || []).map((q) => decodeURIComponent(q));
  } catch {
    return [];
  }
}

async function readTopPages(cfg, key, limit = 5) {
  try {
    const r = await fetch(`${cfg.url}/zrevrange/${key}/0/${limit - 1}/withscores`, { headers: cfg.headers });
    const d = await r.json();
    const flat = d.result || []; // [page1, score1, page2, score2, ...]
    const pages = [];
    for (let i = 0; i < flat.length; i += 2) {
      pages.push({ page: decodeURIComponent(flat[i]), count: parseInt(flat[i + 1], 10) });
    }
    return pages;
  } catch {
    return [];
  }
}

/* ---------- 載入所有已儲存嘅查詢／BHU登記記錄（/lookup /pending /done 共用） ---------- */
async function loadAllRecords() {
  const cfg = upstashConfig();
  if (!cfg) return [];
  const out = [];

  for (const prefix of ['inquiry', 'bhu']) {
    try {
      const idxRes = await fetch(`${cfg.url}/smembers/aael:${prefix}:index`, { headers: cfg.headers });
      const idxData = await idxRes.json();
      const ids = (idxData.result || []).slice(-200); // 限制數量，避免逐個 GET 太耐
      for (const id of ids) {
        const r = await fetch(`${cfg.url}/get/aael:${prefix}:${id}`, { headers: cfg.headers });
        const d = await r.json();
        if (!d.result) continue;
        try {
          out.push({ prefix, id, rec: JSON.parse(d.result) });
        } catch {
          // 個別記錄格式壞咗就跳過
        }
      }
    } catch {
      // 個別 prefix 讀取失敗唔應該令成個搜尋崩潰
    }
  }
  return out;
}

async function saveRecord(prefix, id, rec) {
  const cfg = upstashConfig();
  if (!cfg) return false;
  const r = await fetch(`${cfg.url}/set/aael:${prefix}:${id}`, {
    method: 'POST',
    headers: { ...cfg.headers, 'Content-Type': 'text/plain' },
    body: JSON.stringify(rec),
  });
  return r.ok;
}

// 記錄嘅短編號：id 格式係 `${timestamp}-${六位隨機字串}`，攞後面嗰段做人手輸入用嘅短編號
function shortId(id) {
  const parts = String(id).split('-');
  return parts[parts.length - 1] || id;
}

function statusEmoji(rec) {
  return rec.status === 'done' ? '✅' : '🔄';
}

/* ---------- /lookup 搜返已儲存嘅查詢／BHU登記記錄 ---------- */
async function lookupRecords(query) {
  const q = query.trim().toLowerCase();
  const all = await loadAllRecords();
  return all
    .filter(({ rec }) => {
      const hay = `${rec.name || ''} ${rec.contact || ''} ${rec.address || ''}`.toLowerCase();
      return hay.includes(q);
    })
    .slice(0, 5);
}

/* ---------- /competitor-news：用 Gemini + Google 搜尋 找返市場最新動態 ---------- */
async function searchCompetitorNews() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, text: '伺服器未設定 GEMINI_API_KEY，搵唔到可用嘅搜尋功能。' };

  const model = process.env.AAEL_MODEL || 'gemini-flash-latest';
  const prompt = `你係香港「簡樸房」（Basic Housing Unit／劏房規管）認證市場嘅商業分析員。
請用 Google 搜尋，搵返最近呢一兩個月，香港簡樸房／劏房認證相關嘅市場動態，
特別留意 bhueasy.hk 呢類同業競爭對手嘅最新消息（例如新服務、定價變動、宣傳推廣、
政府政策更新對佢哋嘅影響等）。

請用繁體中文，以精簡列點形式回覆（最多 5 點，每點一兩句），如果搵唔到最近嘅相關消息，
老實講「未搵到最近相關嘅新消息」，唔好靠估作出內容。`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.3 },
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) {
      return { ok: false, text: `搜尋失敗：${data?.error?.message || r.status}` };
    }
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n')
      .trim();

    const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = chunks
      .map((c) => c.web?.uri)
      .filter(Boolean)
      .slice(0, 5);

    return { ok: true, text: text || '未搵到相關內容。', sources };
  } catch (err) {
    return { ok: false, text: `搜尋出錯：${String(err)}` };
  }
}

/* ---------- /ask：喺 Discord 直接問 AAEL AI 助理 ----------
   直接 call 返網站自己嘅 /api/chat endpoint，完整重用嗰邊嘅檢索、
   系統指令、供應商轉接同延伸閱讀連結邏輯——零重複程式碼。
   注意：呢啲查詢會計入 AAEL_DAILY_LIMIT（同網站訪客共用每日名額），
   啱啱好順便當內部測試真實體驗。 */
async function askAI(question) {
  try {
    const r = await fetch(`${SITE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
    });
    const data = await r.json();
    if (!r.ok) {
      return { ok: false, text: data?.error || `AI 服務回傳 ${r.status}` };
    }
    return { ok: true, text: data.reply || '未能產生回答。', quota: data.quota };
  } catch (err) {
    return { ok: false, text: `連接 AI 服務出錯：${String(err)}` };
  }
}

/* ---------- 更新返個 deferred interaction 嘅最終回覆 ---------- */
async function patchDeferredReply(interactionToken, content) {
  if (!APP_ID) return;
  await fetch(`https://discord.com/api/v10/webhooks/${APP_ID}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1990) }),
  }).catch((err) => console.error('更新 Discord 回覆失敗', err));
}

function reply(content, { ephemeral = false, embeds } = {}) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      embeds,
      flags: ephemeral ? 64 : undefined, // 64 = EPHEMERAL，只有指令發出者見到
    },
  };
}

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!PUBLIC_KEY) {
    res.status(500).json({ error: '伺服器未設定 DISCORD_PUBLIC_KEY' });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  const isValid = signature && timestamp && (await verifyKey(rawBody, signature, timestamp, PUBLIC_KEY));
  if (!isValid) {
    res.status(401).send('Bad request signature');
    return;
  }

  const body = JSON.parse(rawBody);

  // Discord 設定 Interactions Endpoint URL 時會送一個 PING 嚟驗證，必須回 PONG
  if (body.type === InteractionType.PING) {
    res.status(200).json({ type: InteractionResponseType.PONG });
    return;
  }

  if (body.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = body.data;

    switch (name) {
      case 'kb': {
        const query = getOption(options, 'query') || '';
        const results = searchKB(query);
        if (!results.length) {
          res.status(200).json(reply(`搵唔到同「${query}」相關嘅文章，試下用其他關鍵字。`, { ephemeral: true }));
          return;
        }
        const lines = results.map(
          (a, i) => `**${i + 1}. ${a.title}**\n${a.lede}\n${SITE_URL}/${a.slug}.html`
        );
        res.status(200).json(reply(lines.join('\n\n')));
        return;
      }

      case 'article': {
        const slug = (getOption(options, 'slug') || '').trim();
        const article = KB.find((a) => a.slug === slug || a.slug === `guide-${slug}`);
        if (!article) {
          res
            .status(200)
            .json(reply(`搵唔到 slug「${slug}」嘅文章。用 \`/kb\` 先搜尋，抄返個 slug 出嚟。`, { ephemeral: true }));
          return;
        }
        res
          .status(200)
          .json(reply(`**${article.title}**\n${article.lede}\n${SITE_URL}/${article.slug}.html`));
        return;
      }

      case 'deadline': {
        const { days, deadline } = bhuDeadline();
        const msg =
          days > 0
            ? `距離簡樸房寬限期登記截止（${deadline.toLocaleDateString('zh-HK')}）仲有 **${days}** 日。`
            : `簡樸房寬限期登記已經喺 ${deadline.toLocaleDateString('zh-HK')} 截止。`;
        res.status(200).json(reply(msg));
        return;
      }

      case 'lookup': {
        const query = getOption(options, 'query') || '';
        const results = await lookupRecords(query);
        if (!results.length) {
          res.status(200).json(reply(`搵唔到同「${query}」相關嘅記錄。`, { ephemeral: true }));
          return;
        }
        const lines = results.map(({ id, rec: r }, i) => {
          const kind = r.type === 'bhu-renewal' ? 'BHU續期登記' : '一般查詢';
          const detail =
            r.type === 'bhu-renewal'
              ? `到期：${r.expiry || '未填'}`
              : `內容：${(r.message || '').slice(0, 60)}`;
          return `**${i + 1}. ${statusEmoji(r)} [${kind}] ${r.name}**（編號 \`${shortId(id)}\`）\n聯絡：${r.contact}｜地址：${r.address || '（未填）'}\n${detail}\n登記於：${(r.registeredAt || '').slice(0, 10)}${r.status === 'done' ? `｜完成於：${(r.doneAt || '').slice(0, 10)}` : ''}`;
        });
        res.status(200).json(reply(lines.join('\n\n'), { ephemeral: true }));
        return;
      }

      case 'help': {
        res.status(200).json(
          reply(
            [
              '**AAEL Bot 可用指令**',
              '`/kb 關鍵字` — 搜尋知識庫文章',
              '`/article slug` — 用 slug 直接攞文章連結',
              '`/ask 問題` — 問 AAEL AI 助理（同網站 AI Pro 同一個腦，需要幾秒鐘）',
              '`/deadline` — 簡樸房寬限期登記倒數',
              '`/stats` — 即時查今日網站數據（管理員限定，只有你自己見到）',
              '`/pending` — 未跟進查詢清單（管理員限定，只有你自己見到）',
              '`/done 編號` — 將查詢標記為已完成（管理員限定）',
              '`/lookup 關鍵字` — 搜返已儲存嘅查詢／BHU登記記錄（管理員限定，只有你自己見到）',
              '`/competitor-news` — 用 AI 網上搜尋，睇下市場/競爭對手最近動態（需要幾秒鐘）',
              '`/status` — 查網站 API 設定狀態（管理員限定，只有你自己見到）',
              '`/contact` — 顯示公司聯絡資料',
            ].join('\n')
          )
        );
        return;
      }

      case 'status': {
        try {
          const r = await fetch(`${SITE_URL}/api/health`);
          const data = await r.json();
          const lines = data.checks.map(
            (c) => `${c.有效 === false ? '❌' : '✅'} ${c.項目}：${c.狀態}`
          );
          res.status(200).json(
            reply(`**${data.結果}**\n${lines.join('\n')}\n\n更新時間：${data.time}`, { ephemeral: true })
          );
        } catch (err) {
          res.status(200).json(reply(`查詢 /api/health 失敗：${String(err)}`, { ephemeral: true }));
        }
        return;
      }

      case 'contact': {
        res.status(200).json(
          reply(
            [
              '**躍昇建築事務顧問有限公司 (AAEL)**',
              'Room 709, 7/F, Wing On Plaza, 62 Mody Road, Tsim Sha Tsui East, Kowloon',
              '📧 aaelhk.info@gmail.com',
              `🌐 ${SITE_URL}`,
            ].join('\n')
          )
        );
        return;
      }

      case 'stats': {
        const cfg = upstashConfig();
        if (!cfg) {
          res.status(200).json(reply('未設定 Upstash 環境變數，讀唔到統計數據。', { ephemeral: true }));
          return;
        }
        const date = hkToday();
        const [pageviews, chatUsage, topPages, zeroHits] = await Promise.all([
          readCount(cfg, `aael:pageviews:${date}`),
          readCount(cfg, `aael:chat:${date}`),
          readTopPages(cfg, `aael:pageviews:top:${date}`),
          readList(cfg, `aael:zerohit:${date}`),
        ]);
        const lines = [
          `**📊 今日即時數據 — ${date}（香港時間）**`,
          `📄 網頁瀏覽量：**${pageviews}** 次`,
          `🤖 AI Pro 查詢：**${chatUsage}** 次`,
        ];
        if (topPages.length) {
          const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
          lines.push('', '🔥 **今日熱門頁面**');
          topPages.forEach((p, i) => lines.push(`${medals[i] || `${i + 1}.`} ${p.page || '首頁'} — ${p.count} 次`));
        }
        if (zeroHits.length) {
          lines.push('', `❓ AI Pro 零命中問題：${zeroHits.length} 條（最新：${zeroHits[zeroHits.length - 1].slice(0, 60)}）`);
        }
        res.status(200).json(reply(lines.join('\n'), { ephemeral: true }));
        return;
      }

      case 'ask': {
        const question = String(getOption(options, 'query') || '').trim().slice(0, 500);
        if (!question) {
          res.status(200).json(reply('請輸入問題，例如 `/ask 簡樸房要幾時前登記？`', { ephemeral: true }));
          return;
        }
        // AI 回答通常超過 Discord 3 秒時限，用 deferred + waitUntil（同 /competitor-news 一樣套路）
        res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

        waitUntil(
          (async () => {
            const result = await askAI(question);
            const quotaNote = result.quota ? `\n\n_（今日 AI 名額已用 ${result.quota.used}/${result.quota.limit}）_` : '';
            await patchDeferredReply(
              body.token,
              `**❓ ${question}**\n\n${result.text}${quotaNote}`
            );
          })()
        );
        return;
      }

      case 'pending': {
        const all = await loadAllRecords();
        const pending = all
          .filter(({ rec }) => rec.status !== 'done')
          .sort((a, b) => String(b.rec.registeredAt || '').localeCompare(String(a.rec.registeredAt || '')))
          .slice(0, 10);
        if (!pending.length) {
          res.status(200).json(reply('🎉 冇未跟進嘅記錄，全部搞掂晒。', { ephemeral: true }));
          return;
        }
        const lines = pending.map(({ id, rec: r }, i) => {
          const kind = r.type === 'bhu-renewal' ? 'BHU續期' : '查詢';
          const detail = r.type === 'bhu-renewal' ? `到期：${r.expiry || '未填'}` : (r.message || '').slice(0, 50);
          return `**${i + 1}. 🔄 [${kind}] ${r.name}**（編號 \`${shortId(id)}\`）\n${r.contact}｜${(r.registeredAt || '').slice(0, 10)}｜${detail}`;
        });
        lines.push('', '完成跟進後用 `/done 編號` 標記（編號係上面 `xxxxxx` 嗰段）。');
        res.status(200).json(reply(lines.join('\n'), { ephemeral: true }));
        return;
      }

      case 'done': {
        const idInput = String(getOption(options, 'id') || '').trim().toLowerCase();
        if (!idInput) {
          res.status(200).json(reply('請提供記錄編號，例如 `/done a1b2c3`（用 `/pending` 睇編號）。', { ephemeral: true }));
          return;
        }
        const all = await loadAllRecords();
        const matches = all.filter(({ id }) => shortId(id).toLowerCase() === idInput || id === idInput);
        if (!matches.length) {
          res.status(200).json(reply(`搵唔到編號 \`${idInput}\` 嘅記錄，用 \`/pending\` 或 \`/lookup\` 確認返個編號。`, { ephemeral: true }));
          return;
        }
        if (matches.length > 1) {
          res.status(200).json(reply(`編號 \`${idInput}\` 對應多過一條記錄（罕見情況），請改用 \`/lookup\` 搵返完整資料再聯絡開發者處理。`, { ephemeral: true }));
          return;
        }
        const { prefix, id, rec } = matches[0];
        if (rec.status === 'done') {
          res.status(200).json(reply(`✅ 呢條記錄（${rec.name}）之前已經標記咗完成（${(rec.doneAt || '').slice(0, 10)}）。`, { ephemeral: true }));
          return;
        }
        rec.status = 'done';
        rec.doneAt = new Date().toISOString();
        const saved = await saveRecord(prefix, id, rec);
        res.status(200).json(
          reply(
            saved
              ? `✅ 已將 **${rec.name}**（${rec.type === 'bhu-renewal' ? 'BHU續期登記' : '一般查詢'}）標記為完成。`
              : `儲存失敗，請遲啲再試。`,
            { ephemeral: true }
          )
        );
        return;
      }

      case 'competitor-news': {
        // Discord 要求 3 秒內回應，搜尋+整理內容通常會超過呢個時限，
        // 所以先回一個「處理緊」嘅 deferred 回應，實際搜尋放喺 waitUntil
        // 入面喺背景做，做完先用 PATCH 更新返個訊息內容。
        res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

        waitUntil(
          (async () => {
            const result = await searchCompetitorNews();
            const sourcesText = result.sources?.length
              ? '\n\n**參考來源：**\n' + result.sources.map((s) => `<${s}>`).join('\n')
              : '';
            await patchDeferredReply(
              body.token,
              `🔎 **市場/競爭對手最新動態**\n\n${result.text}${sourcesText}`
            );
          })()
        );
        return;
      }

      default:
        res.status(200).json(reply(`未知指令：${name}`, { ephemeral: true }));
        return;
    }
  }

  res.status(400).json({ error: '未支援嘅 interaction type' });
}
