// AAEL — Vercel 部署通知 → Discord
//
// 用途：每次 Vercel 部署成功／失敗，自動推送通知去 Discord 嘅
//       #🔔-website-updates 頻道。唔使你手動講「個網站啱啱update咗」。
//
// 運作原理：
//   1. 你 commit + push 去 GitHub
//   2. Vercel 自動開始部署
//   3. 部署完成（成功或失敗），Vercel 會 POST 一個通知去呢個 endpoint
//   4. 呢個 function 驗證簽名，攞出部署資訊，轉發做 Discord 訊息
//
// 環境變數（要加落 Vercel）：
//   VERCEL_WEBHOOK_SECRET — 設定 Vercel webhook 嗰陣佢會畀你嘅密鑰
//   DISCORD_WEBHOOK_URL   — 之前已經設定咗（discord-notify.mjs 用緊嗰個）
//
// 設定步驟（喺 Vercel Dashboard）：
//   1. 撳你個頭像 → 揀返你哋嘅 Team／Account scope
//   2. Settings → Webhooks → Create Webhook
//   3. Endpoint URL 填：https://aael.online/api/vercel-deploy-notify
//   4. Events 揀：Deployment Succeeded、Deployment Error
//   5. Projects 記得揀返「aael-website」呢個 project（唔好揀 All Team Projects，
//      否則你哋團隊其他 project 部署都會一齊推埋通知過嚟）
//   6. Create 完，Vercel 會顯示一個 Signing Secret——複製佢，
//      設做 Vercel 環境變數 VERCEL_WEBHOOK_SECRET

import crypto from 'node:crypto';
import { notifyDiscord } from './discord-notify.mjs';

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const hmac = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
  // constant-time comparison，避免 timing attack
  const a = Buffer.from(hmac);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: '伺服器未設定 VERCEL_WEBHOOK_SECRET' });
    return;
  }

  const rawBodyBuf = await readRawBody(req);
  const signature = req.headers['x-vercel-signature'];

  if (!verifySignature(rawBodyBuf, signature, secret)) {
    res.status(401).json({ error: '簽名驗證失敗' });
    return;
  }

  const body = JSON.parse(rawBodyBuf.toString('utf8'));
  const { type, payload } = body;

  const deployment = payload?.deployment;
  const projectName = payload?.project?.name || deployment?.name || 'aael-website';
  const url = deployment?.url ? `https://${deployment.url}` : undefined;
  const meta = deployment?.meta || {};
  const commitMsg = meta.githubCommitMessage || meta.gitCommitMessage;
  const commitSha = (meta.githubCommitSha || meta.gitCommitSha || '').slice(0, 7);
  const author = meta.githubCommitAuthorName || meta.gitCommitAuthorName;

  let title, color;
  if (type === 'deployment.succeeded') {
    title = `✅ ${projectName} 部署成功`;
    color = 0x2ecc71;
  } else if (type === 'deployment.error') {
    title = `❌ ${projectName} 部署失敗`;
    color = 0xe74c3c;
  } else {
    // 其他事件類型（例如 deployment.created）唔特別通知，靜靜回 200 即可
    res.status(200).json({ ok: true, skipped: true, type });
    return;
  }

  const fields = [];
  if (commitMsg) fields.push({ name: '更新內容', value: commitMsg.slice(0, 500), inline: false });
  if (author) fields.push({ name: '提交人', value: author, inline: true });
  if (commitSha) fields.push({ name: 'Commit', value: commitSha, inline: true });

  await notifyDiscord({ title, description: url ? `[查看網站](${url})` : undefined, color, fields });

  res.status(200).json({ ok: true });
}
