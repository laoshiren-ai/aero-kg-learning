/* ═══════════════════════════════════════════════════════════════
   笔记本页
   ───────────────────────────────────────────────────────────────
   · 笔记列表 / 搜索 / 详情 / 编辑 / 删除
   · 「生成卡片」：AI 按提示词把笔记拆成 3-8 张卡片 → **先出草稿，
     逐张可编辑**（正面/背面/标签都能改）→ 确认后保存
   · 笔记内容里的 ```mermaid 代码块会被渲染成图
   数据来自 AeroAPI：有后端走服务端，没有后端自动落到 localStorage。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const SRC_LABEL = { summary: '关键词综述', chat: 'AI 对话', node: '概念笔记', manual: '手写', card: '卡片' };
  const SRC_CLASS = { summary: 'src-summary', chat: 'src-chat', node: 'src-node', manual: 'src-manual' };

  const S = {
    loaded: false,
    notes: [],
    current: null,
    mode: 'empty',       // empty | view | edit | drafts
    drafts: [],
    q: '',
    stats: null
  };

  /* ══════════ 列表 ══════════ */
  async function load(keepCurrent) {
    const list = $('notesList');
    if (list) list.innerHTML = '<div class="notes-empty">加载中…</div>';
    try {
      const res = await AeroAPI.listNotes();
      S.notes = res.notes || [];
      S.stats = res.stats || null;
      S.loaded = true;
    } catch (e) {
      S.notes = [];
      if (list) list.innerHTML = '<div class="notes-empty">读取笔记失败：' + esc(e.message) + '</div>';
      return;
    }
    renderList();
    renderSideFoot();
    if (!keepCurrent && S.current) {
      const still = S.notes.find(n => n.id === S.current);
      if (!still) { S.current = null; S.mode = 'empty'; }
    }
    renderMain();
  }

  function renderSideFoot() {
    const box = $('notesSideFoot');
    if (!box) return;
    const st = S.stats || {};
    const off = AeroAPI.offline;
    box.innerHTML = `
      <div class="nsf-row">
        <span>${esc(AeroUser.label())}</span>
        <span class="nsf-mode ${off ? 'local' : ''}">${off ? '本地模式' : '云端模式'}</span>
      </div>
      <div class="nsf-stat">${S.notes.length} 篇笔记 · ${st.cards || 0} 张卡片 · ${st.due || 0} 张待复习</div>
      ${off ? '<div class="nsf-hint">当前页面背后没有后端，数据只存在这台浏览器（localStorage）。用 node server.js 启动即可多人多设备共享。</div>' : ''}`;
  }

  function renderList() {
    const list = $('notesList');
    if (!list) return;
    const q = S.q.trim().toLowerCase();
    const items = S.notes.filter(n => !q
      || (n.title || '').toLowerCase().indexOf(q) >= 0
      || (n.content || '').toLowerCase().indexOf(q) >= 0
      || (n.tags || []).join(' ').toLowerCase().indexOf(q) >= 0);

    if (!items.length) {
      list.innerHTML = '<div class="notes-empty">' + (S.notes.length ? '没有匹配的笔记' : '还没有笔记。<br>去图谱里点开概念、或在 AI 问答窗口里点 💾，都能一键存过来。') + '</div>';
      return;
    }
    list.innerHTML = items.map(n => `
      <div class="note-item ${S.current === n.id ? 'on' : ''}" data-id="${n.id}">
        <div class="ni-top">
          <b>${esc(n.title)}</b>
          <span class="ni-src ${SRC_CLASS[n.source_type] || ''}">${esc(SRC_LABEL[n.source_type] || n.source_type || '笔记')}</span>
        </div>
        <div class="ni-preview">${esc((n.content || '').replace(/```[\s\S]*?```/g, '[关系图]').slice(0, 70))}</div>
        <div class="ni-meta">
          ${(n.tags || []).slice(0, 3).map(t => `<span class="ni-tag">${esc(t)}</span>`).join('')}
          <span class="ni-count">${n.card_count ? '🃏 ' + n.card_count : '未拆卡'}${n.due_count ? ' · <b>' + n.due_count + ' 待复习</b>' : ''}</span>
        </div>
      </div>`).join('');
    list.querySelectorAll('.note-item').forEach(el => el.addEventListener('click', () => open(el.dataset.id)));
  }

  /* ══════════ 详情 / 编辑 ══════════ */
  async function open(id) {
    S.mode = 'view';
    S.current = id;
    renderList();
    const main = $('notesMain');
    main.innerHTML = '<div class="notes-empty">加载中…</div>';
    try {
      const res = await AeroAPI.getNote(id);
      S.note = res.note;
    } catch (e) {
      main.innerHTML = '<div class="notes-empty">读取失败：' + esc(e.message) + '</div>';
      return;
    }
    renderMain();
  }

  /** 把笔记内容里的 ```mermaid 块渲染成图，其余按段落显示 */
  function renderRichContent(content) {
    const parts = String(content || '').split(/```mermaid\n?([\s\S]*?)```/);
    let html = '', mmdSeq = 0;
    parts.forEach((seg, i) => {
      if (i % 2 === 1) {
        mmdSeq++;
        html += '<div class="note-mmd" data-mmd="' + mmdSeq + '"><div class="mmd-loading">渲染中…</div></div>';
      } else if (seg.trim()) {
        html += '<div class="note-text">' + esc(seg).replace(/\n/g, '<br>') + '</div>';
      }
    });
    return { html: html, mermaidCodes: parts.filter((_, i) => i % 2 === 1) };
  }

  function renderMain() {
    const main = $('notesMain');
    if (!main) return;

    if (S.mode === 'drafts') { renderDrafts(); return; }
    if (S.mode === 'edit' && S.note) { renderEdit(); return; }

    const n = S.note;
    if (!n) {
      main.innerHTML = `<div class="notes-hero">
        <div class="nh-icon">📒</div>
        <h3>笔记本</h3>
        <p>这里存放你从各处一键存下来的内容：<b>AI 问答</b>、<b>多关键词综述</b>、<b>概念笔记</b>。<br>
        每条笔记都能让 AI 拆成知识卡片，再到「复习」页按间隔重复刷。</p>
        <button class="btn-primary" id="btnHeroNew">+ 新建笔记</button>
      </div>`;
      const b = $('btnHeroNew'); if (b) b.addEventListener('click', newNote);
      return;
    }

    const rich = renderRichContent(n.content);
    main.innerHTML = `
      <div class="note-detail">
        <div class="nd-head">
          <div>
            <h3>${esc(n.title)}</h3>
            <div class="nd-meta">
              <span class="ni-src ${SRC_CLASS[n.source_type] || ''}">${esc(SRC_LABEL[n.source_type] || n.source_type)}</span>
              <span>更新于 ${new Date(n.updated_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              ${(n.tags || []).map(t => `<span class="ni-tag">${esc(t)}</span>`).join('')}
            </div>
          </div>
          <div class="nd-actions">
            <button class="btn-ghost btn-sm" id="ndEdit">✏️ 编辑</button>
            <button class="btn-ghost btn-sm" id="ndDel">🗑 删除</button>
          </div>
        </div>
        <div class="nd-content">${rich.html}</div>

        <div class="nd-cards">
          <div class="nd-cards-head">
            <b>🃏 知识卡片（${(n.cards || []).length}）</b>
            <button class="btn-primary btn-sm" id="ndGenCards">✨ 生成卡片</button>
          </div>
          <div id="ndCardList">${cardListHtml(n.cards || [])}</div>
          ${(n.cards || []).length ? '<button class="btn-ghost btn-sm" id="ndGoReview">去复习今天到期的卡片 →</button>' : ''}
        </div>
      </div>`;

    rich.mermaidCodes.forEach((code, i) => {
      const box = main.querySelector('.note-mmd[data-mmd="' + (i + 1) + '"]');
      if (box) AeroMermaid.render(code.trim(), box);
    });

    $('ndEdit').addEventListener('click', () => { S.mode = 'edit'; renderMain(); });
    $('ndDel').addEventListener('click', delNote);
    $('ndGenCards').addEventListener('click', genCards);
    const gr = $('ndGoReview'); if (gr) gr.addEventListener('click', () => { const b = document.querySelector('[data-view="review"]'); if (b) b.click(); });
    bindCardList();
  }

  function cardListHtml(cards) {
    if (!cards.length) return '<div class="guide-muted">还没有卡片。点「✨ 生成卡片」，AI 会按提示词把笔记拆成 3-8 张，先出草稿、可编辑后再保存。</div>';
    return cards.map(c => `
      <div class="card-row" data-id="${c.id}">
        <div class="cr-front">${esc(c.front)}</div>
        <div class="cr-back">${esc(c.back)}</div>
        <div class="cr-meta">
          ${(c.tags || []).map(t => `<span class="ni-tag">${esc(t)}</span>`).join('')}
          <span class="cr-sched">复习 ${c.reps} 次 · 下次 ${fmtDue(c.due)}</span>
          <button class="cr-btn" data-act="edit">改</button>
          <button class="cr-btn del" data-act="del">删</button>
        </div>
      </div>`).join('');
  }
  function fmtDue(due) {
    if (!due) return '—';
    const d = new Date(due);
    const days = Math.round((due - Date.now()) / 86400000);
    if (due <= Date.now()) return '现在';
    return days <= 0 ? '今天' : (days === 1 ? '明天' : days + ' 天后');
  }

  function bindCardList() {
    const box = $('ndCardList');
    if (!box) return;
    box.querySelectorAll('.card-row').forEach(row => {
      const id = row.dataset.id;
      row.querySelectorAll('.cr-btn').forEach(btn => btn.addEventListener('click', async e => {
        e.stopPropagation();
        if (btn.dataset.act === 'del') {
          if (!confirm('删除这张卡片？（复习记录一并删除）')) return;
          try { await AeroAPI.deleteCard(id); await refreshCurrent(); } catch (err) { alert('删除失败：' + err.message); }
          return;
        }
        // 行内编辑
        const card = ((S.note && S.note.cards) || []).find(c => c.id === id);
        row.innerHTML = `
          <input class="cr-in-front" value="${esc(card.front)}">
          <textarea class="cr-in-back">${esc(card.back)}</textarea>
          <input class="cr-in-tags" value="${esc((card.tags || []).join(' '))}" placeholder="标签（空格分隔）">
          <div class="cr-meta">
            <button class="cr-btn ok" data-act="save">保存</button>
            <button class="cr-btn" data-act="cancel">取消</button>
          </div>`;
        row.querySelector('[data-act="save"]').addEventListener('click', async () => {
          try {
            await AeroAPI.updateCard(id, {
              front: row.querySelector('.cr-in-front').value.trim(),
              back: row.querySelector('.cr-in-back').value.trim(),
              tags: row.querySelector('.cr-in-tags').value.trim().split(/\s+/).filter(Boolean)
            });
            await refreshCurrent();
          } catch (err) { alert('保存失败：' + err.message); }
        });
        row.querySelector('[data-act="cancel"]').addEventListener('click', () => renderMain());
      }));
    });
  }

  async function refreshCurrent() {
    if (!S.current) return;
    const res = await AeroAPI.getNote(S.current);
    S.note = res.note;
    S.mode = 'view';
    renderMain();
    await load(true);
  }

  function renderEdit() {
    const n = S.note;
    $('notesMain').innerHTML = `
      <div class="note-detail">
        <div class="nd-head"><h3>编辑笔记</h3></div>
        <label class="fld"><span>标题</span><input id="edTitle" value="${esc(n.title)}"></label>
        <label class="fld"><span>内容</span><textarea id="edContent" rows="16">${esc(n.content)}</textarea></label>
        <label class="fld"><span>标签（空格分隔）</span><input id="edTags" value="${esc((n.tags || []).join(' '))}"></label>
        <div class="nd-actions">
          <button class="btn-primary" id="edSave">保存</button>
          <button class="btn-ghost" id="edCancel">取消</button>
        </div>
        <div class="fld-hint">提示：内容里可以写 \`\`\`mermaid 代码块，保存后会自动渲染成关系图。</div>
      </div>`;
    $('edCancel').addEventListener('click', () => { S.mode = 'view'; renderMain(); });
    $('edSave').addEventListener('click', async () => {
      const btn = $('edSave'); btn.disabled = true; btn.textContent = '保存中…';
      try {
        await AeroAPI.updateNote(n.id, {
          title: $('edTitle').value.trim() || n.title,
          content: $('edContent').value,
          tags: $('edTags').value.trim().split(/\s+/).filter(Boolean)
        });
        await refreshCurrent();
      } catch (e) { btn.disabled = false; btn.textContent = '保存'; alert('保存失败：' + e.message); }
    });
  }

  async function delNote() {
    if (!S.current) return;
    if (!confirm('删除这条笔记？它下面的卡片与复习记录会一并删除。')) return;
    try {
      await AeroAPI.deleteNote(S.current);
      S.current = null; S.note = null; S.mode = 'empty';
      await load();
    } catch (e) { alert('删除失败：' + e.message); }
  }

  async function newNote() {
    try {
      const res = await AeroAPI.createNote({ title: '新笔记', content: '', source_type: 'manual', tags: [] });
      await load();
      await open(res.note.id);
      S.mode = 'edit';
      renderMain();
    } catch (e) { alert('新建失败：' + e.message); }
  }

  /* ══════════ 生成卡片（草稿可编辑） ══════════ */
  async function genCards() {
    if (!S.note) return;
    const btn = $('ndGenCards');
    btn.disabled = true; btn.textContent = 'AI 拆解中…';
    try {
      const res = await AeroAPI.generateCards(S.note.id, {});
      const cards = res.cards || [];
      if (!cards.length) {
        alert((res.notice || '这条笔记拆不出卡片，先补充一些具体知识点。'));
        btn.disabled = false; btn.textContent = '✨ 生成卡片';
        return;
      }
      S.drafts = cards.map(c => ({ front: c.front, back: c.back, tags: (c.tags || []).join(' ') }));
      S.draftNotice = res.notice || '';
      S.mode = 'drafts';
      renderMain();
    } catch (e) {
      alert('生成失败：' + e.message);
      btn.disabled = false; btn.textContent = '✨ 生成卡片';
    }
  }

  function renderDrafts() {
    const main = $('notesMain');
    main.innerHTML = `
      <div class="note-detail">
        <div class="nd-head">
          <div>
            <h3>✨ 卡片草稿（${S.drafts.length}）</h3>
            <div class="nd-meta"><span>AI 已按「每张卡只考一个知识点」拆分，<b>请先检查、修改后再保存</b></span></div>
          </div>
        </div>
        ${S.draftNotice ? `<div class="sm-note">${esc(S.draftNotice)}</div>` : ''}
        <div class="draft-list" id="draftList">
          ${S.drafts.map((d, i) => `
            <div class="draft-row" data-i="${i}">
              <div class="dr-no">${i + 1}</div>
              <div class="dr-fields">
                <input class="dr-front" value="${esc(d.front)}" placeholder="正面：具体、可回答的问题">
                <textarea class="dr-back" rows="2" placeholder="背面：简洁答案（≤80 字）">${esc(d.back)}</textarea>
                <input class="dr-tags" value="${esc(d.tags)}" placeholder="标签（空格分隔）">
              </div>
              <button class="dr-del" title="删除这张">✕</button>
            </div>`).join('')}
        </div>
        <button class="btn-ghost btn-sm" id="drAdd">+ 再加一张</button>
        <div class="nd-actions">
          <button class="btn-primary" id="drSave">保存 ${S.drafts.length} 张卡片</button>
          <button class="btn-ghost" id="drCancel">取消</button>
        </div>
      </div>`;

    const collect = () => {
      const out = [];
      main.querySelectorAll('.draft-row').forEach(row => {
        const f = row.querySelector('.dr-front').value.trim();
        const b = row.querySelector('.dr-back').value.trim();
        if (!f || !b) return;
        out.push({ front: f, back: b, tags: row.querySelector('.dr-tags').value.trim().split(/\s+/).filter(Boolean) });
      });
      return out;
    };
    main.querySelectorAll('.dr-del').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.closest('.draft-row').dataset.i);
      S.drafts.splice(i, 1);
      renderDrafts();
    }));
    $('drAdd').addEventListener('click', () => { S.drafts.push({ front: '', back: '', tags: '' }); renderDrafts(); });
    $('drCancel').addEventListener('click', () => { S.mode = 'view'; renderMain(); });
    $('drSave').addEventListener('click', async () => {
      const cards = collect();
      if (!cards.length) { alert('正面和背面都填好才能保存。'); return; }
      const b = $('drSave'); b.disabled = true; b.textContent = '保存中…';
      try {
        await AeroAPI.saveCards(S.note.id, cards);
        await refreshCurrent();
      } catch (e) { b.disabled = false; b.textContent = '保存卡片'; alert('保存失败：' + e.message); }
    });
  }

  /* ══════════ 外部入口 ══════════ */
  function bind() {
    const nb = $('btnNewNote'); if (nb) nb.addEventListener('click', newNote);
    const nc = $('btnNewNote2'); if (nc) nc.addEventListener('click', newNote);
    const si = $('noteSearch');
    if (si) si.addEventListener('input', () => { S.q = si.value; renderList(); });
  }

  window.AeroNotes = {
    open() { if (!S.loaded) load(); else { renderList(); renderSideFoot(); } },
    refresh() { return load(true); },
    /** 别处（AI 问答 / 综述 / 概念详情）存完笔记后调用 */
    onSaved(note) {
      if (note) {
        if (!S.notes.some(n => n.id === note.id)) S.notes.unshift(note);
        S.loaded = true;
        if ($('notesList')) { renderList(); }
      }
      load(true);
    },
    _state: S
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
