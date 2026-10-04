/**
 * ═══════════════════════════════════════════════════════════
 * POST /api/chat —— 智谱代理（即时问答 + AI 学习路径规划）
 * ───────────────────────────────────────────────────────────
 * 从 server.js 抽出（行为与抽出前逐字一致），只把「读密钥 / 调上游」
 * 换成共用封装 server/llm.js，避免到处复制 ZHIPU_URL。
 *
 * 请求体：{ prompt, context?, mode?: 'path' }
 * 响应  ：{ ok, answer, model, usage } / { ok:false, error, detail? }
 * ═══════════════════════════════════════════════════════════
 */
'use strict';
const llm = require('./llm');

const MAX_PROMPT = 4000;
const MAX_CONTEXT = 12000;
const MODEL = 'glm-4-flash';

/* 系统提示按用途分化：'path' 要求严格 JSON（不限制字数），默认 'qa' 要求简洁 */
function systemPrompt(isPath) {
  return isPath
    ? [
        '你是「航空航天知识图谱」网站的 AI 学习向导。',
        '任务：针对用户问题规划一条 4-6 站的学习路径（引导学习，不直接灌输答案），说明每一站解决什么。',
        '优先沿因果关系推进：先建立原理，再落到结构与限制，不要只罗列名词。',
        '只能使用【参考资料】中列出的概念，必须使用其括号内的英文 id，按学习先后排序。',
        '严格只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字，格式：',
        '{"title":"路径标题","intro":"一句话说明该路径为何能回答这个问题","steps":[{"id":"节点id","why":"这一站解决什么"}]}'
      ].join('')
    : [
        '你是「航空航天知识图谱」网站的 AI 学习助手。',
        '优先依据【参考资料】回答，并在合适时引用资料中的概念名与书页出处。',
        '资料不足以回答时，明确说明哪部分超出了资料范围，不要编造。',
        '回答要简洁聚焦：默认用 2-4 句话或要点列表直接回答问题，控制在 400 字以内；',
        '只有用户明确要求详细展开时才展开。'
      ].join('');
}

async function handleChat(req, res, params, h) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, h.CORS_HEADERS);
    return res.end();
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    // 便于人肉探活：不泄露任何密钥信息，只报告是否已配置
    return h.sendJson(res, 200, {
      ok: true,
      service: 'aero-kg-chat',
      model: MODEL,
      configured: llm.configured(),
      hint: 'POST { prompt, context } 获取 AI 回答'
    });
  }
  if (req.method !== 'POST') {
    return h.sendJson(res, 405, { ok: false, error: '仅支持 POST（浏览器会先发 OPTIONS 预检）' });
  }

  // 先校验入参（与密钥是否配置无关，保证诊断信息准确）
  let body;
  try { body = await h.readJson(req); } catch (e) { return h.fail(res, e); }
  if (!body || typeof body !== 'object') {
    return h.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const context = typeof body.context === 'string' ? body.context.trim() : '';
  const isPath = body.mode === 'path';
  if (!prompt) return h.sendJson(res, 400, { ok: false, error: '缺少 prompt 字段（用户问题）' });
  if (prompt.length > MAX_PROMPT) return h.sendJson(res, 413, { ok: false, error: `prompt 超过 ${MAX_PROMPT} 字符上限` });
  if (context.length > MAX_CONTEXT) return h.sendJson(res, 413, { ok: false, error: `context 超过 ${MAX_CONTEXT} 字符上限` });

  if (!llm.configured()) return h.sendJson(res, 500, { ok: false, error: llm.NO_KEY_HINT });

  const userContent = context ? `【参考资料】\n${context}\n\n【用户问题】\n${prompt}` : prompt;

  const r = await llm.callModel({
    model: MODEL,
    system: systemPrompt(isPath),
    user: userContent,
    temperature: isPath ? 0.3 : 0.6,
    maxTokens: isPath ? 1200 : 800,
    timeoutMs: llm.TIMEOUT_MS
  });

  if (!r.ok) {
    const status = (r.code === 'auth') ? 500
      : (r.code === 'timeout') ? 504
      : (r.code === 'no_key') ? 500
      : 502;
    return h.sendJson(res, status, { ok: false, error: r.error, detail: r.detail ? String(r.detail).slice(0, 300) : undefined });
  }
  return h.sendJson(res, 200, { ok: true, answer: r.text, model: MODEL, usage: r.usage || null });
}

module.exports = { handleChat, MAX_PROMPT, MAX_CONTEXT, MODEL, systemPrompt };
