/**
 * ═══════════════════════════════════════════════════════════
 * 知识卡片复习接口
 * ───────────────────────────────────────────────────────────
 *   GET    /api/cards                全部卡片
 *   GET    /api/cards/due            今日到期卡片（含三档预测）
 *   POST   /api/cards                手工新建卡片
 *   PUT    /api/cards/:id            编辑卡片
 *   DELETE /api/cards/:id            删除卡片
 *   POST   /api/cards/:id/review     提交复习结果（again/hard/good）→ 更新 due
 *   POST   /api/cards/:id/explain    答错后 AI 解释
 *   POST   /api/cards/:id/quiz       AI 生成单选题（可选功能）
 * ═══════════════════════════════════════════════════════════
 */
'use strict';
const store = require('./store');
const llm = require('./llm');
const prompts = require('./prompts');

const RATING_LABEL = { again: '忘了', hard: '模糊', good: '记得' };

/* 给前端看的"如果这样评，下次什么时候见" */
function preview(card) {
  const p = {};
  ['again', 'hard', 'good'].forEach(r => {
    const s = store.previewSchedule(card, r);
    p[r] = { interval: s.interval, due: s.due, ease: s.ease };
  });
  return p;
}
function withNote(card) {
  const note = store.getNote(card.user_id, card.note_id);
  return Object.assign({}, card, { note_title: note ? note.title : '' });
}

function list(req, res, params, h) {
  const u = h.userOf(req);
  const q = new URL(req.url, 'http://x').searchParams;
  const cards = store.listCards(u, q.get('note_id') || '').map(withNote);
  return h.sendJson(res, 200, { ok: true, cards: cards, stats: store.stats(u) });
}

/* ── 今日到期 ── */
function due(req, res, params, h) {
  const u = h.userOf(req);
  const q = new URL(req.url, 'http://x').searchParams;
  const limit = Math.min(Number(q.get('limit') || 50), 200);
  const noteId = q.get('note_id') || '';
  let cards = store.dueCards(u);
  if (noteId) cards = cards.filter(c => c.note_id === noteId);
  const total = cards.length;
  cards = cards.slice(0, limit).map(c => Object.assign(withNote(c), { preview: preview(c) }));
  return h.sendJson(res, 200, { ok: true, cards: cards, total_due: total, stats: store.stats(u) });
}

async function create(req, res, params, h) {
  const u = h.userOf(req);
  let body;
  try { body = await h.readJson(req); } catch (e) { return h.fail(res, e); }
  if (!body || typeof body !== 'object') return h.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
  if (!String(body.front || '').trim() || !String(body.back || '').trim()) {
    return h.sendJson(res, 400, { ok: false, error: 'front 与 back 都不能为空' });
  }
  const noteId = String(body.note_id || '');
  if (noteId && !store.getNote(u, noteId)) return h.sendJson(res, 404, { ok: false, error: 'note_id 对应的笔记不存在' });
  const saved = store.addCards(u, noteId, [body]);
  return h.sendJson(res, 201, { ok: true, card: saved[0] });
}

async function update(req, res, params, h) {
  const u = h.userOf(req);
  let body;
  try { body = await h.readJson(req); } catch (e) { return h.fail(res, e); }
  if (!body || typeof body !== 'object') return h.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
  const card = store.updateCard(u, params.id, body);
  if (!card) return h.sendJson(res, 404, { ok: false, error: '卡片不存在或不属于当前用户' });
  return h.sendJson(res, 200, { ok: true, card: withNote(card) });
}

function remove(req, res, params, h) {
  const u = h.userOf(req);
  if (!store.deleteCard(u, params.id)) return h.sendJson(res, 404, { ok: false, error: '卡片不存在或不属于当前用户' });
  return h.sendJson(res, 200, { ok: true, deleted: params.id, stats: store.stats(u) });
}

