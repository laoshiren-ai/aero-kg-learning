/**
 * ═══════════════════════════════════════════════════════════
 * POST /api/summarize/keywords —— 多关键词 AI 综述
 * ───────────────────────────────────────────────────────────
 * 请求：{ keywords: [..3-8..], relations: [{from,to,relation}], chapterId }
 * 流程：
 *   ① 按 keywords + chapterId 从知识图谱检索节点 → 两两关系 → 教材片段
 *   ② 套用内嵌系统提示词，调用智谱（glm-4-flash 失败降级 glm-4-air）
 *   ③ 解析 JSON；解析失败 / 无密钥 / 超时 → 返回**图谱兜底结构**（不报错）
 * 响应：{ ok, data:{title,summary,key_relations,example,misconceptions,mermaid,citations},
 *        meta:{ model, degraded, reason, notice, elapsedMs, resolved, unresolved, ... } }
 * ═══════════════════════════════════════════════════════════
 */
'use strict';
const kgdata = require('./kgdata');
const llm = require('./llm');
const prompts = require('./prompts');

const MIN_KEYWORDS = 3;
const MAX_KEYWORDS = 8;
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 60;
const cache = new Map();

function cacheKey(keywords, chapterId) {
  return (chapterId || '-') + '::' + keywords.slice().sort().join('|');
}

