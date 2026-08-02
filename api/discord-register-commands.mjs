// AAEL Discord Bot — 一次性指令註冊端點（伺服器對伺服器版本）
//
// 用途：唔使喺自己電腦跑 node script，直接喺瀏覽器（手機／iPad都得）
//       開一條網址就可以觸發註冊。呢個 function 喺 Vercel 伺服器度
//       同 Discord API 講嘢，唔經瀏覽器，所以完全冇 CORS 問題。
//
// 環境變數（要喺 Vercel 度加齊）：
//   DISCORD_APP_ID          — Discord Application ID
//   DISCORD_BOT_TOKEN       — Discord Bot Token（第四步攞到嗰個）
//   DISCORD_REGISTER_SECRET — 你自己隨便諗一個密碼（防止其他人亂 hit 呢條網址）
//
// 用法：
//   1. 喺 Vercel 加齊上面三個環境變數，然後等 Vercel redeploy
//   2. 喺瀏覽器（Safari／Chrome，手機／iPad都得）開：
//      https://aael.online/api/discord-register-commands?secret=你設定嘅密碼
//   3. 見到 JSON 顯示 "ok": true 就代表註冊成功
//   4. 呢個 function 之後可以留喺度，或者用完之後喺 GitHub 刪走都得——
//      唔會影響 bot 已經註冊咗嘅指令。

export default async function handler(req, res) {
  const APP_ID = process.env.DISCORD_APP_ID;
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  const SECRET = process.env.DISCORD_REGISTER_SECRET;

  if (!APP_ID || !BOT_TOKEN || !SECRET) {
    res.status(500).json({
      ok: false,
      error: '伺服器未設定齊 DISCORD_APP_ID / DISCORD_BOT_TOKEN / DISCORD_REGISTER_SECRET',
    });
    return;
  }

  if (req.query.secret !== SECRET) {
    res.status(401).json({ ok: false, error: '密碼不正確（?secret=... 對唔上）' });
    return;
  }

  const commands = [
    {
      name: 'kb',
      description: '喺 AAEL 知識庫搜尋相關文章',
      options: [
        {
          name: 'query',
          description: '關鍵字，例如「簡樸房水錶」或「拆牆」',
          type: 3,
          required: true,
        },
      ],
    },
    {
      name: 'article',
      description: '用 slug 直接攞返一篇文章嘅連結',
      options: [
        {
          name: 'slug',
          description: '文章 slug，例如 guide-bhu-timeline（可省略 guide- 前綴）',
          type: 3,
          required: true,
        },
      ],
    },
    { name: 'deadline', description: '查簡樸房寬限期登記截止仲有幾多日' },
    {
      name: 'status',
      description: '查網站 API 設定狀態（只有你自己見到）',
      default_member_permissions: '8', // 8 = ADMINISTRATOR，限管理員先見到／用得到呢個指令
    },
    {
      name: 'lookup',
      description: '搜返已儲存嘅查詢／BHU登記記錄（管理員限定）',
      default_member_permissions: '8',
      options: [
        {
          name: 'query',
          description: '姓名、聯絡方式或地址嘅關鍵字',
          type: 3,
          required: true,
        },
      ],
    },
    { name: 'help', description: '列出所有可用指令' },
    { name: 'contact', description: '顯示 AAEL 聯絡資料' },
    {
      name: 'competitor-news',
      description: '用 AI 網上搜尋，睇下簡樸房市場／競爭對手最近有咩動態',
    },
  ];

  try {
    const r = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });

    const data = await r.json();

    if (!r.ok) {
      res.status(r.status).json({ ok: false, error: data });
      return;
    }

    res.status(200).json({
      ok: true,
      message: `已註冊 ${data.length} 個指令`,
      commands: data.map((c) => '/' + c.name),
      note: '全域指令最多要等 1 小時先喺所有伺服器見到。',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
