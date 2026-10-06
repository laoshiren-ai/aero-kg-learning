/**
 * ═══════════════════════════════════════════════════════════
 * 节点知识卡片接口（给"没有本地示意图"的知识点用）
 * ───────────────────────────────────────────────────────────
 *   POST /api/node-card   入参 { id, name, category?, definition?, detail?, relations?[] }
 *
 * 处理顺序（缓存优先，绝不重复调 AI）：
 *   ① 用节点 id（或名称）当 key 查 store 里的 node_cards 缓存
 *      命中 → 直接返回 { ok, cached: true, card }
 *   ② 未命中 → 调智谱，提示词见 server/prompts.js 的 nodeCardUser()
 *   ③ 把纯文本按【定义】【核心公式】【关系解释】【例子】【常见误区】切成结构化字段
 *      （若模型额外给了【流程图】，顺带抽成 mermaid 代码）
 *   ④ 落库缓存 → 下一个人再点这个知识点就是 0 延迟
 *
 * 失败也不让前端空白：返回 { ok:false, reason, notice }，
 * 前端会用节点自身的教材原文兜底渲染一张卡片。
 * ═══════════════════════════════════════════════════════════
 */
'use strict';
const store = require('./store');
const llm = require('./llm');
const prompts = require('./prompts');

/* ── 缓存 key：优先节点 id（稳定），没有 id 就用名称 ── */
function cacheKey(id, name) {
  const k = String(id || '').trim() || String(name || '').trim();
  return k.toLowerCase().replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 80) || 'unknown';
}

/* ── 【标记】→ 字段名（顺序即优先级：流程图必须排在"关系"前面） ── */
const LABEL_MAP = [
  [/流程图|流程代码|关系图|结构图|图示/, 'mermaid'],
  [/定义|概念/, 'definition'],
  [/核心公式|公式/, 'formula'],
  [/关系解释|关系|联系/, 'relations'],
  [/例子|举例|示例/, 'example'],
  [/常见误区|误区|易错/, 'pitfalls']
];
function keyOfLabel(label) {
  const s = String(label).replace(/\s/g, '');
  for (let i = 0; i < LABEL_MAP.length; i++) if (LABEL_MAP[i][0].test(s)) return LABEL_MAP[i][1];
  return '';
}

/* ── 只保留像 Mermaid 流程图的那几行（渲染库还有 parse 兜底，这里先粗筛） ── */
function cleanMermaid(src) {
  let s = String(src || '').replace(/```[a-zA-Z]*/g, '').replace(/```/g, '').trim();
  if (!s) return '';
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
  const start = lines.findIndex(l => /^(graph|flowchart)\s+(TD|TB|LR|RL|BT)\b/i.test(l));
  if (start < 0) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length && out.length < 12; i++) {
    const t = lines[i];
    const ok = /^(subgraph|end|style|classDef|class|linkStyle|click)\b/i.test(t)
      || /-->|---|\[|\(|\{/.test(t);
    if (!ok) break;
    out.push(t);
  }
  return out.join('\n');
}

/* ── 纯文本 → 结构化卡片 ── */
function parseSections(text) {
  const raw = String(text || '')
    .replace(/\r/g, '')
    .replace(/^\s*```[a-zA-Z]*\s*$/gm, '')
    .trim();

  const out = { definition: '', formula: '', relations: '', example: '', pitfalls: '', mermaid: '' };
  const re = /【([^】\n]{1,14})】/g;
  const hits = [];
  let m;
  while ((m = re.exec(raw)) !== null) hits.push({ label: m[1], start: m.index, end: re.lastIndex });

  hits.forEach((h, i) => {
    const key = keyOfLabel(h.label);
    if (!key) return;
    const stop = (i + 1 < hits.length) ? hits[i + 1].start : raw.length;
    const val = raw.slice(h.end, stop).trim();
    if (!val) return;
    out[key] = out[key] ? (out[key] + '\n' + val) : val;
  });

  // 模型没按标记输出 → 整段当定义，至少不空白
  if (!out.definition && !out.relations && !out.example) {
    const plain = raw.replace(/【[^】\n]{1,14}】/g, '').trim();
    out.definition = (plain || raw).slice(0, 600);
  }
  out.mermaid = cleanMermaid(out.mermaid);
  return out;
}

/* ── 有没有真内容（防止"格式对了但全空"） ── */
function hasContent(card) {
  return !!(card.definition || card.relations || card.example || card.formula);
}

async function get(req, res, params, h) {
  let body;
  try { body = (await h.readJson(req)) || {}; }
  catch (e) { return h.fail(res, e); }
  if (!body || typeof body !== 'object') {
    return h.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
  }

  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return h.sendJson(res, 400, { ok: false, error: '缺少 name（知识点名称）' });
  const key = cacheKey(body.id, name);

  /* ① 缓存命中 —— 不调 AI */
  const hit = store.getNodeCard(key);
  if (hit && body.force !== true) {
    return h.sendJson(res, 200, { ok: true, cached: true, key: key, card: hit });
  }

  /* ② 未命中 → 调 AI */
  const context = [body.definition, body.detail]
    .filter(x => typeof x === 'string' && x.trim())
    .join(' ')
    .slice(0, 500);
  const relations = Array.isArray(body.relations)
    ? body.relations.map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 8)
    : [];

  const t0 = Date.now();
  const call = await llm.chat({
    system: prompts.NODE_CARD_SYSTEM,
    user: prompts.nodeCardUser({ name: name, context: context, relations: relations }),
    temperature: 0.55,
    maxTokens: 1000,
    models: ['glm-4-flash', 'glm-4-air'],
    accept: function (text) {
      return /【/.test(String(text)) && String(text).trim().length >= 40;
    }
  });

  if (!call.ok) {
    return h.sendJson(res, 200, {
      ok: false,
      key: key,
      reason: call.code,
      notice: call.code === 'no_key'
        ? '服务器还没配置 AI 密钥，暂时无法生成知识卡片。'
        : 'AI 暂时不可用（' + (call.error || '未知原因') + '），先用教材原文为你展示这个知识点。'
    });
  }

  const parsed = parseSections(call.text);
  if (!hasContent(parsed)) {
    return h.sendJson(res, 200, {
      ok: false, key: key, reason: 'rejected',
      notice: 'AI 返回的内容不完整，请稍后重试。'
    });
  }

  /* ③ 落库缓存（公共缓存，与用户无关） */
  const card = store.saveNodeCard(key, {
    name: name,
    definition: parsed.definition.slice(0, 800),
    formula: parsed.formula.slice(0, 400),
    relations: parsed.relations.slice(0, 900),
    example: parsed.example.slice(0, 500),
    pitfalls: parsed.pitfalls.slice(0, 600),
    mermaid: parsed.mermaid,
    text: String(call.text).trim().slice(0, 3000),
    source: 'ai',
    model: call.model
  });

  return h.sendJson(res, 200, {
    ok: true,
    cached: false,
    key: key,
    card: card,
    meta: { model: call.model, elapsedMs: Date.now() - t0, tried: call.tried }
  });
}

module.exports = { get, parseSections, cacheKey, cleanMermaid };
