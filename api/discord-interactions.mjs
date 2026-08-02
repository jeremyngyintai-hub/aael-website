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
import {
  upstashConfig, hkToday, readCount, readList, readTopPages,
  loadAllRecords, saveRecord, deleteRecord, shortId, recordsToCsv,
} from '../lib/records.mjs';

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

/* ---------- AI 網上搜尋（Gemini + Google Search grounding） ----------
   通用引擎：/competitor-news 用預設嘅對手監察 prompt，/websearch 就俾你自由問。 */
async function aiWebSearch(question) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, text: '伺服器未設定 GEMINI_API_KEY，搵唔到可用嘅搜尋功能。' };

  const model = process.env.AAEL_MODEL || 'gemini-flash-latest';
  const prompt = `你係香港樓宇事務顧問公司 AAEL 嘅研究助理。請用 Google 搜尋回答以下問題，
用繁體中文、精簡列點形式回覆（最多 6 點，每點一兩句）。只可以根據搜尋結果作答，
搵唔到相關資料就老實講「未搵到相關資料」，唔好靠估作出內容。

問題：${question}`;

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

function searchCompetitorNews() {
  return aiWebSearch(
    '最近呢一兩個月，香港簡樸房／劏房認證相關嘅市場動態，特別留意 bhueasy.hk 呢類同業競爭對手嘅最新消息（例如新服務、定價變動、宣傳推廣、政府政策更新對佢哋嘅影響等）。'
  );
}

