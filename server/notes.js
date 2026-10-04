/**
 * ═══════════════════════════════════════════════════════════
 * 笔记本接口
 * ───────────────────────────────────────────────────────────
 *   GET    /api/notes            笔记列表（含卡片数 / 到期数）
 *   POST   /api/notes            新建笔记
 *   GET    /api/notes/:id        笔记详情（含卡片）
 *   PUT    /api/notes/:id        编辑笔记
 *   DELETE /api/notes/:id        删除笔记（级联删卡片与复习日志）
 *   POST   /api/notes/:id/cards  生成卡片（带 cards 字段 = 保存编辑后的卡片）
 *   GET    /api/notes/:id/cards  该笔记的卡片列表
 *   GET    /api/stats            汇总数字（nav 角标用）
 * ═══════════════════════════════════════════════════════════
 */
'use strict';
const store = require('./store');
const llm = require('./llm');
const prompts = require('./prompts');

const MAX_CARDS_PER_NOTE = 40;

/* ── 本地兜底拆卡：AI 不可用时，用规则从笔记文本里粗略拆出卡片（可编辑后再保存） ── */
function localCards(content, max) {
  const text = String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')        // 去掉 mermaid 等代码块
    .replace(/[#>*`]/g, ' ')
    .trim();
  const out = [];

  // ① 「概念：解释」形式
  text.split(/\n+/).forEach(line => {
    const m = line.match(/^\s*([^：:]{2,30})\s*[：:]\s*(.{4,})$/);
    if (m && out.length < max) {
      out.push({ front: m[1].trim() + '是什么？', back: m[2].trim().slice(0, 140), tags: ['笔记摘录'] });
    }
  });

  // ② 句子形式（内容不足时补充）
  if (out.length < 2) {
    text.split(/[。；;!?！？\n]+/).map(s => s.trim()).filter(s => s.length >= 10).slice(0, max).forEach(s => {
      if (out.length >= max) return;
      const cut = s.length > 24 ? s.slice(0, 24) + '…' : s;
      out.push({ front: '请回忆：「' + cut + '」的后半句讲了什么？', back: s.slice(0, 140), tags: ['笔记摘录'] });
    });
  }
  return out.slice(0, max);
}

function sanitizeDraft(d) {
  if (!d || typeof d !== 'object') return null;
  const front = typeof d.front === 'string' ? d.front.trim().slice(0, 400) : '';
  const back = typeof d.back === 'string' ? d.back.trim().slice(0, 1200) : '';
  if (!front || !back) return null;
  const tags = Array.isArray(d.tags)
    ? d.tags.map(t => String(t).trim().slice(0, 32)).filter(Boolean).slice(0, 8)
    : [];
  return { front: front, back: back, tags: tags };
}

/* ── 列表 ── */
function list(req, res, params, h) {
  const u = h.userOf(req);
  return h.sendJson(res, 200, { ok: true, notes: store.listNotes(u), stats: store.stats(u) });
}

/* ── 详情 ── */
function detail(req, res, params, h) {
  const u = h.userOf(req);
  const n = store.getNote(u, params.id);
  if (!n) return h.sendJson(res, 404, { ok: false, error: '笔记不存在或不属于当前用户' });
  return h.sendJson(res, 200, { ok: true, note: n });
}

/* ── 新建 ── */
async function create(req, res, params, h) {
  const u = h.userOf(req);
  let body;
  try { body = await h.readJson(req); } catch (e) { return h.fail(res, e); }
  if (!body || typeof body !== 'object') return h.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
  if (!String(body.content || '').trim() && !String(body.title || '').trim()) {
    return h.sendJson(res, 400, { ok: false, error: 'title 与 content 不能同时为空' });
  }
  const note = store.createNote(u, body);
  return h.sendJson(res, 201, { ok: true, note: note });
}

/* ── 编辑 ── */
async function update(req, res, params, h) {
  const u = h.userOf(req);
  let body;
  try { body = await h.readJson(req); } catch (e) { return h.fail(res, e); }
  if (!body || typeof body !== 'object') return h.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
  const note = store.updateNote(u, params.id, body);
  if (!note) return h.sendJson(res, 404, { ok: false, error: '笔记不存在或不属于当前用户' });
  return h.sendJson(res, 200, { ok: true, note: note });
}

/* ── 删除 ── */
function remove(req, res, params, h) {
  const u = h.userOf(req);
  const ok = store.deleteNote(u, params.id);
  if (!ok) return h.sendJson(res, 404, { ok: false, error: '笔记不存在或不属于当前用户' });
  return h.sendJson(res, 200, { ok: true, deleted: params.id });
}

/* ── 该笔记的卡片 ── */
function listCards(req, res, params, h) {
  const u = h.userOf(req);
  if (!store.getNote(u, params.id)) return h.sendJson(res, 404, { ok: false, error: '笔记不存在或不属于当前用户' });
  return h.sendJson(res, 200, { ok: true, cards: store.listCards(u, params.id) });
}

/* ── 生成 / 保存卡片 ──
   请求体 cards 存在 → 保存这些（前端"编辑后再保存"）
   请求体无 cards   → AI 生成草稿（save=true 时同时落库） */
async function cards(req, res, params, h) {
  const u = h.userOf(req);
  const note = store.getNote(u, params.id);
  if (!note) return h.sendJson(res, 404, { ok: false, error: '笔记不存在或不属于当前用户' });

  let body = {};
  try { body = (await h.readJson(req)) || {}; } catch (e) { return h.fail(res, e); }
  if (typeof body !== 'object' || body === null) body = {};

  /* A. 保存模式：前端把编辑后的卡片送回来 */
  if (Array.isArray(body.cards)) {
    const drafts = body.cards.map(sanitizeDraft).filter(Boolean).slice(0, MAX_CARDS_PER_NOTE);
    if (!drafts.length) return h.sendJson(res, 400, { ok: false, error: 'cards 里没有合法卡片（front / back 均不能为空）' });
    if (store.listCards(u, note.id).length + drafts.length > MAX_CARDS_PER_NOTE) {
      return h.sendJson(res, 400, { ok: false, error: `单条笔记最多 ${MAX_CARDS_PER_NOTE} 张卡片` });
    }
    const saved = store.addCards(u, note.id, drafts);
    return h.sendJson(res, 201, { ok: true, mode: 'saved', cards: saved, note: store.getNote(u, note.id) });
  }

  /* B. 生成模式 */
  const t0 = Date.now();
  const content = (note.content || '').slice(0, 6000);
  let drafts = [], model = '', degraded = false, reason = '', notice = '', tried = [];

  if (!content.trim()) {
    return h.sendJson(res, 400, { ok: false, error: '笔记内容为空，无法生成卡片' });
  }

  const call = await llm.chat({
    system: prompts.CARDS_SYSTEM,
    user: prompts.cardsUser(content),
    temperature: 0.3,
    maxTokens: 1400,
    models: ['glm-4-flash', 'glm-4-air'],
    accept: function (text) { const j = llm.extractJson(text, 'array'); return Array.isArray(j) && j.length > 0; }
  });
  tried = call.tried;
  if (call.ok) {
    const parsed = llm.extractJson(call.text, 'array');
    drafts = (Array.isArray(parsed) ? parsed : []).map(sanitizeDraft).filter(Boolean).slice(0, 8);
    model = call.model;
    if (!drafts.length) { degraded = true; reason = 'rejected'; }
  } else {
    degraded = true;
    reason = call.code || 'upstream';
  }
  if (!drafts.length) {
    drafts = localCards(content, 6);
    if (!drafts.length) {
      return h.sendJson(res, 200, {
        ok: true, mode: 'generated', cards: [], degraded: true, reason: reason || 'no_content',
        notice: '这条笔记的内容太少，拆不出卡片。补充一些具体知识点后再试。', meta: { tried: tried, elapsedMs: Date.now() - t0 }
      });
    }
    notice = ({
      no_key: '服务器还没配置 AI 密钥，下面是用本地规则粗略拆出的卡片，请编辑后再保存。',
      auth: 'AI 密钥无效，下面是用本地规则粗略拆出的卡片，请编辑后再保存。',
      timeout: 'AI 响应超时，下面是用本地规则粗略拆出的卡片，请编辑后再保存。'
    })[reason] || 'AI 暂时不可用，下面是用本地规则粗略拆出的卡片，请编辑后再保存。';
    model = '';
  }

  if (body.save === true) {
    const saved = store.addCards(u, note.id, drafts);
    return h.sendJson(res, 201, {
      ok: true, mode: 'saved', cards: saved, degraded: degraded, notice: notice, model: model,
      note: store.getNote(u, note.id), meta: { tried: tried, elapsedMs: Date.now() - t0 }
    });
  }

  return h.sendJson(res, 200, {
    ok: true, mode: 'generated', cards: drafts, degraded: degraded, reason: reason,
    notice: notice, model: model, meta: { tried: tried, elapsedMs: Date.now() - t0 }
  });
}

function stats(req, res, params, h) {
  return h.sendJson(res, 200, { ok: true, stats: store.stats(h.userOf(req)) });
}

module.exports = { list, detail, create, update, remove, listCards, cards, stats, _localCards: localCards };
