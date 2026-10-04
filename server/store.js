/**
 * ═══════════════════════════════════════════════════════════
 * AeroKG 数据存储（零依赖 JSON 文件持久化）
 * ───────────────────────────────────────────────────────────
 * 三张"表"（对应设计文档）：
 *   notes        : id, user_id, title, content, source_type, source_id, tags, created_at, updated_at
 *   cards        : id, note_id, user_id, front, back, tags, interval, ease, due, reps, last_reviewed_at
 *   review_logs  : id, card_id, rating, created_at
 *
 * 存储位置：<项目根>/.data/store.json
 *   · 目录以 . 开头，已被 server.js 的静态托管屏蔽，且写进 .gitignore
 *   · Vercel 等只读文件系统环境自动退到 /tmp（仅当前实例有效，不跨实例持久）
 *   · 可用环境变量 AEROKG_DATA_DIR 覆盖
 *
 * 用户隔离：所有读写都带 userId（前端 X-User-Id 头，来自本地匿名身份），
 *           记录不会被别的用户读到。
 * ═══════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.AEROKG_DATA_DIR
  || (process.env.VERCEL ? '/tmp/aerokg-data' : path.join(ROOT, '.data'));
const FILE = path.join(DIR, 'store.json');

const state = { version: 1, notes: [], cards: [], review_logs: [] };
let ready = false;
let lastError = null;

/* ── 载入（惰性，只做一次） ── */
function ensure() {
  if (ready) return;
  ready = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.notes)) state.notes = parsed.notes;
      if (Array.isArray(parsed.cards)) state.cards = parsed.cards;
      if (Array.isArray(parsed.review_logs)) state.review_logs = parsed.review_logs;
    }
  } catch (e) {
    // 首次运行（文件不存在）或文件损坏 → 当作空库，不阻断服务
    if (e && e.code !== 'ENOENT') lastError = '读取历史数据失败，已按空库启动：' + e.message;
  }
}

/* ── 原子写：先写 .tmp 再 rename，避免写一半崩溃留下坏文件 ── */
function persist() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, FILE);
    lastError = null;
  } catch (e) {
    lastError = '写入失败（数据仍在内存中，本次运行可继续使用）：' + e.message;
  }
}

/* ── id 生成 ── */
let seq = 0;
function uid(prefix) {
  seq += 1;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 5);
  return prefix + '_' + t + seq.toString(36) + r;
}
const now = () => Date.now();

/* ── 值清洗 ── */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v, maxItem, maxLen) => {
  if (Array.isArray(v)) return v.map(x => str(x, maxItem)).filter(Boolean).slice(0, maxLen);
  if (typeof v === 'string') return v.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, maxLen);
  return [];
};
function sanitizeUserId(v) {
  const s = str(v, 64).replace(/[^\w.:-]/g, '');
  return s || 'anonymous';
}

/* ═══════════════ notes ═══════════════ */
function listNotes(userId) {
  ensure();
  return state.notes
    .filter(n => n.user_id === userId)
    .sort((a, b) => b.updated_at - a.updated_at)
    .map(n => decorateNote(userId, n));
}
function decorateNote(userId, n) {
  const cards = state.cards.filter(c => c.note_id === n.id);
  return Object.assign({}, n, {
    card_count: cards.length,
    due_count: cards.filter(c => (c.due || 0) <= now()).length
  });
}
function getNote(userId, id) {
  ensure();
  const n = state.notes.find(x => x.id === id && x.user_id === userId);
  if (!n) return null;
  return Object.assign(decorateNote(userId, n), {
    cards: state.cards.filter(c => c.note_id === n.id).sort((a, b) => a.created_at - b.created_at)
  });
}
function createNote(userId, data) {
  ensure();
  const t = now();
  const note = {
    id: uid('n'),
    user_id: userId,
    title: str(data.title, 120) || '未命名笔记',
    content: str(data.content, 40000),
    source_type: str(data.source_type, 24) || 'manual',
    source_id: str(data.source_id, 200),
    tags: arr(data.tags, 32, 12),
    created_at: t,
    updated_at: t
  };
  state.notes.push(note);
  persist();
  return decorateNote(userId, note);
}
function updateNote(userId, id, patch) {
  ensure();
  const n = state.notes.find(x => x.id === id && x.user_id === userId);
  if (!n) return null;
  if (patch.title !== undefined) n.title = str(patch.title, 120) || n.title;
  if (patch.content !== undefined) n.content = str(patch.content, 40000);
  if (patch.tags !== undefined) n.tags = arr(patch.tags, 32, 12);
  if (patch.source_type !== undefined) n.source_type = str(patch.source_type, 24) || n.source_type;
  n.updated_at = now();
  persist();
  return decorateNote(userId, n);
}
function deleteNote(userId, id) {
  ensure();
  const i = state.notes.findIndex(x => x.id === id && x.user_id === userId);
  if (i < 0) return false;
  const cardIds = new Set(state.cards.filter(c => c.note_id === id).map(c => c.id));
  state.notes.splice(i, 1);
  state.cards = state.cards.filter(c => c.note_id !== id);      // 级联删卡片
  state.review_logs = state.review_logs.filter(l => !cardIds.has(l.card_id));
  persist();
  return true;
}

