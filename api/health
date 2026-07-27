// 診斷用：直接在瀏覽器開 https://aael.online/api/health
// 只顯示設定狀態，不會洩露任何 key 內容
export default function handler(req, res) {
  const providers = {
    gemini: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
  };
  const p = (process.env.AI_PROVIDER || '(未設定)').toLowerCase();
  const needed = providers[p];
  const keySet = needed ? !!process.env[needed] : false;
  const keyLen = needed && process.env[needed] ? process.env[needed].length : 0;

  const checks = [];
  checks.push({ 項目: 'API 函式運作', 狀態: '正常' });
  checks.push({ 項目: 'AI_PROVIDER', 狀態: p, 有效: p in providers });
  checks.push({ 項目: needed || '(視乎 AI_PROVIDER)', 狀態: keySet ? `已設定（長度 ${keyLen}）` : '未設定', 有效: keySet });
  checks.push({ 項目: 'AAEL_ACCESS_CODE', 狀態: process.env.AAEL_ACCESS_CODE ? '已設定' : '未設定', 有效: !!process.env.AAEL_ACCESS_CODE });
  checks.push({ 項目: 'AAEL_MODEL', 狀態: process.env.AAEL_MODEL || '(用預設)' });

  const allOk = (p in providers) && keySet && !!process.env.AAEL_ACCESS_CODE;
  const notes = [];
  if (!(p in providers)) notes.push('AI_PROVIDER 未設定或拼寫錯誤，只接受：gemini / openrouter / anthropic / openai');
  if (needed && !keySet) notes.push(`${needed} 未設定，或設定後未重新部署（Deployments → ⋯ → Redeploy）`);
  if (!process.env.AAEL_ACCESS_CODE) notes.push('AAEL_ACCESS_CODE 未設定');
  if (keySet && keyLen < 20) notes.push('API key 長度異常偏短，可能複製不完整');

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({
    結果: allOk ? '設定完整，可以開始測試' : '設定未完成，見下方 notes',
    checks,
    notes: notes.length ? notes : ['沒有發現問題'],
    node: process.version,
    time: new Date().toISOString(),
  });
}
