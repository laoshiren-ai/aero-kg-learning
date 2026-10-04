/* ═══════════════════════════════════════════════════════════════
   多关键词 AI 综述（footprint → summary）
   ───────────────────────────────────────────────────────────────
   位置：AI 学习向导 → 「我的知识地图」里的足迹列表
   流程：
     ① 打开多选模式，在足迹里勾选 3-8 个概念
     ② 点「生成综述」→ **先秒出图谱即时版**（纯本地、零幻觉）
     ③ 同时请求 /api/summarize/keywords，AI 版返回后就地升级（可来回切换）
     ④ 综述文字 + Mermaid 关系图 + 存为笔记

   为什么是两段式：实测 glm-4-flash 输出速度 ≈ 40ms/token，一份完整的
   综述 JSON（约 380 token）要 15-20 秒，物理上做不到"5 秒内返回"。
   图谱即时版 0 秒可得且每条关系都来自教材图谱（无幻觉），AI 版到达后
   再替换，用户既不用干等，也不会看到空白。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MIN_SEL = 3, MAX_SEL = 8;

  const REL_SHORT = { '从属': '从属', '包含': '包含', '并列': '并列', '关联': '关联', '因果': '因果' };
  const REL_CN = { '从属': '从属关系', '包含': '包含关系', '并列': '并列关系', '关联': '关联关系', '因果': '因果关系' };

  const state = {
    selectMode: false,
    selected: [],        // 选中的节点 id（有序）
    busy: false,
    versions: null,      // { graph: data, ai: data }
    active: 'graph',
    keywords: [],
    meta: null,
    saved: false
  };

  /* ═══════════ 图谱即时版（不需要 AI） ═══════════ */
  function selectedNodes() {
    return state.selected.map(id => AeroKG.nodeMap[id]).filter(Boolean);
  }
  function pairsOf(nodes) {
    const ids = nodes.map(n => n.id);
    const out = [], seen = new Set();
    AeroKG.edges.forEach(e => {
      if (ids.indexOf(e.s) < 0 || ids.indexOf(e.t) < 0) return;
      const k = e.s + '→' + e.t;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ from: AeroKG.nodeMap[e.s].name, to: AeroKG.nodeMap[e.t].name, relation: REL_CN[e.type] || e.type, type: e.type, evidence: e.ev || '', from_id: e.s, to_id: e.t });
    });
    return out;
  }
  function mermaidOf(nodes, pairs) {
    const idOf = {}, lines = ['graph TD'];
    nodes.forEach((n, i) => {
      idOf[n.name] = 'n' + i;
      lines.push('  n' + i + '["' + String(n.name).replace(/"/g, '') + '"]');
    });
    const drawn = new Set();
    pairs.forEach(p => {
      const a = idOf[p.from], b = idOf[p.to];
      if (!a || !b || a === b || drawn.has(a + '>' + b)) return;
      drawn.add(a + '>' + b);
      lines.push('  ' + a + ' -->|' + (REL_SHORT[p.type] || p.relation) + '| ' + b);
    });
    return lines.join('\n');
  }
  function graphSummary(nodes, pairs) {
    const names = nodes.map(n => n.name);
    const defs = nodes.map(n => n.name + '：' + (n.definition || '')).join('\n');
    const relText = pairs.length
      ? pairs.map(p => p.from + ' → ' + p.to + '（' + p.relation + '）').join('；')
      : '图谱中没有记录这些概念之间的直接关系，它们分属不同分支，需要先各自建立基础。';
    const cats = Array.from(new Set(nodes.map(n => AeroKG.categories[n.category] || n.category))).join('、');
    const pages = nodes.map(n => n.name + ' ' + (n.evidence || '')).filter(s => s.trim()).join('；');
    return {
      title: names.slice(0, 4).join('、') + (names.length > 4 ? ' 等' : '') + ' 的关系梳理',
      summary: '这 ' + names.length + ' 个概念都出自《航空航天概论》的' + cats + '部分。\n'
        + defs + '\n'
        + '它们之间的直接关系：' + relText,
      key_relations: pairs.map(p => ({ from: p.from, to: p.to, relation: p.relation, explanation: p.evidence || ('图谱中记录的' + p.relation) })),
      example: '',
      misconceptions: [],
      mermaid: mermaidOf(nodes, pairs),
      citations: pages ? ['教材出处：' + pages] : [],
      _graph: true
    };
  }

  /* ═══════════ 足迹列表（多选 UI） ═══════════ */
  function syncSelection() {
    const valid = new Set(Guide.trail.map(t => t.id));
    state.selected = state.selected.filter(id => valid.has(id));
  }

  function renderToolbar() {
    const box = $('trailToolbar');
    if (!box) return;
    const n = state.selected.length;
    const total = Guide.trail.length;
    const enough = total >= MIN_SEL;

    box.innerHTML = `
      <div class="tt-row">
        <button class="btn-ghost btn-sm ${state.selectMode ? 'on' : ''}" id="btnMultiMode" ${enough ? '' : 'disabled title="足迹里至少要有 3 个概念才能多选综述"'}>
          ${state.selectMode ? '✓ 退出多选' : '☑ 多选综述'}
        </button>
        ${state.selectMode
          ? `<span class="tt-count ${n > MAX_SEL ? 'over' : n >= MIN_SEL ? 'ok' : ''}">已选 ${n}/${MAX_SEL}</span>
             <button class="btn-primary btn-sm" id="btnGenSummary" ${(n >= MIN_SEL && n <= MAX_SEL && !state.busy) ? '' : 'disabled'}>
               ${state.busy ? '生成中…' : '生成综述'}
             </button>
             <button class="btn-ghost btn-sm" id="btnSelNone" ${n ? '' : 'disabled'}>清空选择</button>`
          : ''}
      </div>
      ${state.selectMode ? `<div class="tt-hint">${n < MIN_SEL ? `再选 ${MIN_SEL - n} 个（最少 ${MIN_SEL} 个）` : (n > MAX_SEL ? `超出上限，最多 ${MAX_SEL} 个` : '点概念卡片可取消选择 · 再点「生成综述」')}</div>` : ''}`;

    const bm = $('btnMultiMode');
    if (bm) bm.addEventListener('click', () => {
      state.selectMode = !state.selectMode;
      if (!state.selectMode) state.selected = [];
      renderTrail();
    });
    const bg = $('btnGenSummary');
    if (bg) bg.addEventListener('click', generate);
    const bn = $('btnSelNone');
    if (bn) bn.addEventListener('click', () => { state.selected = []; renderTrail(); });
  }

  function renderTrail() {
    syncSelection();
    renderToolbar();
    const list = $('trailList');
    if (!list) return;

    if (!Guide.trail.length) {
      list.innerHTML = '<div class="trail-empty">暂无足迹 —— 去图谱里点开一个概念吧。</div>';
      return;
    }
    list.innerHTML = Guide.trail.slice().reverse().map((t, i) => {
      const time = new Date(t.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const idx = state.selected.indexOf(t.id);
      const sel = idx >= 0;
      return `<div class="trail-item ${state.selectMode ? 'selectable' : ''} ${sel ? 'sel' : ''}" data-id="${t.id}">
        ${state.selectMode ? `<span class="t-check">${sel ? (idx + 1) : ''}</span>` : ''}
        <span class="t-idx">${Guide.trail.length - i}</span>
        <span class="t-name">${esc(t.name)}</span><span class="t-time">${time}</span>
      </div>`;
    }).join('');

    list.querySelectorAll('.trail-item').forEach(el => {
      el.addEventListener('click', () => handleTrailClick(el.dataset.id));
    });
  }

  function handleTrailClick(id) {
    if (!state.selectMode) { App.openNode(id, { fromSearch: true }); return; }
    const i = state.selected.indexOf(id);
    if (i >= 0) state.selected.splice(i, 1);
    else {
      if (state.selected.length >= MAX_SEL) { flashHint(`最多选 ${MAX_SEL} 个，先取消一个再选`); return; }
      state.selected.push(id);
    }
    renderTrail();
  }
  function flashHint(msg) {
    const box = $('trailToolbar');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'tt-hint warn';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  /* ═══════════ 生成综述 ═══════════ */
  async function generate() {
    const nodes = selectedNodes();
    if (nodes.length < MIN_SEL || nodes.length > MAX_SEL) return;
    state.keywords = nodes.map(n => n.name);
    state.busy = true;
    state.saved = false;
    renderToolbar();

    const pairs = pairsOf(nodes);
    state.versions = { graph: graphSummary(nodes, pairs), ai: null };
    state.active = 'graph';
    state.meta = {
      phase: 'loading',
      notice: 'AI 正在生成综述…（图谱即时版已就绪，可先阅读）',
      local: AeroAPI.offline
    };
    openModal();
    renderModal();

    /* 章节：选中的概念同属一章时带上，服务端据此缩小检索范围 */
    const chs = Array.from(new Set(nodes.map(n => n.ch).filter(Boolean)));
    const chapterId = chs.length === 1 ? ('ch' + chs[0]) : '';

    try {
      const res = await AeroAPI.summarize({
        keywords: state.keywords,
        relations: pairs.map(p => ({ from: p.from, to: p.to, relation: p.relation })),
        chapterId: chapterId
      });
      const meta = (res && res.meta) || {};
      state.meta = {
        phase: 'done',
        model: meta.model, degraded: !!meta.degraded, reason: meta.reason,
        notice: meta.notice || '', elapsedMs: meta.elapsedMs,
        relations: meta.relations, unresolved: meta.unresolved || [],
        dropped: meta.dropped_relations || []
      };
      if (res && res.data && !meta.degraded) {
        state.versions.ai = res.data;
        state.active = 'ai';
      }
    } catch (e) {
      state.meta = {
        phase: 'error',
        notice: e && e.__offline
          ? '没有可用的 AI 后端（当前是本地/静态模式），下面是图谱即时版综述。'
          : ('AI 综述失败：' + ((e && e.message) || '网络异常') + '。下面是图谱即时版综述。'),
        degraded: true
      };
    } finally {
      state.busy = false;
      renderToolbar();
      renderModal();
    }
  }

  /* ═══════════ 展示区（Modal） ═══════════ */
  function buildModal() {
    if ($('smMask')) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.id = 'smMask';
    mask.innerHTML = `
      <div class="modal sm-modal" role="dialog" aria-label="多关键词综述">
        <div class="modal-head">
          <span class="mh-emoji">🧩</span>
          <div class="mh-title"><b>多关键词 AI 综述</b><span id="smSubtitle"></span></div>
          <button class="mh-x" id="smX" title="关闭">✕</button>
        </div>
        <div class="modal-body" id="smBody"></div>
        <div class="modal-foot">
          <button class="btn-primary" id="smSaveNote">💾 存为笔记</button>
          <button class="btn-ghost" id="smRegen">↻ 重新生成</button>
          <button class="btn-ghost" id="smToNotes">📒 打开笔记本</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click', e => { if (e.target === mask) closeModal(); });
    mask.querySelector('#smX').addEventListener('click', closeModal);
    mask.querySelector('#smRegen').addEventListener('click', () => { if (!state.busy) generate(); });
    mask.querySelector('#smSaveNote').addEventListener('click', saveNote);
    mask.querySelector('#smToNotes').addEventListener('click', () => {
      closeModal();
      const b = document.querySelector('[data-view="notes"]');
      if (b) b.click();
    });
  }
  function openModal() { buildModal(); $('smMask').classList.add('open'); }
  function closeModal() { const m = $('smMask'); if (m) m.classList.remove('open'); }

  function renderModal() {
    if (!$('smMask')) return;
    const d = state.versions && (state.versions[state.active] || state.versions.graph);
    if (!d) return;
    const meta = state.meta || {};

    $('smSubtitle').textContent = state.keywords.join(' · ');

    const tabs = state.versions.ai
      ? `<div class="sm-tabs">
           <button class="sm-tab ${state.active === 'ai' ? 'on' : ''}" data-v="ai">🤖 AI 综述</button>
           <button class="sm-tab ${state.active === 'graph' ? 'on' : ''}" data-v="graph">🗂 图谱即时版</button>
         </div>`
      : '';

    const relRows = (d.key_relations || []).map(r => `
      <div class="sm-rel">
        <span class="sm-rel-pair">${esc(r.from)} <i>→</i> ${esc(r.to)}</span>
        <span class="sm-rel-badge">${esc(r.relation)}</span>
        ${r.explanation ? `<div class="sm-rel-exp">${esc(r.explanation)}</div>` : ''}
        <div class="sm-rel-jump">
          <button class="sm-jump" data-a="${esc(r.from)}">看「${esc(r.from)}」</button>
          <button class="sm-jump" data-a="${esc(r.to)}">看「${esc(r.to)}」</button>
        </div>
      </div>`).join('') || '<div class="guide-muted">图谱里没有记录这些概念之间的直接关系。</div>';

    $('smBody').innerHTML = `
      <div class="sm-kws">${state.keywords.map(k => `<span class="sm-kw">${esc(k)}</span>`).join('')}</div>

      <div class="sm-status ${meta.degraded ? 'warn' : ''} ${meta.phase === 'loading' ? 'loading' : ''}">
        ${meta.phase === 'loading' ? '<span class="sm-spin"></span>' : (meta.degraded ? '⚠ ' : '✓ ')}
        ${esc(meta.notice || (meta.phase === 'loading' ? 'AI 正在生成…' : 'AI 综述已就绪'))}
        ${meta.model ? `<span class="sm-model">${esc(meta.model)} · ${(meta.elapsedMs / 1000).toFixed(1)}s</span>` : ''}
      </div>

      ${tabs}

      <div class="sm-section">
        <h4>📝 关系综述</h4>
        <div class="sm-summary">${esc(d.summary).replace(/\n/g, '<br>')}</div>
      </div>

      <div class="sm-section">
        <h4>🕸️ 关键关系（${(d.key_relations || []).length}）</h4>
        ${relRows}
      </div>

      ${d.example ? `<div class="sm-section"><h4>💡 生活化例子</h4><div class="sm-example">${esc(d.example)}</div></div>` : ''}

      ${(d.misconceptions && d.misconceptions.length) ? `<div class="sm-section"><h4>⚠️ 最容易混淆的点</h4>
        <ul class="sm-mis">${d.misconceptions.map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}

      <div class="sm-section">
        <h4>🗺️ Mermaid 关系总图</h4>
        <div class="sm-diagram" id="smDiagram"><div class="mmd-loading">渲染中…</div></div>
      </div>

      ${(d.citations && d.citations.length) ? `<div class="sm-section"><h4>📖 来源</h4>
        <ul class="sm-cite">${d.citations.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}

      ${meta.unresolved && meta.unresolved.length ? `<div class="sm-note">以下关键词没有在图谱里找到对应概念，已忽略：${esc(meta.unresolved.join('、'))}</div>` : ''}
      ${meta.dropped && meta.dropped.length ? `<div class="sm-note">已剔除 ${meta.dropped.length} 条图谱中不存在的"关系"（防幻觉校验）。</div>` : ''}
    `;

    // Mermaid 渲染（失败自动降级为原始代码）
    const box = $('smDiagram');
    if (box) AeroMermaid.render(d.mermaid, box);
    // 标签页切换
    $('smBody').querySelectorAll('.sm-tab').forEach(b => b.addEventListener('click', () => {
      state.active = b.dataset.v; renderModal();
    }));
    // 关系里的概念 → 跳到图谱
    $('smBody').querySelectorAll('.sm-jump').forEach(b => b.addEventListener('click', () => {
      const n = AeroKG.nodes.find(x => x.name === b.dataset.a);
      if (n) { closeModal(); App.openNode(n.id, { fromSearch: true }); }
    }));
  }

  /* ═══════════ 存为笔记 ═══════════ */
  function noteContent(d) {
    const lines = [d.summary, ''];
    if (d.key_relations && d.key_relations.length) {
      lines.push('【关键关系】');
      d.key_relations.forEach(r => lines.push('- ' + r.from + ' → ' + r.to + '（' + r.relation + '）' + (r.explanation ? '：' + r.explanation : '')));
      lines.push('');
    }
    if (d.example) { lines.push('【生活化例子】', d.example, ''); }
    if (d.misconceptions && d.misconceptions.length) {
      lines.push('【最容易混淆】');
      d.misconceptions.forEach(m => lines.push('- ' + m));
      lines.push('');
    }
    if (d.mermaid) { lines.push('【关系图】', '```mermaid', d.mermaid, '```', ''); }
    if (d.citations && d.citations.length) { lines.push('【来源】'); d.citations.forEach(c => lines.push('- ' + c)); }
    return lines.join('\n').trim();
  }

  async function saveNote() {
    const d = state.versions && (state.versions[state.active] || state.versions.graph);
    if (!d) return;
    const btn = $('smSaveNote');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const res = await AeroAPI.createNote({
        title: d.title || ('关键词综述：' + state.keywords.join('、')),
        content: noteContent(d),
        source_type: 'summary',
        source_id: state.keywords.join(','),
        tags: state.keywords.slice(0, 6)
      });
      state.saved = true;
      btn.textContent = '✓ 已存为笔记';
      if (window.AeroNotes && AeroNotes.onSaved) AeroNotes.onSaved(res.note);
      const tip = document.createElement('div');
      tip.className = 'sm-note ok';
      tip.textContent = '已存入「笔记本」' + (AeroAPI.offline ? '（本地模式，仅存于本机浏览器）' : '') + '，可在那里生成复习卡片。';
      const body = $('smBody');
      if (body) body.appendChild(tip);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '💾 存为笔记';
      alert('保存失败：' + ((e && e.message) || '未知错误'));
    }
  }

  /* ═══════════ 对外 ═══════════ */
  window.AeroSummary = {
    render: renderTrail,
    renderTrail: renderTrail,
    reset() { state.selected = []; state.selectMode = false; if (typeof renderTrail === 'function' && $('trailList')) renderTrail(); },
    /** 供"一键存综述"类入口复用 */
    saveAsNote: saveNote
  };
})();
