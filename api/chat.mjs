// AAEL 內部測試用 AI 助理 — Vercel Serverless Function
// 環境變數：ANTHROPIC_API_KEY（必需）、AAEL_ACCESS_CODE（必需）、AAEL_MODEL（可選）
import { KB } from './kb.mjs';

const MODEL = process.env.AAEL_MODEL || 'claude-sonnet-5';
const MAX_Q = 500;            // 單次提問字數上限
const MAX_TURNS = 12;         // 對話輪數上限

/* ---------- 檢索：用關鍵詞計分揀出最相關文章 ---------- */
function retrieve(query, n = 2) {
  const q = ' ' + query.toLowerCase() + ' ';
  const scored = KB.map(a => {
    let s = 0;
    // 1. 標題整段命中：權重最高
    for (const seg of a.title.split(/[：:，、？]/)) {
      const t = seg.trim().toLowerCase();
      if (t.length >= 2 && q.includes(t)) s += t.length * 4;
    }
    // 2. 人手整理的關鍵詞（含繁簡英）：長詞得分高
    for (const kw of (a.k || [])) {
      const k = kw.toLowerCase();
      if (k.length >= 2 && q.includes(k)) s += k.length >= 4 ? 6 : 4;
    }
    // 3. 內文詞頻：較低權重，用於補漏
    const body = a.text.toLowerCase();
    for (const m of q.matchAll(/[\u4e00-\u9fff]{3,5}/g)) {
      if (body.includes(m[0])) s += 1;
    }
    return { a, s };
  }).filter(x => x.s > 0).sort((x, y) => y.s - x.s);
  return scored.slice(0, n).map(x => x.a);
}

const SYSTEM = `你是「躍昇建築事務顧問有限公司」（Ascend Architecture & Engineering Limited，簡稱 AAEL）網站的資訊助理。AAEL 是香港建築顧問公司，公司內部持有四項專業註冊：認可人士（A.P.）、註冊結構工程師（R.S.E.）、註冊專業測量師（R.P.S.）及註冊檢驗人員（R.I.）。

【你的角色】
為業主、業主立案法團、物業管理人及同業提供香港樓宇事務的一般資訊，協助他們理解自己面對的情況，並在適當時引導他們聯絡 AAEL 作個案評估。

【回答語言】
用戶用繁體中文提問，用繁體中文回答；用簡體中文提問，用簡體中文回答；用英文提問，用英文回答。中文一律用書面語，不要用口語。

【回答範圍】
可以回答香港樓宇相關的一般問題，包括：簡樸房認證、強制驗樓驗窗、屋宇署命令、僭建、小型工程與入則、樓宇勘察、滲漏、石屎剝落、業主立案法團事務、公契、樓宇維修資助、消防安全指示、處所牌照、工廈用途等。

若問題與樓宇事務完全無關（例如娛樂、政治、其他行業），禮貌說明你只能協助樓宇相關查詢。

【最重要的規則 — 準確性】
1. 提供的參考資料中有的內容，優先使用，並可自然引用。
2. 參考資料沒有涵蓋、但屬於你對香港樓宇事務的一般認識，可以回答，但必須：
   · 絕對不可以自行編造任何具體數字 —— 包括罰款金額、條例條文編號、費用水平、精確期限、面積或尺寸標準。
   · 若你不確定某個具體數字或日期，直接說明「具體數字請以政府最新公布為準」，不要猜測。
3. 涉及個別個案的判斷（例如「我這幅牆可否拆」「我這單位能否申請」），一律說明必須實地評估，不可在網上斷定。
4. 不確定就說不確定。錯誤資訊對 AAEL 的專業聲譽損害，遠大於答不出的損害。

【回答方式】
· 直接、實用、貼近業主處境，不要空泛。
· 篇幅適中：一般三至五句，複雜問題可分點，但不要長篇大論。
· 若參考資料中有相關文章，在答案末尾以這個格式提供連結：[延伸閱讀｜文章標題](https://aael.online/文章檔名.html)
· 涉及個案、時間緊迫或需要專業判斷時，引導聯絡：電郵 aaelhk.info@gmail.com，兩個工作天內回覆。

【絕對不要做】
· 不要提供收費報價（每宗個案不同，一律請對方電郵查詢）。
· 不要提及員工姓名或註冊編號。
· 不要聲稱這是專業意見或法律意見。
· 不要編造 AAEL 做過的項目或客戶。`;