/* ---------- 更新 deferred 回覆 + 附加檔案（multipart） ---------- */
async function patchDeferredReplyWithFile(interactionToken, content, filename, fileContent, mimeType) {
  if (!APP_ID) return;
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ content: content.slice(0, 1990) }));
  fd.append('files[0]', new Blob([fileContent], { type: mimeType }), filename);
  await fetch(`https://discord.com/api/v10/webhooks/${APP_ID}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    body: fd, // multipart boundary 由 fetch 自動處理，唔好自己設 Content-Type
  }).catch((err) => console.error('附加檔案回覆失敗', err));
}

/* ---------- /purge：刪除頻道最近嘅訊息 ----------
   用 Discord REST API（bot token）做：先攞返最近嘅訊息，再 bulk-delete。
   注意 Discord 嘅硬性限制：bulk-delete 只可以刪「14 日內」嘅訊息，
   多過 14 日嘅會自動跳過（會喺結果度話返你知跳咗幾多條）。 */
async function purgeMessages(channelId, amount, userId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, error: '伺服器未設定 DISCORD_BOT_TOKEN。' };
  const headers = { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' };

  // 如果指定咗只刪某用戶，就要攞多啲先夠篩；否則攞啱啱好嘅數量
  const fetchLimit = userId ? 100 : Math.min(amount, 100);
  const r = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages?limit=${fetchLimit}`,
    { headers }
  );
  if (!r.ok) {
    return {
      ok: false,
      error:
        r.status === 403
          ? '讀取訊息失敗（403）——AAEL Bot 嘅身份組需要「管理訊息 Manage Messages」同「讀取訊息記錄 Read Message History」權限，去 Server Settings → Roles 開返。'
          : `讀取訊息失敗（HTTP ${r.status}）。`,
    };
  }
  let msgs = await r.json();
  if (userId) msgs = msgs.filter((m) => m.author?.id === userId);
  msgs = msgs.slice(0, amount);
  if (!msgs.length) return { ok: true, deleted: 0, skippedOld: 0 };

  // bulk-delete 唔食超過 14 日嘅訊息 ID（成個請求會直接 400），要預先篩走。
  // 用 13.5 日做界線，預返啲時鐘誤差空間。
  const cutoff = Date.now() - 13.5 * 24 * 3600 * 1000;
  const young = msgs.filter((m) => Date.parse(m.timestamp) > cutoff);
  const skippedOld = msgs.length - young.length;

  let deleted = 0;
  if (young.length >= 2) {
    const br = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/bulk-delete`,
      { method: 'POST', headers, body: JSON.stringify({ messages: young.map((m) => m.id) }) }
    );
    if (br.ok) deleted = young.length;
    else {
      const detail = await br.text().catch(() => '');
      return { ok: false, error: `刪除失敗（HTTP ${br.status}）${br.status === 403 ? '——檢查 Bot 有冇「管理訊息」權限。' : ''} ${detail.slice(0, 150)}` };
    }
  } else if (young.length === 1) {
    // bulk-delete 最少要 2 條，單條要用普通 DELETE
    const dr = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${young[0].id}`,
      { method: 'DELETE', headers }
    );
    if (dr.ok) deleted = 1;
    else return { ok: false, error: `刪除失敗（HTTP ${dr.status}）。` };
  }
  return { ok: true, deleted, skippedOld };
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
              '`/purge 數量` — 刪除呢個頻道最近嘅訊息，可選只刪某用戶（需要「管理訊息」權限）',
              '`/export` — 將全部查詢／BHU記錄匯出做 CSV（Excel 開得，管理員限定）',
              '`/wipe 關鍵字` — 永久刪除包含關鍵字嘅記錄，兩步確認（管理員限定）',
              '`/note 編號 內容` — 為記錄加跟進備註（管理員限定）',
              '`/undone 編號` — 將記錄還原做未跟進（管理員限定）',
              '`/whois 編號` — 睇一條記錄嘅完整資料連備註（管理員限定）',
              '`/websearch 問題` — 用 AI 網上搜尋任何題目（需要幾秒鐘）',
              '`/broadcast 頻道 內容` — 用 Bot 身份出公告（管理員限定）',
              '`/slowmode 秒數` — 設定頻道慢速模式，0 = 關閉（管理員限定）',
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
        const days = Math.min(Math.max(parseInt(getOption(options, 'days'), 10) || 1, 1), 9);
        if (days > 1) {
          // 多日趨勢：由舊到新，包括今日。上限 9 日，因為統計 key 過期時間係 9 日。
          const dates = Array.from({ length: days }, (_, i) => hkToday(days - 1 - i));
          const [pv, ch] = await Promise.all([
            Promise.all(dates.map((d) => readCount(cfg, `aael:pageviews:${d}`))),
            Promise.all(dates.map((d) => readCount(cfg, `aael:chat:${d}`))),
          ]);
          const lines = [
            `**📊 最近 ${days} 日趨勢（香港時間，舊→新）**`,
            ...dates.map((d, i) => `${d.slice(5)}　📄${pv[i]}　🤖${ch[i]}`),
            '',
            `合計：📄 ${pv.reduce((a, b) => a + b, 0)} 次瀏覽｜🤖 ${ch.reduce((a, b) => a + b, 0)} 次 AI 查詢`,
          ];
          res.status(200).json(reply(lines.join('\n'), { ephemeral: true }));
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
          const note = r.notes?.length ? `\n　📝 ${r.notes[r.notes.length - 1].text.slice(0, 60)}` : '';
          return `**${i + 1}. 🔄 [${kind}] ${r.name}**（編號 \`${shortId(id)}\`）\n${r.contact}｜${(r.registeredAt || '').slice(0, 10)}｜${detail}${note}`;
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

      case 'export': {
        // 讀齊全部記錄可能超過 3 秒，用 deferred ephemeral
        res.status(200).json({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: 64 },
        });
        waitUntil(
          (async () => {
            const all = await loadAllRecords();
            if (!all.length) {
              await patchDeferredReply(body.token, '而家冇任何已儲存嘅記錄。');
              return;
            }
            // 新到舊排序，方便喺 Excel 由上而下睇
            all.sort((a, b) => String(b.rec.registeredAt || '').localeCompare(String(a.rec.registeredAt || '')));
            const csv = recordsToCsv(all);
            const dateStr = hkToday();
            const pendingCount = all.filter(({ rec }) => rec.status !== 'done').length;
            await patchDeferredReplyWithFile(
              body.token,
              `📊 已匯出 **${all.length}** 條記錄（未跟進 ${pendingCount} 條）。\nExcel 直接開就得；提提你：入面有客戶個人資料（PDPO），儲存同傳閱要小心。`,
              `AAEL_記錄匯出_${dateStr}.csv`,
              csv,
              'text/csv; charset=utf-8'
            );
          })()
        );
        return;
      }

      case 'wipe': {
        const keyword = String(getOption(options, 'keyword') || '').trim().toLowerCase();
        const confirmed = String(getOption(options, 'confirm') || '').trim().toLowerCase() === 'yes';
        if (!keyword) {
          res.status(200).json(reply('請提供關鍵字，例如 `/wipe keyword:test`。', { ephemeral: true }));
          return;
        }
        res.status(200).json({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: 64 },
        });
        waitUntil(
          (async () => {
            const all = await loadAllRecords();
            const matches = all.filter(({ rec }) => {
              const hay = `${rec.name || ''} ${rec.contact || ''} ${rec.address || ''} ${rec.message || ''}`.toLowerCase();
              return hay.includes(keyword);
            });
            if (!matches.length) {
              await patchDeferredReply(body.token, `搵唔到包含「${keyword}」嘅記錄。`);
              return;
            }
            if (!confirmed) {
              // 第一步：只預覽，唔刪。防止手快剷錯真客戶資料。
              const preview = matches.slice(0, 15).map(({ id, rec }, i) =>
                `${i + 1}. [${rec.type === 'bhu-renewal' ? 'BHU' : '查詢'}] ${rec.name}｜${rec.contact}（\`${shortId(id)}\`）`
              );
              const more = matches.length > 15 ? `\n…以及另外 ${matches.length - 15} 條` : '';
              await patchDeferredReply(
                body.token,
                `⚠️ 將會**永久刪除**以下 **${matches.length}** 條包含「${keyword}」嘅記錄：\n${preview.join('\n')}${more}\n\n確定就再行一次：\`/wipe keyword:${keyword} confirm:yes\`\n（刪咗冇得返轉頭；建議刪之前先 \`/export\` 留底。）`
              );
              return;
            }
            let deleted = 0;
            for (const { prefix, id } of matches) {
              if (await deleteRecord(prefix, id)) deleted++;
            }
            await patchDeferredReply(
              body.token,
              `🗑️ 已永久刪除 **${deleted}** 條包含「${keyword}」嘅記錄${deleted < matches.length ? `（${matches.length - deleted} 條刪除失敗，可以再試一次）` : ''}。`
            );
          })()
        );
        return;
      }

      case 'purge': {
        const amount = Math.min(Math.max(parseInt(getOption(options, 'amount'), 10) || 0, 1), 100);
        const targetUser = getOption(options, 'user'); // user option 嘅 value 就係 user ID 字串
        // 攞訊息＋刪除有兩三個 API 來回，怕撞 Discord 3 秒時限，用 deferred ephemeral
        res.status(200).json({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: 64 },
        });
        waitUntil(
          (async () => {
            const result = await purgeMessages(body.channel_id, amount, targetUser);
            let msg;
            if (!result.ok) {
              msg = `❌ ${result.error}`;
            } else {
              msg = `🧹 已刪除 **${result.deleted}** 條訊息${targetUser ? `（只限 <@${targetUser}>）` : ''}。`;
              if (result.skippedOld) {
                msg += `\n（另有 ${result.skippedOld} 條超過 14 日，Discord 唔容許批量刪除，已跳過——嗰啲要手動逐條刪。）`;
              }
              if (result.deleted === 0 && !result.skippedOld) {
                msg = targetUser ? `最近 100 條訊息入面搵唔到 <@${targetUser}> 嘅訊息。` : '呢個頻道冇訊息可以刪。';
              }
            }
            await patchDeferredReply(body.token, msg);
          })()
        );
        return;
      }

      case 'note': {
        const idInput = String(getOption(options, 'id') || '').trim().toLowerCase();
        const text = String(getOption(options, 'text') || '').trim().slice(0, 300);
        if (!idInput || !text) {
          res.status(200).json(reply('用法：`/note id:編號 text:備註內容`（編號用 `/pending` 或 `/lookup` 睇）。', { ephemeral: true }));
          return;
        }
        const all = await loadAllRecords();
        const matches = all.filter(({ id }) => shortId(id).toLowerCase() === idInput || id === idInput);
        if (matches.length !== 1) {
          res.status(200).json(reply(matches.length ? `編號 \`${idInput}\` 對應多過一條記錄，請用 \`/lookup\` 確認。` : `搵唔到編號 \`${idInput}\` 嘅記錄。`, { ephemeral: true }));
          return;
        }
        const { prefix, id, rec } = matches[0];
        rec.notes = (rec.notes || []).slice(-19); // 最多保留 20 條備註
        rec.notes.push({ at: new Date().toISOString(), text });
        const saved = await saveRecord(prefix, id, rec);
        res.status(200).json(
          reply(saved ? `📝 已為 **${rec.name}** 加備註：${text}` : '儲存失敗，請遲啲再試。', { ephemeral: true })
        );
        return;
      }

      case 'undone': {
        const idInput = String(getOption(options, 'id') || '').trim().toLowerCase();
        if (!idInput) {
          res.status(200).json(reply('請提供記錄編號，例如 `/undone a1b2c3`。', { ephemeral: true }));
          return;
        }
        const all = await loadAllRecords();
        const matches = all.filter(({ id }) => shortId(id).toLowerCase() === idInput || id === idInput);
        if (matches.length !== 1) {
          res.status(200).json(reply(matches.length ? `編號 \`${idInput}\` 對應多過一條記錄，請用 \`/lookup\` 確認。` : `搵唔到編號 \`${idInput}\` 嘅記錄。`, { ephemeral: true }));
          return;
        }
        const { prefix, id, rec } = matches[0];
        if (rec.status !== 'done') {
          res.status(200).json(reply(`呢條記錄（${rec.name}）本身就係未跟進狀態。`, { ephemeral: true }));
          return;
        }
        delete rec.status;
        delete rec.doneAt;
        const saved = await saveRecord(prefix, id, rec);
        res.status(200).json(
          reply(saved ? `🔄 已將 **${rec.name}** 還原為未跟進。` : '儲存失敗，請遲啲再試。', { ephemeral: true })
        );
        return;
      }

      case 'whois': {
        const idInput = String(getOption(options, 'id') || '').trim().toLowerCase();
        if (!idInput) {
          res.status(200).json(reply('請提供記錄編號，例如 `/whois a1b2c3`。', { ephemeral: true }));
          return;
        }
        const all = await loadAllRecords();
        const matches = all.filter(({ id }) => shortId(id).toLowerCase() === idInput || id === idInput);
        if (matches.length !== 1) {
          res.status(200).json(reply(matches.length ? `編號 \`${idInput}\` 對應多過一條記錄。` : `搵唔到編號 \`${idInput}\` 嘅記錄。`, { ephemeral: true }));
          return;
        }
        const { id, rec } = matches[0];
        const lines = [
          `**${statusEmoji(rec)} ${rec.type === 'bhu-renewal' ? 'BHU續期登記' : '一般查詢'} — ${rec.name}**（編號 \`${shortId(id)}\`）`,
          `聯絡方式：${rec.contact}`,
          `樓宇地址：${rec.address || '（未填）'}`,
        ];
        if (rec.type === 'bhu-renewal') {
          lines.push(`單位數目：${rec.units || '（未填）'}｜屆滿日期：${rec.expiry || '（未填）'}｜簽發方：${rec.issuer || '（未填）'}`);
        } else {
          lines.push(`查詢內容：${(rec.message || '').slice(0, 800)}`);
        }
        lines.push(`登記於：${(rec.registeredAt || '').slice(0, 16).replace('T', ' ')}`);
        if (rec.status === 'done') lines.push(`✅ 完成於：${(rec.doneAt || '').slice(0, 16).replace('T', ' ')}`);
        if (rec.notes?.length) {
          lines.push('', '**📝 跟進備註**');
          rec.notes.slice(-10).forEach((n) => lines.push(`• [${(n.at || '').slice(0, 10)}] ${n.text}`));
        }
        res.status(200).json(reply(lines.join('\n'), { ephemeral: true }));
        return;
      }

      case 'websearch': {
        const q = String(getOption(options, 'query') || '').trim().slice(0, 300);
        if (!q) {
          res.status(200).json(reply('請輸入問題，例如 `/websearch 屋宇署最近有咩簡樸房公告`。', { ephemeral: true }));
          return;
        }
        res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
        waitUntil(
          (async () => {
            const result = await aiWebSearch(q);
            const sourcesText = result.sources?.length
              ? '\n\n**參考來源：**\n' + result.sources.map((s) => `<${s}>`).join('\n')
              : '';
            await patchDeferredReply(body.token, `🔎 **${q}**\n\n${result.text}${sourcesText}`);
          })()
        );
        return;
      }

      case 'broadcast': {
        const preset = getOption(options, 'preset');
        if (preset === 'commands') {
          const channelId0 = getOption(options, 'channel');
          const botToken0 = process.env.DISCORD_BOT_TOKEN;
          const embed = {
            title: '🤖 AAEL Bot 指令一覽',
            color: 0xce8f5a,
            description: '所有人都用得嘅指令直接打就得；標咗 🔒 嘅要相應權限先見到。',
            fields: [
              {
                name: '📚 知識庫 & AI',
                value: [
                  '`/kb 關鍵字` — 搜尋知識庫文章',
                  '`/article slug` — 用 slug 攞文章連結',
                  '`/ask 問題` — 問 AAEL AI 助理（需要幾秒）',
                  '`/websearch 問題` — AI 網上搜尋任何題目',
                  '`/competitor-news` — 市場／對手最新動態',
                ].join('\n'),
                inline: false,
              },
              {
                name: '📋 資訊',
                value: [
                  '`/deadline` — 簡樸房寬限期倒數',
                  '`/contact` — 公司聯絡資料',
                  '`/help` — 指令清單',
                ].join('\n'),
                inline: false,
              },
              {
                name: '🔒 客戶跟進（管理員）',
                value: [
                  '`/pending` — 未跟進清單',
                  '`/done 編號`／`/undone 編號` — 標記／還原完成',
                  '`/note 編號 內容` — 加跟進備註',
                  '`/whois 編號` — 完整記錄連備註',
                  '`/lookup 關鍵字` — 搜記錄',
                  '`/export` — 匯出 CSV（Excel 開得）',
                  '`/wipe 關鍵字` — 刪記錄（兩步確認）',
                ].join('\n'),
                inline: false,
              },
              {
                name: '🔒 數據 & 管理',
                value: [
                  '`/stats`／`/stats days:7` — 即時數據／多日趨勢',
                  '`/status` — API 設定狀態',
                  '`/purge 數量` — 刪除頻道訊息',
                  '`/broadcast` — Bot 身份出公告',
                  '`/slowmode 秒數` — 頻道慢速模式',
                ].join('\n'),
                inline: false,
              },
            ],
            footer: { text: 'AAEL — aael.online' },
            timestamp: new Date().toISOString(),
          };
          const r0 = await fetch(`https://discord.com/api/v10/channels/${channelId0}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bot ${botToken0}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] }),
          });
          res.status(200).json(
            reply(
              r0.ok
                ? `📣 指令一覽公告已發送去 <#${channelId0}>。建議去嗰邊將佢釘選（Pin），方便隨時查。`
                : `發送失敗（HTTP ${r0.status}）${r0.status === 403 ? '——Bot 喺嗰個頻道冇「發送訊息」權限。' : ''}`,
              { ephemeral: true }
            )
          );
          return;
        }
        const channelId = getOption(options, 'channel');
        // 支援多行：slash command 輸入框係單行，打「\\n」會自動轉做真換行
        const message = String(getOption(options, 'message') || '').replace(/\\n/g, '\n').trim().slice(0, 1800);
        if (!channelId || !message) {
          res.status(200).json(reply('用法：`/broadcast channel:#頻道 message:內容`（打 `\\n` 可以換行），或者 `/broadcast channel:#頻道 preset:指令一覽`。', { ephemeral: true }));
          return;
        }
        const botToken = process.env.DISCORD_BOT_TOKEN;
        const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: message }),
        });
        res.status(200).json(
          reply(
            r.ok
              ? `📣 已用 AAEL Bot 身份發送去 <#${channelId}>。`
              : `發送失敗（HTTP ${r.status}）${r.status === 403 ? '——Bot 喺嗰個頻道冇「發送訊息」權限。' : ''}`,
            { ephemeral: true }
          )
        );
        return;
      }

      case 'slowmode': {
        const seconds = Math.min(Math.max(parseInt(getOption(options, 'seconds'), 10) || 0, 0), 21600);
        const targetChannel = getOption(options, 'channel') || body.channel_id;
        const botToken = process.env.DISCORD_BOT_TOKEN;
        const r = await fetch(`https://discord.com/api/v10/channels/${targetChannel}`, {
          method: 'PATCH',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ rate_limit_per_user: seconds }),
        });
        res.status(200).json(
          reply(
            r.ok
              ? seconds === 0
                ? `⏱️ 已關閉 <#${targetChannel}> 嘅慢速模式。`
                : `⏱️ 已將 <#${targetChannel}> 慢速模式設為每 ${seconds} 秒一條訊息。`
              : `設定失敗（HTTP ${r.status}）${r.status === 403 ? '——Bot 需要「管理頻道 Manage Channels」權限。' : ''}`,
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