/* ── Mermaid 代码清洗：模型常给 ```mermaid 围栏或多余前言 ── */
function normalizeMermaid(raw, fallback) {
  let s = String(raw || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const i = s.search(/^\s*(graph|flowchart)\s/im);
  if (i > 0) s = s.slice(i);                        // 丢掉图代码之前的解释文字
  if (!/^\s*(graph|flowchart)\s+(TD|TB|LR|RL|BT)\b/im.test(s)) return fallback;
  // 需求规定只用 graph TD：把 flowchart/graph LR 之类统一成 graph TD
  s = s.replace(/^\s*(graph|flowchart)\s+(TD|TB|LR|RL|BT)\b[^\n]*/i, 'graph TD');
  // 去掉可能引发注入的 HTML 标签与首尾围栏
  s = s.replace(/<[^>]*>/g, '').split('\n').slice(0, 40).join('\n').trim();
  return s || fallback;
}

function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function arr(v, maxItem, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.map(x => str(x, maxItem)).filter(Boolean).slice(0, maxLen);
}

/**
 * 把模型输出规范成前端可用的结构。
 * 反幻觉：key_relations 只保留能对上「选中关键词之间的真实图谱关系」的组合；
 *         一条都对不上时，直接用图谱里真实存在的关系，而不是放任模型编。
 */
function normalizeData(raw, nodes, pairs) {
  const names = nodes.map(x => (x.node || x).name);
  const grounded = new Set();
  pairs.forEach(p => { grounded.add(p.from + '|' + p.to); grounded.add(p.to + '|' + p.from); });

  const relsIn = (raw && Array.isArray(raw.key_relations)) ? raw.key_relations : [];
  const kept = [], dropped = [];
  relsIn.forEach(r => {
    if (!r || typeof r !== 'object') return;
    const from = str(r.from, 60), to = str(r.to, 60);
    if (!from || !to) return;
    if (names.indexOf(from) < 0 || names.indexOf(to) < 0) { dropped.push(from + '→' + to); return; }
    if (!grounded.has(from + '|' + to)) { dropped.push(from + '→' + to); return; }
    kept.push({ from: from, to: to, relation: str(r.relation, 40) || '关联关系', explanation: str(r.explanation, 240) });
  });

  const keyRelations = kept.length
    ? kept
    : pairs.map(p => ({
        from: p.from, to: p.to, relation: p.relation,
        explanation: p.evidence || ('图谱中记录的' + p.relation)
      }));

  return {
    title: str(raw && raw.title, 120) || (names.slice(0, 4).join('、') + ' 的关系综述'),
    summary: str(raw && raw.summary, 3000),
    key_relations: keyRelations.slice(0, 12),
    example: str(raw && raw.example, 600),
    misconceptions: arr(raw && raw.misconceptions, 120, 3),
    mermaid: normalizeMermaid(raw && raw.mermaid, ''),
    citations: arr(raw && raw.citations, 120, 8),
    _dropped: dropped
  };
}

async function keywords(req, res, params, h) {
  const t0 = Date.now();
  let body;
  try { body = await h.readJson(req); } catch (e) { return h.fail(res, e); }
  if (!body || typeof body !== 'object') return h.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });

  const keywordsIn = Array.isArray(body.keywords) ? body.keywords.map(k => str(k, 60)).filter(Boolean) : [];
  const uniq = Array.from(new Set(keywordsIn));
  if (uniq.length < MIN_KEYWORDS) {
    return h.sendJson(res, 400, { ok: false, error: `至少需要 ${MIN_KEYWORDS} 个关键词（收到 ${uniq.length} 个）` });
  }
  if (uniq.length > MAX_KEYWORDS) {
    return h.sendJson(res, 400, { ok: false, error: `最多支持 ${MAX_KEYWORDS} 个关键词（收到 ${uniq.length} 个）` });
  }

  const cid = cacheKey(uniq, body.chapterId);
  const hit = cache.get(cid);
  if (hit && Date.now() - hit.t < CACHE_TTL) {
    return h.sendJson(res, 200, Object.assign({}, hit.payload, {
      meta: Object.assign({}, hit.payload.meta, { cached: true, elapsedMs: Date.now() - t0 })
    }));
  }

  /* ① 本地检索：节点 → 两两关系 → 教材片段 */
  const resolved = kgdata.resolve(uniq, body.chapterId);
  const nodes = resolved.nodes;
  const pairs = nodes.length ? kgdata.pairRelations(nodes, body.relations) : [];
  const context = nodes.length ? kgdata.buildContext(nodes, pairs) : '';
  const fallbackMermaid = nodes.length ? kgdata.fallbackMermaid(nodes, pairs) : 'graph TD\n  n0["未在图谱中找到这些概念"]';

  const metaBase = {
    cached: false,
    chapterId: str(body.chapterId, 40) || '',
    resolved: nodes.map(x => ({ keyword: x.keyword, id: x.node.id, name: x.node.name, chapterMatch: x.chapterMatch })),
    unresolved: resolved.unresolved,
    relations: pairs.length,
    relation_list: pairs.map(p => p.from + '→' + p.to + '（' + p.relation + '）'),
    graph: kgdata.meta()
  };

  /* ② 调 AI（含模型降级）；没有素材或没有密钥 → 直接走兜底 */
  let degraded = false, reason = '', notice = '', model = '', tried = [], dropped = [];
  let data = null;

  if (!nodes.length) {
    degraded = true; reason = 'no_material';
    notice = '知识图谱里没有匹配到这些关键词，无法生成基于教材的综述。请从「我的足迹」里选择图谱中已有的概念。';
    data = kgdata.fallbackSummary([], []);
  } else {
    const call = await llm.chat({
      system: prompts.summarizeSystem({
        keywords: uniq,
        relations: pairs.map(p => ({ from: p.from, to: p.to, relation: p.relation, evidence: p.evidence })),
        context: context
      }),
      user: '请按上述要求生成关系综述，只输出 JSON。',
      temperature: 0.45,
      maxTokens: 1000,
      models: ['glm-4-flash', 'glm-4-air'],
      accept: function (text) {
        const j = llm.extractJson(text, 'object');
        return !!(j && (j.summary || j.title));
      }
    });
    tried = call.tried;
    if (call.ok) {
      model = call.model;
      const parsed = llm.extractJson(call.text, 'object');
      const norm = normalizeData(parsed, nodes, pairs);
      dropped = norm._dropped;
      delete norm._dropped;
      data = norm;
      if (!data.mermaid) data.mermaid = fallbackMermaid;
      if (!data.mermaid) data.mermaid = fallbackMermaid;
    } else {
      degraded = true;
      reason = call.code || 'upstream';
      notice = ({
        no_key: '服务器还没有配置 AI 密钥，下面是用知识图谱直接拼出的离线版综述（未经 AI 润色）。',
        auth: 'AI 密钥无效或已过期，下面是用知识图谱直接拼出的离线版综述。',
        timeout: 'AI 响应超时，下面是用知识图谱直接拼出的离线版综述。',
        rejected: 'AI 返回的内容不符合要求格式，下面是用知识图谱直接拼出的离线版综述。'
      })[reason] || 'AI 服务暂时不可用，下面是用知识图谱直接拼出的离线版综述。';
      data = kgdata.fallbackSummary(nodes, pairs);
    }
    if (!data.mermaid) data.mermaid = fallbackMermaid;
  }

  const payload = {
    ok: true,
    data: data,
    meta: Object.assign({}, metaBase, {
      model: model,
      degraded: degraded,
      reason: reason,
      notice: notice,
      dropped_relations: dropped,
      tried: tried,
      elapsedMs: Date.now() - t0
    })
  };

  if (!degraded) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(cid, { t: Date.now(), payload: payload });
  }
  return h.sendJson(res, 200, payload);
}

module.exports = { keywords: keywords, _normalizeMermaid: normalizeMermaid, _normalizeData: normalizeData, _cache: cache };
