/**
 * ═══════════════════════════════════════════════════════════
 * AeroKG 单端口 HTTP 服务（零依赖 Node，Node 18+）
 * ───────────────────────────────────────────────────────────
 * 一个进程同时干两件事：
 *   ① 静态托管本站（index.html / js / css / data / vendor）
 *   ② 提供 /api/* 接口（AI 代理 + 笔记 / 卡片复习）
 *
 * 接口一览
 *   POST   /api/chat                    智谱代理（即时问答 / AI 学习路径）
 *   POST   /api/summarize/keywords       多关键词 AI 综述 + Mermaid 关系图
 *   GET    /api/notes                    笔记列表
 *   POST   /api/notes                    新建笔记
 *   GET    /api/notes/:id                笔记详情
 *   PUT    /api/notes/:id                编辑笔记
 *   DELETE /api/notes/:id                删除笔记
 *   GET    /api/notes/:id/cards          该笔记的卡片
 *   POST   /api/notes/:id/cards          生成卡片（带 cards 字段 = 保存编辑后的卡片）
 *   GET    /api/cards                    全部卡片
 *   GET    /api/cards/due                今日到期卡片
 *   POST   /api/cards                    手工新建卡片
 *   PUT    /api/cards/:id                编辑卡片
 *   DELETE /api/cards/:id                删除卡片
 *   POST   /api/cards/:id/review         提交复习结果（间隔重复）
 *   POST   /api/cards/:id/explain        答错后的 AI 解释
 *   POST   /api/cards/:id/quiz           AI 单选题（可选）
 *   GET    /api/stats                    汇总统计
 *   GET    /api/health                   健康检查（含知识图谱 / 存储 / 密钥状态）
 *
 * API Key 读取优先级：
 *   1) 环境变量 ZHIPU_API_KEY
 *   2) 同目录 server-config.json  { "zhipuApiKey": "..." }  ← 已被 .gitignore 排除
 *   3) 都没有 → AI 接口返回明确提示；笔记 / 复习功能不受影响（卡片可本地规则兜底）
 *
 * 启动：PORT=3000 node server.js      （必须监听 $PORT，绑定 0.0.0.0）
 * ═══════════════════════════════════════════════════════════
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

const llm = require('./server/llm');
const store = require('./server/store');
const kgdata = require('./server/kgdata');
const chat = require('./server/chat');
const summarize = require('./server/summarize');
const notes = require('./server/notes');
const cards = require('./server/cards');

/* ─────────── 静态资源 ─────────── */
// 绝不通过 HTTP 暴露的文件（server-config.json 含 API Key；server.js/package.json 属实现细节）
const BLOCKED_FILES = new Set([
  'server.js', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'server-config.json', 'server-config.example.json', 'vercel.json',
  'README.md', '.gitignore', '.env'
]);
// 绝不暴露的目录（服务端实现与数据文件）
const BLOCKED_DIRS = new Set(['server', '.data', '.git', 'node_modules']);

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
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/* 发送文件：媒体文件支持 HTTP Range（视频可拖动进度条 / 分段缓存） */
function sendFile(req, res, abs, buf) {
  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isMedia = /^(video|audio)\//.test(type);
  const range = req && req.headers && req.headers.range;

  if (isMedia && range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null && end !== null) { start = Math.max(0, buf.length - end); end = buf.length - 1; }
      if (start === null) start = 0;
      if (end === null || end >= buf.length) end = buf.length - 1;
      if (start > end || start >= buf.length) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + buf.length, 'Accept-Ranges': 'bytes' });
        return res.end();
      }
      const chunk = buf.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': chunk.length,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(chunk);
    }
  }

  // 缓存策略：只有"基本不变"的资源长缓存（第三方库、图片、媒体）；
  // 业务代码与数据（js/css/data/*）一律 no-cache —— 内容一更新浏览器立刻可见，
  // 避免出现"改了 kg.js 用户却看到旧数据"的问题。
  const seg0 = path.relative(ROOT, abs).split(path.sep)[0];
  const immutable = seg0 === 'vendor' || seg0 === 'public' || isMedia;
  const cacheCtl = (ext === '.html' || !immutable)
    ? 'no-cache'
    : 'public, max-age=604800, immutable';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Accept-Ranges': isMedia ? 'bytes' : 'none',
    'Cache-Control': cacheCtl,
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(buf);
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { return sendText(res, 400, 'Bad Request'); }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // 候选顺序：public/ 优先（约定的静态资源目录）→ 项目根
  // 于是「图片放 public/images/、前端写 /images/xx.png」两边都对得上
  const candidates = [
    path.normalize(path.join(ROOT, 'public', urlPath)),
    path.normalize(path.join(ROOT, urlPath))
  ];

  let i = 0;
  const tryNext = () => {
    if (i >= candidates.length) {
      if (urlPath === '/index.html') return sendText(res, 500, 'index.html 缺失');
      return sendText(res, 404, 'Not Found');
    }
    const abs = candidates[i++];

    // 路径穿越防护：解析后的绝对路径必须仍在项目目录内
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return tryNext();

    // 敏感文件 / 目录屏蔽（含 server-config.json —— 密钥绝不外泄）
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const segs = rel.split('/');
    if (BLOCKED_FILES.has(rel)
      || segs.some(seg => seg.startsWith('.'))
      || BLOCKED_DIRS.has(segs[0])) {
      return tryNext();
    }

    fs.readFile(abs, (err, buf) => {
      if (err || !buf) return tryNext();
      sendFile(req, res, abs, buf);
    });
  };
  tryNext();
}