/* ── 提交复习结果 ── */
async function review(req, res, params, h) {
  const u = h.userOf(req);
  let body = {};
  try { body = (await h.readJson(req)) || {}; } catch (e) { return h.fail(res, e); }
  if (typeof body !== 'object' || body === null) body = {};

  const rating = String(body.rating || '').toLowerCase();
  if (!store.RATINGS[rating]) {
    return h.sendJson(res, 400, { ok: false, error: 'rating 只能是 again / hard / good（忘了 / 模糊 / 记得）' });
  }
  const out = store.reviewCard(u, params.id, rating);
  if (!out) return h.sendJson(res, 404, { ok: false, error: '卡片不存在或不属于当前用户' });

  const payload = {
    ok: true,
    rating: rating,
    rating_label: RATING_LABEL[rating],
    card: withNote(out.card),
    log: out.log,
    preview: preview(out.card),
    stats: store.stats(u)
  };

  // 答错时可选地顺手给出 AI 解释（默认不调用，保持复习节奏快）
  if (rating === 'again' && body.explain === true) {
    payload.explanation = await runExplain(out.card, body.user_answer);
  }
  return h.sendJson(res, 200, payload);
}

/* ── 答错解释 ── */
async function runExplain(card, userAnswer) {
  const call = await llm.chat({
    system: prompts.EXPLAIN_SYSTEM,
    user: prompts.explainUser({ front: card.front, back: card.back, userAnswer: userAnswer }),
    temperature: 0.5,
    maxTokens: 500,
    models: ['glm-4-flash', 'glm-4-air']
  });
  if (call.ok) return { ok: true, text: String(call.text).trim(), model: call.model };
  return {
    ok: false,
    text: '',
    reason: call.code,
    notice: call.code === 'no_key'
      ? '服务器还没配置 AI 密钥，暂时无法给出智能解释。'
      : 'AI 解释暂时不可用，先对照正确答案回顾一下。'
  };
}

async function explain(req, res, params, h) {
  const u = h.userOf(req);
  const card = store.getCard(u, params.id);
  if (!card) return h.sendJson(res, 404, { ok: false, error: '卡片不存在或不属于当前用户' });
  let body = {};
  try { body = (await h.readJson(req)) || {}; } catch (e) { return h.fail(res, e); }
  const out = await runExplain(card, body && body.user_answer);
  return h.sendJson(res, 200, Object.assign({ ok: true }, out));
}

/* ── AI 单选测验（可选功能） ── */
async function quiz(req, res, params, h) {
  const u = h.userOf(req);
  const card = store.getCard(u, params.id);
  if (!card) return h.sendJson(res, 404, { ok: false, error: '卡片不存在或不属于当前用户' });

  const call = await llm.chat({
    system: prompts.QUIZ_SYSTEM,
    user: prompts.quizUser(card.front, card.back),
    temperature: 0.7,
    maxTokens: 700,
    models: ['glm-4-flash', 'glm-4-air'],
    accept: function (text) {
      const j = llm.extractJson(text, 'object');
      return !!(j && Array.isArray(j.options) && j.options.length >= 2);
    }
  });
  if (!call.ok) {
    return h.sendJson(res, 200, {
      ok: false, reason: call.code,
      notice: call.code === 'no_key' ? '服务器还没配置 AI 密钥，选择题模式暂不可用。' : 'AI 暂时不可用，选择题生成失败。',
      tried: call.tried
    });
  }
  const j = llm.extractJson(call.text, 'object') || {};
  const options = (Array.isArray(j.options) ? j.options : []).map(o => String(o).trim()).filter(Boolean).slice(0, 4);
  let idx = Number(j.answer_index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) idx = 0;
  if (options.length < 2) {
    return h.sendJson(res, 200, { ok: false, reason: 'rejected', notice: 'AI 生成的选项不合法，请重试。' });
  }
  return h.sendJson(res, 200, {
    ok: true, model: call.model,
    quiz: { stem: String(j.stem || card.front).slice(0, 300), options: options, answer_index: idx, explanation: String(j.explanation || '').slice(0, 300) }
  });
}

module.exports = { list, due, create, update, remove, review, explain, quiz, _preview: preview, RATING_LABEL };
