// AAEL — 記錄／統計共用輔助（Upstash 讀寫 + CSV 匯出）
// 放喺 lib/ 唔計入 Vercel Hobby Plan 嘅 12 個 serverless function 名額。
// 用家：api/discord-interactions.mjs（/lookup /pending /done /note /whois /export /wipe /stats）
//       api/weekly-stats.mjs（每週自動 CSV 備份）
//       api/inquiry.mjs（shortId 顯示喺通知度）

export function upstashConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, headers: { Authorization: `Bearer ${token}` } };
}

export function hkToday(offsetDays = 0) {
  // 香港時間（UTC+8）日期，同 chat.mjs／track-pageview.mjs 保持一致
  return new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * 86400000).toISOString().slice(0, 10);
}

export async function readCount(cfg, key) {
  try {
    const r = await fetch(`${cfg.url}/get/${key}`, { headers: cfg.headers });
    const d = await r.json();
    return d.result ? parseInt(d.result, 10) : 0;
  } catch {
    return 0;
  }
}

export async function readList(cfg, key) {
  try {
    const r = await fetch(`${cfg.url}/lrange/${key}/0/-1`, { headers: cfg.headers });
    const d = await r.json();
    return (d.result || []).map((q) => decodeURIComponent(q));
  } catch {
    return [];
  }
}

export async function readTopPages(cfg, key, limit = 5) {
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

/* ---------- 查詢／BHU 登記記錄 ---------- */

export async function loadAllRecords() {
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

export async function saveRecord(prefix, id, rec) {
  const cfg = upstashConfig();
  if (!cfg) return false;
  const r = await fetch(`${cfg.url}/set/aael:${prefix}:${id}`, {
    method: 'POST',
    headers: { ...cfg.headers, 'Content-Type': 'text/plain' },
    body: JSON.stringify(rec),
  });
  return r.ok;
}

export async function deleteRecord(prefix, id) {
  const cfg = upstashConfig();
  if (!cfg) return false;
  const r1 = await fetch(`${cfg.url}/del/aael:${prefix}:${id}`, { headers: cfg.headers });
  await fetch(`${cfg.url}/srem/aael:${prefix}:index/${id}`, { headers: cfg.headers }).catch(() => {});
  return r1.ok;
}

// 記錄嘅短編號：id 格式係 `${timestamp}-${六位隨機字串}`，攞後面嗰段做人手輸入用嘅短編號
export function shortId(id) {
  const parts = String(id).split('-');
  return parts[parts.length - 1] || id;
}

/* ---------- CSV 匯出（Excel 直接開得） ---------- */

function csvCell(v) {
  const s = String(v ?? '');
  return '"' + s.replace(/"/g, '""') + '"';
}

export function recordsToCsv(records) {
  const header = ['類別', '編號', '狀態', '姓名／公司', '聯絡方式', '樓宇地址', '單位數目', '認證屆滿日期', '認證簽發方', '查詢內容', '跟進備註', '登記時間', '完成時間'];
  const rows = records.map(({ id, rec }) => [
    rec.type === 'bhu-renewal' ? 'BHU續期登記' : '一般查詢',
    shortId(id),
    rec.status === 'done' ? '已完成' : '未跟進',
    rec.name || '',
    rec.contact || '',
    rec.address || '',
    rec.units || '',
    rec.expiry || '',
    rec.issuer || '',
    rec.message || '',
    (rec.notes || []).map((n) => `[${(n.at || '').slice(0, 10)}] ${n.text}`).join('；'),
    (rec.registeredAt || '').slice(0, 19).replace('T', ' '),
    (rec.doneAt || '').slice(0, 19).replace('T', ' '),
  ]);
  // \ufeff = UTF-8 BOM，冇咗佢 Excel 開中文會亂碼
  return '\ufeff' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
