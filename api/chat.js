/**
 * ═══════════════════════════════════════════════════════════
 * Vercel Serverless Function — 智谱 AI 代理（api/chat.js）
 * ───────────────────────────────────────────────────────────
 * 路径     ：POST /api/chat（Vercel 自动识别 api/ 目录）
 * 作用     ：把前端请求转发给智谱开放平台，API Key 只存在
 *            服务端环境变量里，绝不暴露给浏览器。
 *
 * 请求体   ：{ "prompt": "用户问题", "context": "检索到的资料（可选）" }
 * 成功响应 ：{ "ok": true,  "answer": "AI 回答", "model": "glm-4-flash", "usage": {...} }
 * 失败响应 ：{ "ok": false, "error": "原因", "detail"?: "上游错误摘要" }
 *
 * 环境变量 ：ZHIPU_API_KEY —— 在 Vercel → Settings → Environment
 *            Variables 中添加，不要写死在本文件里。
 * ═══════════════════════════════════════════════════════════
 */

const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'glm-4-flash';
const MAX_PROMPT = 4000;    // prompt 长度上限（字符）
const MAX_CONTEXT = 12000;  // context 长度上限（字符）
const UPSTREAM_TIMEOUT = 28000; // 上游超时（毫秒）；注意 Vercel Hobby 平台默认 10s 上限

/* ── CORS 响应头 ── */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

module.exports = async function handler(req, res) {
  // 0) 统一挂 CORS 头（所有响应都带，浏览器才不会在正式响应上再报跨域）
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }

  // 1) 处理预检请求（浏览器发 OPTIONS 探路，这里直接放行）
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 2) 只接受 POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '仅支持 POST（浏览器会先发 OPTIONS 预检）' });
  }

  // 3) 读取服务端环境变量中的智谱 API Key（不写死、不下发前端）
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: '服务器未配置 ZHIPU_API_KEY。请到 Vercel → 项目 → Settings → Environment Variables 添加后重新部署。'
    });
  }

  // 4) 解析请求体（Vercel 通常已把 application/json 解析成对象；兼容字符串提交）
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: '请求体必须是 JSON 对象' });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const context = typeof body.context === 'string' ? body.context.trim() : '';
  // mode='path' 用于「AI 学习向导」的路径规划（要求严格 JSON 输出，不适用简洁约束）；默认 'qa' 即时问答
  const isPath = body.mode === 'path';
  if (!prompt) {
    return res.status(400).json({ ok: false, error: '缺少 prompt 字段（用户问题）' });
  }
  if (prompt.length > MAX_PROMPT) {
    return res.status(413).json({ ok: false, error: `prompt 超过 ${MAX_PROMPT} 字符上限` });
  }
  if (context.length > MAX_CONTEXT) {
    return res.status(413).json({ ok: false, error: `context 超过 ${MAX_CONTEXT} 字符上限` });
  }

  // 5) 组装消息：有资料时把资料和问题一起交给模型
  const userContent = context
    ? `【参考资料】\n${context}\n\n【用户问题】\n${prompt}`
    : prompt;

  // 两种用途用不同的系统提示：'path' 要求严格 JSON（不限制字数），'qa' 要求简洁
  const systemPrompt = isPath
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

  try {
    const upstream = await fetch(ZHIPU_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        temperature: isPath ? 0.3 : 0.6,
        max_tokens: isPath ? 1200 : 800,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ]
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT) // Node 18+ 内置，超时主动熔断
    });

    // 6) 上游报错：透传状态语义，但不下发任何密钥信息
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      const status = upstream.status === 401 || upstream.status === 403 ? 500 : 502;
      return res.status(status).json({
        ok: false,
        error: `智谱 API 返回 ${upstream.status}` +
               (upstream.status === 401 ? '（API Key 无效或过期）' : ''),
        detail: detail.slice(0, 300)
      });
    }

    // 7) 提取回答
    const data = await upstream.json();
    const answer = data && data.choices && data.choices[0] &&
                   data.choices[0].message && data.choices[0].message.content;
    if (!answer) {
      return res.status(502).json({
        ok: false,
        error: '智谱返回结构异常（未找到 choices[0].message.content）',
        detail: JSON.stringify(data).slice(0, 300)
      });
    }

    return res.status(200).json({
      ok: true,
      answer: answer,
      model: (data && data.model) || MODEL,
      usage: (data && data.usage) || null
    });

  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return res.status(isTimeout ? 504 : 502).json({
      ok: false,
      error: isTimeout ? '请求智谱超时，请稍后重试' : ('代理请求失败：' + ((err && err.message) || '未知网络错误'))
    });
  }
};