/* ═══════════════ cards ═══════════════ */
const EASE_DEFAULT = 2.5;

function newCard(userId, noteId, d) {
  return {
    id: uid('c'),
    note_id: noteId || '',
    user_id: userId,
    front: str(d.front, 400),
    back: str(d.back, 1200),
    tags: arr(d.tags, 32, 8),
    interval: 0,            // 天
    ease: EASE_DEFAULT,
    due: now(),             // 新卡立即可复习
    reps: 0,
    last_reviewed_at: 0,
    created_at: now()
  };
}
function listCards(userId, noteId) {
  ensure();
  const out = state.cards.filter(c => c.user_id === userId && (!noteId || c.note_id === noteId));
  return out.sort((a, b) => a.created_at - b.created_at);
}
function getCard(userId, id) {
  ensure();
  return state.cards.find(c => c.id === id && c.user_id === userId) || null;
}
function addCards(userId, noteId, drafts) {
  ensure();
  const created = drafts
    .map(d => newCard(userId, noteId, d))
    .filter(c => c.front && c.back);
  state.cards.push(...created);
  persist();
  return created;
}
function updateCard(userId, id, patch) {
  ensure();
  const c = state.cards.find(x => x.id === id && x.user_id === userId);
  if (!c) return null;
  if (patch.front !== undefined) c.front = str(patch.front, 400) || c.front;
  if (patch.back !== undefined) c.back = str(patch.back, 1200) || c.back;
  if (patch.tags !== undefined) c.tags = arr(patch.tags, 32, 8);
  persist();
  return c;
}
function deleteCard(userId, id) {
  ensure();
  const i = state.cards.findIndex(c => c.id === id && c.user_id === userId);
  if (i < 0) return false;
  state.cards.splice(i, 1);
  state.review_logs = state.review_logs.filter(l => l.card_id !== id);
  persist();
  return true;
}

/** 今日到期卡片：due <= now，按到期时间升序 */
function dueCards(userId, nowTs) {
  ensure();
  const t = nowTs || now();
  return state.cards
    .filter(c => c.user_id === userId && (c.due || 0) <= t)
    .sort((a, b) => (a.due || 0) - (b.due || 0));
}

/* ═══════════════ 简化间隔重复算法 ═══════════════
   · interval 单位「天」，ease 默认 2.5
   · 记得 good : interval = max(1, interval * 2);  ease += 0.1
   · 模糊 hard : interval = max(1, interval * 1.2)
   · 忘了 again: interval = 1;                     ease = max(1.3, ease - 0.2)
   · due = 现在 + interval 天;  reps += 1
   ═══════════════════════════════════════════════ */
const DAY = 86400000;
const RATINGS = { again: 1, hard: 2, good: 3 };

function nextSchedule(card, rating) {
  const r = RATINGS[rating] ? rating : 'good';
  let interval = Number(card.interval) || 0;
  let ease = Number(card.ease) || EASE_DEFAULT;

  if (r === 'good') {
    interval = Math.max(1, interval * 2);
    ease = ease + 0.1;
  } else if (r === 'hard') {
    interval = Math.max(1, interval * 1.2);
  } else {
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  }
  interval = Math.round(interval * 100) / 100;
  ease = Math.round(ease * 1000) / 1000;

  const t = now();
  return {
    rating: r,
    interval: interval,
    ease: ease,
    due: t + interval * DAY,
    reps: (Number(card.reps) || 0) + 1,
    last_reviewed_at: t
  };
}

function reviewCard(userId, id, rating) {
  ensure();
  const c = state.cards.find(x => x.id === id && x.user_id === userId);
  if (!c) return null;
  const sched = nextSchedule(c, rating);
  c.interval = sched.interval;
  c.ease = sched.ease;
  c.due = sched.due;
  c.reps = sched.reps;
  c.last_reviewed_at = sched.last_reviewed_at;
  const log = {
    id: uid('r'),
    card_id: c.id,
    user_id: userId,
    rating: sched.rating,
    created_at: sched.last_reviewed_at
  };
  state.review_logs.push(log);
  persist();
  return { card: c, log: log };
}

/** 预览：不改动数据，仅算出"如果这样评会排到什么时候"（用于界面提示） */
function previewSchedule(card, rating) {
  return nextSchedule(card, rating);
}

function stats(userId) {
  ensure();
  const t = now();
  const mine = state.cards.filter(c => c.user_id === userId);
  return {
    notes: state.notes.filter(n => n.user_id === userId).length,
    cards: mine.length,
    due: mine.filter(c => (c.due || 0) <= t).length,
    learned: mine.filter(c => (c.reps || 0) > 0).length,
    reviews: state.review_logs.filter(l => l.user_id === userId).length,
    storage: { file: FILE.replace(/\\/g, '/'), error: lastError }
  };
}

module.exports = {
  EASE_DEFAULT, RATINGS, DAY,
  sanitizeUserId,
  listNotes, getNote, createNote, updateNote, deleteNote,
  listCards, getCard, addCards, updateCard, deleteCard,
  dueCards, reviewCard, previewSchedule, stats,
  _file: FILE,
  _state: state
};
