/**
 * ═══════════════════════════════════════════════════════════
 * AeroKG 单端口 HTTP 服务（零依赖 Node，Node 18+）
 * ───────────────────────────────────────────────────────────
 * 一个进程同时干两件事：
 *   ① 静态托管本站（index.html / js / css / data / vendor）
 *   ② POST /api/chat —— 智谱 glm-4-flash 代理（前端不接触 API Key）
 *
 * API Key 读取优先级：
 *   1) 环境变量 ZHIPU_API_KEY
 *   2) 同目录 server-config.json  { "zhipuApiKey": "..." }  ← 已被 .gitignore 排除
 *   3) 都没有 → /api/chat 返回 500，并提示如何配置；页面其余功能不受影响
 *
 * 启动：PORT=3000 node server.js      （必须监听 $PORT，绑定 0.0.0.0）
 * ═══════════════════════════════════════════════════════════
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'glm-4-flash';
const MAX_PROMPT = 4000;
const MAX_CONTEXT = 12000;
const MAX_BODY = 512 * 1024;         // 请求体上限 512KB
const UPSTREAM_TIMEOUT = 28000;

/* ── 密钥 ── */
function loadApiKey() {
  if (process.env.ZHIPU_API_KEY && process.env.ZHIPU_API_KEY.trim()) {
    return process.env.ZHIPU_API_KEY.trim();
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server-config.json'), 'utf8'));
    if (cfg && typeof cfg.zhipuApiKey === 'string' && cfg.zhipuApiKey.trim()) return cfg.zhipuApiKey.trim();
  } catch (e) { /* 文件不存在或格式错误 → 视为未配置 */ }
  return '';
}

/* ── 静态资源 ── */
// 绝不通过 HTTP 暴露的文件（server-config.json 含 API Key；server.js/package.json 属实现细节）
const BLOCKED_FILES = new Set([
  'server.js', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'server-config.json', 'server-config.example.json', 'vercel.json',
  'README.md', '.gitignore', '.env'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { return sendText(res, 400, 'Bad Request'); }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // 路径穿越防护：解析后的绝对路径必须仍在项目目录内
  const abs = path.normalize(path.join(ROOT, urlPath));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  // 敏感文件屏蔽（含 server-config.json —— 密钥绝不外泄）
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (BLOCKED_FILES.has(rel) || rel.split('/').some(seg => seg.startsWith('.'))) {
    return sendText(res, 404, 'Not Found');
  }

  fs.readFile(abs, (err, buf) => {
    if (err) {
      if (urlPath === '/index.html') return sendText(res, 500, 'index.html 缺失');
      return sendText(res, 404, 'Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': path.extname(abs) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
  });
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/* ── JSON 工具 ── */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  }, CORS_HEADERS));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body_too_large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ── /api/chat ── */
async function handleChat(req, res) {
  // 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    // 便于人肉探活：不泄露任何密钥信息，只报告是否已配置
    return sendJson(res, 200, {
      ok: true,
      service: 'aero-kg-chat',
      model: MODEL,
      configured: !!loadApiKey(),
      hint: 'POST { prompt, context } 获取 AI 回答'
    });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: '仅支持 POST（浏览器会先发 OPTIONS 预检）' });
  }

  // 先校验入参（与密钥是否配置无关，保证诊断信息准确）
  let raw;
  try { raw = await readBody(req); }
  catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { ok: false, error: e.code === 413 ? '请求体过大' : '读取请求体失败' }); }

  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const context = typeof body.context === 'string' ? body.context.trim() : '';
  if (!prompt) return sendJson(res, 400, { ok: false, error: '缺少 prompt 字段（用户问题）' });
  if (prompt.length > MAX_PROMPT) return sendJson(res, 413, { ok: false, error: `prompt 超过 ${MAX_PROMPT} 字符上限` });
  if (context.length > MAX_CONTEXT) return sendJson(res, 413, { ok: false, error: `context 超过 ${MAX_CONTEXT} 字符上限` });

  const apiKey = loadApiKey();
  if (!apiKey) {
    return sendJson(res, 500, {
      ok: false,
      error: '服务器未配置 AI 密钥：请设置环境变量 ZHIPU_API_KEY，或在项目根目录创建 server-config.json（{"zhipuApiKey":"..."}）'
    });
  }

  const userContent = context ? `【参考资料】\n${context}\n\n【用户问题】\n${prompt}` : prompt;

  try {
    const upstream = await fetch(ZHIPU_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        temperature: 0.6,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: '你是一个严谨的航空航天学习助手。优先依据参考资料回答；资料不足以回答时，明确说明哪些部分超出了资料范围，不要编造。' },
          { role: 'user', content: userContent }
        ]
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT)
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      const status = (upstream.status === 401 || upstream.status === 403) ? 500 : 502;
      return sendJson(res, status, {
        ok: false,
        error: `智谱 API 返回 ${upstream.status}` + (upstream.status === 401 ? '（API Key 无效或过期）' : ''),
        detail: detail.slice(0, 300)
      });
    }

    const data = await upstream.json();
    const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!answer) {
      return sendJson(res, 502, {
        ok: false,
        error: '智谱返回结构异常（未找到 choices[0].message.content）',
        detail: JSON.stringify(data).slice(0, 300)
      });
    }
    return sendJson(res, 200, { ok: true, answer: answer, model: (data && data.model) || MODEL, usage: (data && data.usage) || null });
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return sendJson(res, isTimeout ? 504 : 502, {
      ok: false,
      error: isTimeout ? '请求智谱超时，请稍后重试' : ('代理请求失败：' + ((err && err.message) || '未知网络错误'))
    });
  }
}

/* ── 服务 ── */
const server = http.createServer((req, res) => {
  const pathname = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch (e) { return req.url; } })();

  if (pathname === '/api/chat' || pathname === '/api/chat/') return handleChat(req, res);
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: '未知接口' });
  return serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  const has = !!loadApiKey();
  console.log(`AeroKG server → http://0.0.0.0:${PORT}  (AI 密钥：${has ? '已配置' : '未配置，/api/chat 将返回 500 提示'}）`);
});
