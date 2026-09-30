/* ═══════════════════════════════════════════════
   App 编排 — 视图切换 / 详情面板 / 向导界面
   ═══════════════════════════════════════════════ */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const REL_COLOR = { '从属': '#7d93ad', '包含': '#4f9ea0', '并列': '#b8923a', '关联': '#c08a8a', '因果': '#d6544a' };

  const App = {
    currentId: null,

    boot() {
      // KG 数据就绪
      window.AeroKG.prepare();
      GraphView.init();
      this.bindNav(); this.bindTools(); this.bindGuide(); this.bindChips();
      this.renderStats(); this.renderCurated();
      Guide.loadTrail(); this.renderMap(); this.renderContext();
      const fs = new URLSearchParams(location.search).get('k');
      if (fs && AeroKG.nodeMap[fs]) this.openNode(fs, { fromSearch: true });
    },

    /* ── 导航 ── */
    bindNav() {
      document.querySelectorAll('.nav-btn').forEach(b => {
        b.addEventListener('click', () => {
          document.querySelectorAll('.nav-btn').forEach(x => x.classList.toggle('active', x === b));
          document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
          $('view-' + b.dataset.view).classList.add('active');
          if (b.dataset.view === 'graph') setTimeout(() => GraphView.refresh(), 60);
          if (b.dataset.view === 'guide') { this.renderMap(); this.renderContext(); }
        });
      });
      $('brandHome').addEventListener('click', () => GraphView.resetView());
    },

    bindTools() {
      $('btnResetView').addEventListener('click', () => GraphView.resetView());
      $('btnRelayout').addEventListener('click', () => GraphView.relayout());
      $('btnTrail').addEventListener('click', e => {
        const on = GraphView.toggleTrail();
        e.currentTarget.classList.toggle('on', on);
      });
      $('btnClearTrail').addEventListener('click', () => {
        Guide.clearTrail(); this.renderMap(); this.renderContext(); GraphView.refresh();
      });
    },

    /* ── 打开节点详情 ── */
    openNode(id, opts = {}) {
      const n = AeroKG.nodeMap[id];
      if (!n) return;
      this.currentId = id;
      Guide.pushVisit(n);
      this.renderDetail(n);
      this.renderContext();
      this.renderMap();
      GraphView.focusNode(id);
      // 移动端：滑出抽屉
      if (window.matchMedia('(max-width: 900px)').matches) {
        $('detailPanel').classList.add('open');
        $('drawerMask').classList.add('show');
      }
      if (opts.fromSearch) {
        document.querySelector('[data-view="graph"]').click();
      }
    },

    closeDrawer() {
      $('detailPanel').classList.remove('open');
      $('drawerMask').classList.remove('show');
    },

    renderDetail(n) {
      const KG = AeroKG;
      $('detailEmpty').style.display = 'none';
      const body = $('detailBody');
      body.style.display = 'block';

      const rels = KG.edgesOf(n.id).map(e => {
        const out = e.source === n.id;
        const other = KG.nodeMap[out ? e.target : e.source];
        if (!other) return '';
        const rel = KG.relLabel(e, n.id);
        return `<div class="rel-item" data-id="${other.id}">
          <span class="rel-badge" style="background:${REL_COLOR[e.type] || '#999'}">${e.type}</span>
          <span class="rel-dir">${rel}</span>
          <span class="rel-name">${esc(other.name)}</span>
          <span class="rel-arrow">→</span>
        </div>`;
      }).join('');

      const sugg = Guide.recommend(n.id).map((r, i) => {
        const node = KG.nodeMap[r.id];
        return `<div class="sg-item" data-id="${r.id}">
          <span class="sg-num">${i + 1}</span>
          <span><span class="sg-name">${esc(node.name)}</span>${r.isNew ? '<span class="sg-why" style="color:var(--ok)">未探索</span>' : ''}<span class="sg-why">${esc(r.why)}</span></span>
        </div>`;
      }).join('');

      const media = n.media || {};
      body.innerHTML = `
        <div class="detail-head">
          <div class="detail-name">${esc(n.name)}</div>
          <span class="detail-cat" style="background:${KG.catColor(n.category)}">${KG.categories[n.category] || ''}</span>
        </div>
        <div class="detail-src">📖 出处：《航空航天概论》第3版 ${esc(n.evidence || '')}</div>

        <div class="detail-sec">
          <h4>📌 定义</h4>
          <div class="detail-def">${esc(n.definition)}</div>
        </div>

        ${n.detail ? `<div class="detail-sec">
          <h4>🔍 核心解释</h4>
          <div class="detail-body-text" id="detailMoreText">${esc(n.detail)}</div>
          ${n.detail.length > 190 ? '<div class="detail-more" id="detailMoreBtn">展开全部 ▾</div>' : ''}
        </div>` : ''}

        <div class="detail-sec">
          <h4>🕸️ 关系（${KG.edgesOf(n.id).length}）</h4>
          ${rels || '<div class="guide-muted">暂无关系数据</div>'}
        </div>

        <div class="detail-sec">
          <h4>🖼️ 图文 / 视频</h4>
          <div class="media-grid">
            <div class="media-ph"><span class="mi">🖼️</span>示意图占位</div>
            <div class="media-ph"><span class="mi">🎬</span>视频占位</div>
          </div>
          <div class="media-note">${esc(media.note || '本站为演示项目，媒体区预留占位。建议来源：NASA 官网、维基百科「' + esc(n.name) + '」词条、B站公开课检索「' + esc(n.name) + '」。')}</div>
        </div>

        ${sugg ? `<div class="detail-sec">
          <div class="suggest-box">
            <h5>🧭 AI 学习向导建议</h5>
            ${sugg}
          </div>
        </div>` : ''}
      `;

      body.querySelectorAll('.rel-item, .sg-item').forEach(el =>
        el.addEventListener('click', () => this.openNode(el.dataset.id)));
      const moreBtn = $('detailMoreBtn');
      if (moreBtn) {
        const txt = $('detailMoreText');
        txt.style.maxHeight = '118px'; txt.style.overflow = 'hidden';
        moreBtn.addEventListener('click', () => {
          const open = txt.style.overflow !== 'hidden';
          txt.style.overflow = open ? 'hidden' : 'visible';
          moreBtn.textContent = open ? '展开全部 ▾' : '收起 ▴';
        });
      }
    },

    /* ── 向导视图 ── */
    bindGuide() {
      const ask = async () => {
        const q = $('exploreInput').value.trim();
        if (!q) return;
        const btn = $('btnExplore');
        btn.disabled = true; btn.textContent = '规划中…';
        try {
          // ① 先尝试 AI 规划（Vercel 部署时经 /api/chat 调 glm-4-flash）
          // ② 静态托管 / 接口异常 → 自动回退本地规则引擎
          let r = null;
          const KG = AeroKG;
          const summary = KG.search(q, 12)
            .map(n => `${n.id} | ${n.name} | ${(n.definition || '').slice(0, 50)}`)
            .join('\n');
          if (Guide.LLM_SLOT && Guide.LLM_SLOT.enabled) {
            try { r = await Guide.LLM_SLOT.ask(q, summary); } catch (e) { r = null; }
          }
          if (!r) r = Guide.explore(q);
          this.renderExplore(r);
        } finally {
          btn.disabled = false; btn.textContent = '规划路径';
        }
      };
      $('btnExplore').addEventListener('click', ask);
      $('exploreInput').addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });
      $('drawerMask').addEventListener('click', () => this.closeDrawer());
    },

    bindChips() {
      document.querySelectorAll('.chip-sample').forEach(c =>
        c.addEventListener('click', () => {
          $('exploreInput').value = c.textContent.trim();
          $('btnExplore').click();
        }));
    },

    renderExplore(r) {
      const box = $('exploreResult');
      if (!r) { box.innerHTML = ''; return; }
      if (r.miss) {
        box.innerHTML = `<div class="path-card"><div class="path-steps"><p class="guide-muted" style="padding:12px">图谱中暂时没有与「${esc(r.question)}」直接相关的概念。试试这些问题：飞机为什么能飞、涡扇与涡喷的区别、火箭如何入轨…</p></div></div>`;
        return;
      }
      box.innerHTML = `
        <div class="path-card">
          <div class="path-head">
            <b>🧭 ${esc(r.title)}</b>${r.ai ? '<span class="ai-badge">🤖 AI 规划</span>' : ''}
            <div class="path-q">针对你的问题：「${esc(r.question)}」</div>
          </div>
          <div class="path-steps">
            ${r.steps.map((s, i) => `
              ${i > 0 ? '<div class="ps-conn"></div>' : ''}
              <div class="path-step" data-id="${s.id}">
                <div class="ps-num">${i + 1}</div>
                <div class="ps-body"><b>${esc(s.name)}</b><p>${esc(s.note)}</p></div>
              </div>`).join('')}
          </div>
        </div>`;
      box.querySelectorAll('.path-step').forEach(el =>
        el.addEventListener('click', () => this.openNode(el.dataset.id, { fromSearch: true })));
    },

    renderContext() {
      const box = $('guideContext');
      const cur = this.currentId && AeroKG.nodeMap[this.currentId];
      if (!cur) {
        box.innerHTML = '<p class="guide-muted">你还没有浏览任何节点。回到「知识图谱」点一个节点，我就会给出下一步建议。</p>';
        return;
      }
      const recs = Guide.recommend(cur.id);
      box.innerHTML = `
        <p style="margin-bottom:10px">你刚了解了 <b style="color:var(--accent)">${esc(cur.name)}</b>，接下来可以看：</p>
        ${recs.map((r, i) => {
          const node = AeroKG.nodeMap[r.id];
          return `<div class="sg-item" data-id="${r.id}">
            <span class="sg-num">${i + 1}</span>
            <span><span class="sg-name">${esc(node.name)}</span><span class="sg-why">${esc(r.why)}</span></span>
          </div>`;
        }).join('')}`;
      box.querySelectorAll('.sg-item').forEach(el =>
        el.addEventListener('click', () => this.openNode(el.dataset.id, { fromSearch: true })));
    },

    renderMap() {
      const st = Guide.mapStats();
      $('mapSummary').innerHTML = `
        <div class="ms-item"><b>${st.visited}</b><span>已探索节点</span></div>
        <div class="ms-item"><b>${st.total}</b><span>图谱节点总数</span></div>
        <div class="ms-item"><b>${st.pct}%</b><span>覆盖率</span></div>`;
      const list = $('trailList');
      if (!Guide.trail.length) {
        list.innerHTML = '<div class="trail-empty">暂无足迹 —— 去图谱里点开一个概念吧。</div>';
        return;
      }
      list.innerHTML = Guide.trail.slice().reverse().map((t, i) => {
        const time = new Date(t.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        return `<div class="trail-item" data-id="${t.id}">
          <span class="t-idx">${Guide.trail.length - i}</span>
          <span>${esc(t.name)}</span><span class="t-time">${time}</span>
        </div>`;
      }).join('');
      list.querySelectorAll('.trail-item').forEach(el =>
        el.addEventListener('click', () => this.openNode(el.dataset.id, { fromSearch: true })));
    },

    renderCurated() {
      const box = $('curatedPaths');
      box.innerHTML = (window.AeroPaths || []).map((p, i) => `
        <div class="cp-item" data-i="${i}">
          <b>${esc(p.title)}</b>
          <p>${esc(p.intro)}</p>
          <div class="cp-meta">${p.steps.length} 站 · ${p.steps.map(id => esc((AeroKG.nodeMap[id] || {}).name || '')).filter(Boolean).join(' → ')}</div>
        </div>`).join('');
      box.querySelectorAll('.cp-item').forEach(el =>
        el.addEventListener('click', () => {
          const p = window.AeroPaths[+el.dataset.i];
          this.renderExplore({ question: p.match[0], title: p.title, intro: p.intro, steps: p.steps.map(id => {
            const n = AeroKG.nodeMap[id];
            return { id, name: n.name, note: n.definition.slice(0, 60) + '…' };
          }) });
        }));
    },

    renderStats() {
      const total = AeroKG.nodes.length, rels = AeroKG.edges.length;
      $('graphStats').innerHTML = `<b>${total}</b> 个概念节点 · <b>${rels}</b> 条关系 · 来源：第2章 飞行原理 + 第3章 动力装置`;
      $('footStats').innerHTML = `节点 ${total} · 关系 ${rels} · AI 自动抽取自教材 OCR 文本`;
    }
  };

  window.App = App;
  document.addEventListener('DOMContentLoaded', () => App.boot());
})();
