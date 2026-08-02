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
import { KB } from '../lib/kb.mjs';

const SITE_URL = process.env.AAEL_SITE_URL || 'https://aael.online';
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

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

/* ---------- /lookup 搜返已儲存嘅查詢／BHU登記記錄 ---------- */
async function lookupRecords(query) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];
  const headers = { Authorization: `Bearer ${token}` };
  const q = query.trim().toLowerCase();
  const results = [];

  for (const prefix of ['inquiry', 'bhu']) {
    try {
      const idxRes = await fetch(`${url}/smembers/aael:${prefix}:index`, { headers });
      const idxData = await idxRes.json();
      const ids = (idxData.result || []).slice(-200); // 限制數量，避免逐個 GET 太耐
      for (const id of ids) {
        const r = await fetch(`${url}/get/aael:${prefix}:${id}`, { headers });
        const d = await r.json();
        if (!d.result) continue;
        const rec = JSON.parse(d.result);
        const hay = `${rec.name || ''} ${rec.contact || ''} ${rec.address || ''}`.toLowerCase();
        if (hay.includes(q)) results.push(rec);
      }
    } catch {
      // 個別 prefix 讀取失敗唔應該令成個搜尋崩潰
    }
  }
  return results.slice(0, 5);
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
        const lines = results.map((r, i) => {
          const kind = r.type === 'bhu-renewal' ? 'BHU續期登記' : '一般查詢';
          const detail =
            r.type === 'bhu-renewal'
              ? `到期：${r.expiry || '未填'}`
              : `內容：${(r.message || '').slice(0, 60)}`;
          return `**${i + 1}. [${kind}] ${r.name}**\n聯絡：${r.contact}｜地址：${r.address || '（未填）'}\n${detail}\n登記於：${(r.registeredAt || '').slice(0, 10)}`;
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
              '`/deadline` — 簡樸房寬限期登記倒數',
              '`/lookup 關鍵字` — 搜返已儲存嘅查詢／BHU登記記錄（管理員限定，只有你自己見到）',
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

      default:
        res.status(200).json(reply(`未知指令：${name}`, { ephemeral: true }));
        return;
    }
  }

  res.status(400).json({ error: '未支援嘅 interaction type' });
}