/* ─────────── HTTP 辅助 ─────────── */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
  'Access-Control-Expose-Headers': 'Content-Length',
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

const MAX_BODY = 512 * 1024;   // 请求体上限 512KB
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
async function readJson(req) {
  let raw;
  try { raw = await readBody(req); }
  catch (e) { throw Object.assign(new Error(e.code === 413 ? '请求体过大' : '读取请求体失败'), { code: e.code === 413 ? 413 : 400 }); }
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { throw Object.assign(new Error('请求体不是合法 JSON'), { code: 400 }); }
}
function fail(res, err) {
  return sendJson(res, (err && err.code) || 400, { ok: false, error: (err && err.message) || '请求处理失败' });
}
function userOf(req) {
  return store.sanitizeUserId(req.headers['x-user-id'] || (new URL(req.url, 'http://x').searchParams.get('user_id') || ''));
}

const H = {
  CORS_HEADERS: CORS_HEADERS,
  sendJson: sendJson,
  sendText: sendText,
  readJson: readJson,
  fail: fail,
  userOf: userOf
};

/* ─────────── 路由表（顺序即优先级） ─────────── */
const ROUTES = [
  // GET /api/chat 是探活端点（不泄露密钥，只报告是否已配置），POST 才是真正的问答
  ['POST', '/api/chat', chat.handleChat],
  ['GET', '/api/chat', chat.handleChat],
  ['POST', '/api/summarize/keywords', summarize.keywords],

  ['GET', '/api/notes', notes.list],
  ['POST', '/api/notes', notes.create],
  ['GET', '/api/notes/:id/cards', notes.listCards],
  ['POST', '/api/notes/:id/cards', notes.cards],
  ['GET', '/api/notes/:id', notes.detail],
  ['PUT', '/api/notes/:id', notes.update],
  ['DELETE', '/api/notes/:id', notes.remove],

  ['GET', '/api/cards/due', cards.due],
  ['GET', '/api/cards', cards.list],
  ['POST', '/api/cards', cards.create],
  ['POST', '/api/cards/:id/review', cards.review],
  ['POST', '/api/cards/:id/explain', cards.explain],
  ['POST', '/api/cards/:id/quiz', cards.quiz],
  ['PUT', '/api/cards/:id', cards.update],
  ['DELETE', '/api/cards/:id', cards.remove],

  ['GET', '/api/stats', notes.stats],
  ['GET', '/api/health', health]
];

function match(pattern, pathname) {
  const ps = pattern.split('/'), xs = pathname.split('/');
  if (ps.length !== xs.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].charAt(0) === ':') {
      if (!xs[i]) return null;
      params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    } else if (ps[i] !== xs[i]) return null;
  }
  return params;
}

function health(req, res, params, h) {
  const kg = kgdata.meta();
  const s = store.stats(h.userOf(req));
  return h.sendJson(res, 200, {
    ok: true,
    service: 'aero-kg',
    uptime_s: Math.round(process.uptime()),
    kg: kg,
    llm: { configured: llm.configured(), models: llm.DEFAULT_MODELS, timeout_ms: llm.TIMEOUT_MS },
    store: { file: s.storage.file, error: s.storage.error, notes: s.notes, cards: s.cards, due: s.due }
  });
}

/* ─────────── 服务 ─────────── */
const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch (e) { pathname = req.url; }
  // 统一去掉尾部斜杠（/api/notes/ → /api/notes）
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');

  if (pathname.indexOf('/api/') === 0 || pathname === '/api') {
    // 所有 /api/* 都挂 CORS 头并统一处理预检
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    for (const [m, pattern, handler] of ROUTES) {
      if (m !== method) continue;
      const params = match(pattern, pathname);
      if (!params) continue;
      try {
        return await handler(req, res, params, H);
      } catch (err) {
        if (res.headersSent) return;
        return sendJson(res, 500, { ok: false, error: '服务端异常：' + ((err && err.message) || '未知错误') });
      }
    }
    // 路径存在但方法不对 → 405，便于排查
    const allowed = ROUTES.filter(r => match(r[1], pathname)).map(r => r[0]);
    if (allowed.length) {
      return sendJson(res, 405, { ok: false, error: `该接口只支持 ${allowed.join(' / ')}` });
    }
    return sendJson(res, 404, { ok: false, error: '未知接口', path: pathname });
  }

  return serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  const kg = kgdata.meta();
  console.log(`AeroKG server → http://0.0.0.0:${PORT}`);
  console.log(`  知识图谱：${kg.ok ? kg.nodes + ' 节点 / ' + kg.edges + ' 关系' : '加载失败：' + kg.error}`);
  console.log(`  AI 密钥：${llm.configured() ? '已配置' : '未配置（AI 接口会给出提示，笔记/复习仍可用）'}`);
  console.log(`  数据文件：${store._file.replace(/\\/g, '/')}`);
});
