/* ═══════════════════════════════════════════════════════════════
   AeroAPI —— 统一数据访问层（服务端 / 本地双模）
   ───────────────────────────────────────────────────────────────
   有后端（node server.js）：全部走 /api/*，数据落在服务端 .data/store.json，
     换设备沿用同一份数据（只要带上同一个 X-User-Id）。
   无后端（直接双击 index.html / 静态托管）：自动切到「本地模式」，
     用 localStorage 实现完全相同的语义（含同一套间隔重复算法），
     笔记、卡片、复习全部照常可用，只是数据只存在这台浏览器里。

   为什么这么做：本站原有的 AI 功能就是这个思路（AI 优先 → 规则引擎回退），
   前端永远不因为"接口不存在"而白屏或弹错。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  const LS_KEY = 'aerokg_store_v1';
  const UID = (window.AeroUser && window.AeroUser.id) || 'anonymous';
  const DAY = 86400000;
  const EASE_DEFAULT = 2.5;
  const RATINGS = { again: 1, hard: 2, good: 3 };

  /* ── 本地拆卡（无后端时用；与服务端 notes.js 的规则同款） ── */
  function localCards(content, max) {
    const text = String(content || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*`]/g, ' ')
      .trim();
    const out = [];
    text.split(/\n+/).forEach(line => {
      const m = line.match(/^\s*([^：:]{2,30})\s*[：:]\s*(.{4,})$/);
      if (m && out.length < max) out.push({ front: m[1].trim() + '是什么？', back: m[2].trim().slice(0, 140), tags: ['笔记摘录'] });
    });
    if (out.length < 2) {
      text.split(/[。；;!?！？\n]+/).map(s => s.trim()).filter(s => s.length >= 10).slice(0, max).forEach(s => {
        if (out.length >= max) return;
        const cut = s.length > 24 ? s.slice(0, 24) + '…' : s;
        out.push({ front: '请回忆：「' + cut + '」讲了什么？', back: s.slice(0, 140), tags: ['笔记摘录'] });
      });
    }
    return out.slice(0, max);
  }
  window.AeroLocalCards = localCards;

  /* ───────────────── 本地实现（与服务端 store.js 同语义） ───────────────── */
  const Local = (function () {
    let db = null;
    function read() {
      if (db) return db;
      try { db = JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch (e) { db = null; }
      if (!db || typeof db !== 'object') db = {};
      if (!Array.isArray(db.notes)) db.notes = [];
      if (!Array.isArray(db.cards)) db.cards = [];
      if (!Array.isArray(db.review_logs)) db.review_logs = [];
      return db;
    }
    function write() { try { localStorage.setItem(LS_KEY, JSON.stringify(read())); } catch (e) {} }
    function uid(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    const now = () => Date.now();

    function nextSchedule(card, rating) {
      const r = RATINGS[rating] ? rating : 'good';
      let interval = Number(card.interval) || 0;
      let ease = Number(card.ease) || EASE_DEFAULT;
      if (r === 'good') { interval = Math.max(1, interval * 2); ease += 0.1; }
      else if (r === 'hard') { interval = Math.max(1, interval * 1.2); }
      else { interval = 1; ease = Math.max(1.3, ease - 0.2); }
      interval = Math.round(interval * 100) / 100;
      ease = Math.round(ease * 1000) / 1000;
      const t = now();
      return { rating: r, interval: interval, ease: ease, due: t + interval * DAY, reps: (Number(card.reps) || 0) + 1, last_reviewed_at: t };
    }
    function decorate(n) {
      const cs = read().cards.filter(c => c.note_id === n.id);
      return Object.assign({}, n, { card_count: cs.length, due_count: cs.filter(c => (c.due || 0) <= now()).length });
    }
    const mine = c => c.user_id === UID;

    return {
      listNotes() { return read().notes.filter(mine).sort((a, b) => b.updated_at - a.updated_at).map(decorate); },
      getNote(id) {
        const n = read().notes.find(x => x.id === id && mine(x));
        if (!n) return null;
        return Object.assign(decorate(n), { cards: read().cards.filter(c => c.note_id === id).sort((a, b) => a.created_at - b.created_at) });
      },
      createNote(d) {
        const t = now();
        const n = {
          id: uid('n'), user_id: UID,
          title: String(d.title || '未命名笔记').slice(0, 120),
          content: String(d.content || '').slice(0, 40000),
          source_type: d.source_type || 'manual', source_id: d.source_id || '',
          tags: Array.isArray(d.tags) ? d.tags.slice(0, 12) : [], created_at: t, updated_at: t
        };
        read().notes.push(n); write();
        return decorate(n);
      },
      updateNote(id, patch) {
        const n = read().notes.find(x => x.id === id && mine(x));
        if (!n) return null;
        if (patch.title !== undefined) n.title = String(patch.title).slice(0, 120) || n.title;
        if (patch.content !== undefined) n.content = String(patch.content).slice(0, 40000);
        if (patch.tags !== undefined) n.tags = Array.isArray(patch.tags) ? patch.tags.slice(0, 12) : [];
        n.updated_at = now(); write();
        return decorate(n);
      },
      deleteNote(id) {
        const db2 = read();
        const i = db2.notes.findIndex(x => x.id === id && mine(x));
        if (i < 0) return false;
        const cids = new Set(db2.cards.filter(c => c.note_id === id).map(c => c.id));
        db2.notes.splice(i, 1);
        db2.cards = db2.cards.filter(c => c.note_id !== id);
        db2.review_logs = db2.review_logs.filter(l => !cids.has(l.card_id));
        write(); return true;
      },
      listCards(noteId) {
        return read().cards.filter(c => mine(c) && (!noteId || c.note_id === noteId)).sort((a, b) => a.created_at - b.created_at);
      },
      addCards(noteId, drafts) {
        const out = drafts.filter(d => d && d.front && d.back).map(d => ({
          id: uid('c'), note_id: noteId || '', user_id: UID,
          front: String(d.front).slice(0, 400), back: String(d.back).slice(0, 1200),
          tags: Array.isArray(d.tags) ? d.tags.slice(0, 8) : [],
          interval: 0, ease: EASE_DEFAULT, due: now(), reps: 0, last_reviewed_at: 0, created_at: now()
        }));
        const db2 = read(); db2.cards.push.apply(db2.cards, out); write();
        return out;
      },
      updateCard(id, patch) {
        const c = read().cards.find(x => x.id === id && mine(x));
        if (!c) return null;
        if (patch.front !== undefined) c.front = String(patch.front).slice(0, 400) || c.front;
        if (patch.back !== undefined) c.back = String(patch.back).slice(0, 1200) || c.back;
        if (patch.tags !== undefined) c.tags = Array.isArray(patch.tags) ? patch.tags.slice(0, 8) : [];
        write(); return c;
      },
      deleteCard(id) {
        const db2 = read();
        const i = db2.cards.findIndex(c => c.id === id && mine(c));
        if (i < 0) return false;
        db2.cards.splice(i, 1);
        db2.review_logs = db2.review_logs.filter(l => l.card_id !== id);
        write(); return true;
      },
      due(noteId) {
        return read().cards.filter(c => mine(c) && (c.due || 0) <= now() && (!noteId || c.note_id === noteId))
          .sort((a, b) => (a.due || 0) - (b.due || 0));
      },
      preview(card) {
        const p = {};
        ['again', 'hard', 'good'].forEach(r => { const s = nextSchedule(card, r); p[r] = { interval: s.interval, due: s.due, ease: s.ease }; });
        return p;
      },
      review(id, rating) {
        const c = read().cards.find(x => x.id === id && mine(x));
        if (!c) return null;
        const s = nextSchedule(c, rating);
        c.interval = s.interval; c.ease = s.ease; c.due = s.due; c.reps = s.reps; c.last_reviewed_at = s.last_reviewed_at;
        const log = { id: uid('r'), card_id: c.id, user_id: UID, rating: s.rating, created_at: s.last_reviewed_at };
        read().review_logs.push(log); write();
        return { card: c, log: log };
      },
      stats() {
        const db2 = read();
        const cs = db2.cards.filter(mine);
        return {
          notes: db2.notes.filter(mine).length,
          cards: cs.length,
          due: cs.filter(c => (c.due || 0) <= now()).length,
          learned: cs.filter(c => (c.reps || 0) > 0).length,
          reviews: db2.review_logs.filter(l => l.user_id === UID).length
        };
      }
    };
  })();

  /* ───────────────── 服务端通道 ───────────────── */
  const state = { offline: false, reason: '', checked: false };

  async function call(method, path, body, timeoutMs) {
    const opts = {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-User-Id': UID },
      body: body === undefined ? undefined : JSON.stringify(body)
    };
    if (timeoutMs && window.AbortSignal && AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(path, opts);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      // 静态托管把 /api/* 当普通路径 → 返回 HTML 404，说明背后没有后端
      const err = new Error('no_backend');
      err.__offline = true; err.__status = res.status;
      throw err;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || ('请求失败 ' + res.status));
      err.__status = res.status; err.__data = data;
      throw err;
    }
    return data;
  }

  /** 服务端调用；无后端时抛 __offline，由上层切本地实现 */
  async function server(method, path, body) {
    if (state.offline) { const e = new Error('offline'); e.__offline = true; throw e; }
    try { return await call(method, path, body); }
    catch (e) {
      if (e.__offline || e instanceof TypeError) {
        state.offline = true;
        state.reason = (e instanceof TypeError) ? 'network' : 'no_backend';
        const e2 = new Error('offline'); e2.__offline = true; throw e2;
      }
      throw e;
    }
  }

  const AeroAPI = {
    get offline() { return state.offline; },
    get reason() { return state.reason; },
    user: UID,

    /** 探测后端是否存在；返回 'server' | 'local' */
    async init() {
      try {
        await call('GET', '/api/health');
        state.offline = false; state.reason = '';
      } catch (e) {
        state.offline = true;
        state.reason = (e instanceof TypeError) ? 'network' : 'no_backend';
      }
      state.checked = true;
      return state.offline ? 'local' : 'server';
    },

    /* ── 综述 ──
       AI 版要等模型把整段 JSON 写完（实测 10-30s，输出速度约 40ms/token），
       所以这里给 70 秒预算；界面同时已经在展示图谱即时版，用户不必干等。 */
    async summarize(payload) {
      try { return await call('POST', '/api/summarize/keywords', payload, 70000); }
      catch (e) {
        if (e && !e.__offline && !(e instanceof TypeError)) throw e;
        state.offline = true;
        state.reason = (e instanceof TypeError) ? 'network' : 'no_backend';
        const e2 = new Error('offline'); e2.__offline = true; throw e2;
      }
    },

    /* ── 笔记 ── */
    async listNotes() {
      try { return await server('GET', '/api/notes'); }
      catch (e) { if (!e.__offline) throw e; return { ok: true, notes: Local.listNotes(), stats: Local.stats(), local: true }; }
    },
    async getNote(id) {
      try { return await server('GET', '/api/notes/' + encodeURIComponent(id)); }
      catch (e) { if (!e.__offline) throw e; const n = Local.getNote(id); if (!n) throw new Error('笔记不存在'); return { ok: true, note: n, local: true }; }
    },
    async createNote(d) {
      try { return await server('POST', '/api/notes', d); }
      catch (e) { if (!e.__offline) throw e; return { ok: true, note: Local.createNote(d), local: true }; }
    },
    async updateNote(id, d) {
      try { return await server('PUT', '/api/notes/' + encodeURIComponent(id), d); }
      catch (e) { if (!e.__offline) throw e; return { ok: true, note: Local.updateNote(id, d), local: true }; }
    },
    async deleteNote(id) {
      try { return await server('DELETE', '/api/notes/' + encodeURIComponent(id)); }
      catch (e) { if (!e.__offline) throw e; const ok = Local.deleteNote(id); if (!ok) throw new Error('笔记不存在'); return { ok: true, deleted: id, local: true }; }
    },
    async generateCards(noteId, opts) {
      try { return await server('POST', '/api/notes/' + encodeURIComponent(noteId) + '/cards', opts || {}); }
      catch (e) {
        if (!e.__offline) throw e;
        // 本地模式没有 AI：用与后端同款的规则拆卡 → 草稿仍可编辑后保存
        const n = Local.getNote(noteId);
        const drafts = window.AeroLocalCards ? window.AeroLocalCards(n ? n.content : '', 6) : [];
        return { ok: true, mode: 'generated', cards: drafts, degraded: true, local: true, notice: drafts.length ? '本地模式下没有 AI，下面是用规则粗略拆出的卡片，请编辑后再保存。' : '这条笔记内容太少，拆不出卡片。' };
      }
    },
    async saveCards(noteId, cards) {
      const body = { cards: cards };
      try { return await server('POST', '/api/notes/' + encodeURIComponent(noteId) + '/cards', body); }
      catch (e) { if (!e.__offline) throw e; return { ok: true, mode: 'saved', cards: Local.addCards(noteId, cards), local: true }; }
    },
    async listCards(noteId) {
      try { return await server('GET', '/api/notes/' + encodeURIComponent(noteId) + '/cards'); }
      catch (e) { if (!e.__offline) throw e; return { ok: true, cards: Local.listCards(noteId), local: true }; }
    },

    /* ── 卡片 / 复习 ── */
    async dueCards(opts) {
      const q = new URLSearchParams();
      if (opts && opts.limit) q.set('limit', opts.limit);
      if (opts && opts.noteId) q.set('note_id', opts.noteId);
      const qs = q.toString() ? ('?' + q.toString()) : '';
      try { return await server('GET', '/api/cards/due' + qs); }
      catch (e) {
        if (!e.__offline) throw e;
        const cards = Local.due(opts && opts.noteId).map(c => Object.assign({}, c, { preview: Local.preview(c) }));
        return { ok: true, cards: cards, total_due: cards.length, stats: Local.stats(), local: true };
      }
    },
    async updateCard(id, d) {
      try { return await server('PUT', '/api/cards/' + encodeURIComponent(id), d); }
      catch (e) { if (!e.__offline) throw e; return { ok: true, card: Local.updateCard(id, d), local: true }; }
    },
    async deleteCard(id) {
      try { return await server('DELETE', '/api/cards/' + encodeURIComponent(id)); }
      catch (e) { if (!e.__offline) throw e; return { ok: true, deleted: id, stats: Local.stats(), local: true }; }
    },
    async createCard(d) {
      try { return await server('POST', '/api/cards', d); }
      catch (e) { if (!e.__offline) throw e; return { ok: true, card: Local.addCards(d.note_id || '', [d])[0], local: true }; }
    },
    async reviewCard(id, rating, userAnswer) {
      try { return await server('POST', '/api/cards/' + encodeURIComponent(id) + '/review', { rating: rating, user_answer: userAnswer || '' }); }
      catch (e) { if (!e.__offline) throw e; const out = Local.review(id, rating); if (!out) throw new Error('卡片不存在'); return { ok: true, rating: rating, card: out.card, log: out.log, preview: Local.preview(out.card), stats: Local.stats(), local: true }; }
    },
    async explainCard(id, userAnswer) {
      try { return await server('POST', '/api/cards/' + encodeURIComponent(id) + '/explain', { user_answer: userAnswer || '' }); }
      catch (e) {
        if (!e.__offline) throw e;
        return { ok: true, ok_ai: false, text: '', notice: '本地模式下没有 AI，无法给出智能解释。' };
      }
    },
    async quizCard(id) {
      try { return await server('POST', '/api/cards/' + encodeURIComponent(id) + '/quiz', {}); }
      catch (e) { if (!e.__offline) throw e; return { ok: false, notice: '本地模式下没有 AI，选择题模式不可用。' }; }
    },
    /* ── 节点知识卡片（"没有本地示意图"的节点用） ──
       服务端有公共缓存：同一知识点只会真正调一次 AI。
       本地模式（没后端）→ 返回 ok:false，由 js/nodecard.js 用教材原文兜底渲染。 */
    async nodeCard(payload) {
      try { return await call('POST', '/api/node-card', payload, 70000); }
      catch (e) {
        if (e && !e.__offline && !(e instanceof TypeError)) throw e;
        state.offline = true;
        state.reason = (e instanceof TypeError) ? 'network' : 'no_backend';
        return {
          ok: false, reason: 'offline', local: true,
          notice: '当前是本地模式（未连接后端服务），先用教材原文与图谱关系为你展示这个知识点。'
        };
      }
    },

    async stats() {
      try { return (await server('GET', '/api/stats')).stats; }
      catch (e) { if (!e.__offline) throw e; return Local.stats(); }
    }
  };

  window.AeroAPI = AeroAPI;
})();