/* ================= 供應商轉接器 =================
   改環境變數 AI_PROVIDER 即可切換：anthropic / gemini / openai / openrouter
   各自需要的 key：
     anthropic  → ANTHROPIC_API_KEY
     gemini     → GEMINI_API_KEY      （有免費層，唔使信用卡）
     openai     → OPENAI_API_KEY
     openrouter → OPENROUTER_API_KEY  （一個 key 用多家模型）
================================================== */
const PROVIDERS = {
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5',
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }),
    body: (model, system, msgs) => ({
      model, max_tokens: 700,
      system: [
        { type: 'text', text: system.rules, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: system.context },
      ],
      messages: msgs,
    }),
    parse: d => ({
      text: (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
      usage: d.usage ? { in: d.usage.input_tokens, out: d.usage.output_tokens } : null,
    }),
  },

  gemini: {
    envKey: 'GEMINI_API_KEY',
    defaultModel: 'gemini-flash-latest',  // 自動指向 Google 目前最新的 Flash 版本，減少日後模型下架的影響
    url: model => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: k => ({ 'x-goog-api-key': k, 'content-type': 'application/json' }),
    body: (model, system, msgs) => ({
      systemInstruction: { parts: [{ text: system.rules + '\n\n' + system.context }] },
      contents: msgs.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: 700, temperature: 0.3 },
    }),
    parse: d => ({
      text: (d.candidates?.[0]?.content?.parts || []).map(p => p.text).join('\n').trim(),
      usage: d.usageMetadata
        ? { in: d.usageMetadata.promptTokenCount, out: d.usageMetadata.candidatesTokenCount }
        : null,
    }),
  },

  openai: {
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    url: () => 'https://api.openai.com/v1/chat/completions',
    headers: k => ({ Authorization: `Bearer ${k}`, 'content-type': 'application/json' }),
    body: (model, system, msgs) => ({
      model, max_tokens: 700, temperature: 0.3,
      messages: [{ role: 'system', content: system.rules + '\n\n' + system.context }, ...msgs],
    }),
    parse: d => ({
      text: (d.choices?.[0]?.message?.content || '').trim(),
      usage: d.usage ? { in: d.usage.prompt_tokens, out: d.usage.completion_tokens } : null,
    }),
  },

  openrouter: {
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    url: () => 'https://openrouter.ai/api/v1/chat/completions',
    headers: k => ({
      Authorization: `Bearer ${k}`, 'content-type': 'application/json',
      'HTTP-Referer': 'https://aael.online', 'X-Title': 'AAEL Assistant',
    }),
    body: (model, system, msgs) => ({
      model, max_tokens: 700, temperature: 0.3,
      messages: [{ role: 'system', content: system.rules + '\n\n' + system.context }, ...msgs],
    }),
    parse: d => ({
      text: (d.choices?.[0]?.message?.content || '').trim(),
      usage: d.usage ? { in: d.usage.prompt_tokens, out: d.usage.completion_tokens } : null,
    }),
  },
};

/* ---------- 主函式 ---------- */
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const pName = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  const P = PROVIDERS[pName];
  if (!P) return res.status(500).json({ error: `未知的 AI_PROVIDER：${pName}` });

  const apiKey = process.env[P.envKey];
  if (!apiKey) return res.status(500).json({ error: `伺服器未設定 ${P.envKey}` });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { code, messages } = body || {};

  if (!process.env.AAEL_ACCESS_CODE || code !== process.env.AAEL_ACCESS_CODE) {
    return res.status(401).json({ error: '存取碼不正確' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '沒有收到問題' });
  }
  if (messages.length > MAX_TURNS * 2) {
    return res.status(400).json({ error: '對話過長，請重新開始' });
  }

  const last = messages[messages.length - 1];
  const question = String(last?.content || '').slice(0, MAX_Q);
  if (!question.trim()) return res.status(400).json({ error: '問題是空白的' });

  const hits = retrieve(question, 2);
  const context = hits.length
    ? `【參考資料 — AAEL 已發表文章】\n\n` +
      hits.map(a => `<article slug="${a.slug}" title="${a.title}">\n${a.text}\n</article>`).join('\n\n')
    : '【參考資料】本次未檢索到相關文章，請按一般認識回答，並嚴格遵守準確性規則。';

  const model = process.env.AAEL_MODEL || P.defaultModel;
  const msgs = messages.slice(-MAX_TURNS * 2).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, MAX_Q * 4),
  }));

  try {
    const r = await fetch(P.url(model), {
      method: 'POST',
      headers: P.headers(apiKey),
      body: JSON.stringify(P.body(model, { rules: SYSTEM, context }, msgs)),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error(`${pName} API error`, r.status, detail.slice(0, 500));

      // 模型名稱無效（404）時，嘗試列出這個 key 實際可用的模型，
      // 直接顯示喺錯誤訊息，方便一次過修正 AAEL_MODEL。
      let available = null;
      if (r.status === 404 && pName === 'gemini') {
        try {
          const lr = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
          );
          if (lr.ok) {
            const ld = await lr.json();
            available = (ld.models || [])
              .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
              .map(m => m.name.replace('models/', ''))
              .slice(0, 12);
          }
        } catch (_) { /* 列不到就算，不影響主錯誤訊息 */ }
      }

      return res.status(502).json({
        error: 'AI 服務暫時無法連接，請稍後再試。',
        hint: `${pName} 回傳 ${r.status}（目前設定的模型：${model}）`,
        available_models: available,
      });
    }

    const data = await r.json();
    const { text, usage } = P.parse(data);

    return res.status(200).json({
      reply: text || '未能產生回答，請換個問法再試。',
      sources: hits.map(a => ({ slug: a.slug, title: a.title })),
      usage, model, provider: pName,
    });
  } catch (e) {
    console.error('handler error', e);
    return res.status(500).json({ error: '發生錯誤，請稍後再試。' });
  }
}
