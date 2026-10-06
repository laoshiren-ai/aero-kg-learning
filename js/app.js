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
      // 探测后端：有后端 → 笔记/卡片存服务端；没有 → 自动本地模式
      if (window.AeroAPI) AeroAPI.init().then(() => this.renderMode()).catch(() => {});
    },

    /** 页脚显示当前数据模式，避免用户误以为"存丢了" */
    renderMode() {
      const el = $('footMode');
      if (!el) return;
      const off = AeroAPI.offline;
      el.textContent = off ? '本地模式（数据仅存本机浏览器）' : '云端模式（笔记/卡片存于服务端）';
      el.className = 'foot-mode' + (off ? ' local' : '');
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
          if (b.dataset.view === 'notes' && window.AeroNotes) AeroNotes.open();
          if (b.dataset.view === 'review' && window.AeroReview) AeroReview.open();
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
        Guide.clearTrail();
        if (window.AeroSummary) AeroSummary.reset();
        this.renderMap(); this.renderContext(); GraphView.refresh();
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

      body.innerHTML = `
        <div class="detail-head">
          <div class="detail-name">${esc(n.name)}</div>
          <span class="detail-cat" style="background:${KG.catColor(n.category)}">${KG.categories[n.category] || ''}</span>
        </div>
        <div class="detail-src">📖 出处：《航空航天概论》第3版 ${esc(n.evidence || '')}</div>

        <div class="detail-actions">
          <button class="btn-ghost btn-sm" id="detailSaveNote">💾 存为笔记（含关系）</button>
        </div>

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

        ${this.mediaSection(n)}

        ${sugg ? `<div class="detail-sec">
          <div class="suggest-box">
            <h5>🧭 AI 学习向导建议</h5>
            ${sugg}
          </div>
        </div>` : ''}
      `;

      body.querySelectorAll('.rel-item, .sg-item').forEach(el =>
        el.addEventListener('click', () => this.openNode(el.dataset.id)));
      const snb = $('detailSaveNote');
      if (snb) snb.addEventListener('click', () => this.saveDetailNote(n));
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

      // 详情页刚插入了新图片 → 重新触发全局放大绑定（滚轮/拖拽/全屏）
      if (window.AeroLightbox) AeroLightbox.refresh(body);
      // 没有本地示意图的节点 → 拉取 AI 知识卡片（有缓存则瞬时出）
      if (!this.nodeImage(n)) this.loadNodeCard(n);
    },

    /* ── 媒体区 ──
       有本地图 → 真图（点击全屏 / 滚轮缩放 / 拖拽）；
       没有本地图 → AI 知识卡片，不再显示"图片待补充"。
       （26 张核心图保留，其余节点不强行配图 —— 见用户 2026-10-06 的规则） */
    nodeImage(n) {
      const m = n.media || {};
      return n.imageUrl || m.imageUrl || '';
    },

    mediaSection(n) {
      const m = n.media || {};
      const img = this.nodeImage(n);
      const vid = n.videoUrl || m.videoUrl || '';
      const cap = n.imageCaption || m.caption || (n.name + ' 示意图');
      const vcap = n.videoCaption || m.videoCaption || (n.name + ' 讲解视频');

      const vidBlock = vid
        ? `<figure class="media-fig media-fig-video">
             <video class="media-video" src="${esc(vid)}" controls playsinline preload="metadata"></video>
             <figcaption>${esc(vcap)}</figcaption>
           </figure>`
        : '';

      /* ① 有本地示意图 → 图片照旧 */
      if (img) {
        const imgBlock = `<figure class="media-fig">
             <img class="zoomable" src="${esc(img)}" data-caption="${esc(cap)}" alt="${esc(cap)}" loading="lazy" draggable="false"
                  onerror="this.closest('figure').classList.add('img-missing');this.remove();if(window.AeroLightbox)AeroLightbox.refresh(document.body);">
             <span class="zoom-hint">🔍 点击放大</span>
             <div class="media-ph media-ph-fallback"><span class="mi">🖼️</span><span>图片待补充<br><code>${esc(img)}</code></span></div>
             <figcaption>${esc(cap)}</figcaption>
           </figure>`;
        return `
        <div class="detail-sec">
          <h4>🖼️ 图文 / 视频</h4>
          <div class="media-grid has-img">${imgBlock}${vidBlock}</div>
          ${m.note ? `<div class="media-note">${esc(m.note)}</div>` : ''}
        </div>`;
      }

      /* ② 没有本地图 → AI 知识卡片（替代"图片待补充"） */
      return `
        <div class="detail-sec">
          <h4>🎴 AI 知识卡片</h4>
          <div class="ncard-host" id="nodeCardHost"></div>
        </div>
        ${vidBlock ? `<div class="detail-sec"><h4>🎬 视频</h4><div class="media-grid">${vidBlock}</div></div>` : ''}`;
    },

    /** 异步把知识卡片填进 #nodeCardHost（浏览器有缓存则瞬时出） */
    loadNodeCard(n) {
      const host = $('nodeCardHost');
      if (!host) return;
      if (window.AeroNodeCard) AeroNodeCard.render(n, host);
    },

    /* ── 概念（含关系解释）一键存为笔记 ── */
    async saveDetailNote(n) {
      const btn = $('detailSaveNote');
      if (!btn) return;
      const KG = AeroKG;
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        const rels = KG.edgesOf(n.id).map(e => {
          const out = e.source === n.id;
          const other = KG.nodeMap[out ? e.target : e.source];
          if (!other) return '';
          return '- ' + (out ? n.name + ' ' + KG.relLabel(e, n.id) + ' ' + other.name : other.name + ' ' + KG.relLabel(e, n.id) + ' ' + n.name)
            + '（' + e.type + (e.ev ? ' · ' + e.ev : '') + '）';
        }).filter(Boolean);
        const content = [
          '【定义】', n.definition || '',
          n.detail ? '\n【核心解释】\n' + n.detail : '',
          rels.length ? '\n【与图中其他概念的关系】\n' + rels.join('\n') : '',
          '\n【教材出处】\n' + (n.evidence || '（未标注）')
        ].join('\n');
        const res = await AeroAPI.createNote({
          title: '概念：' + n.name,
          content: content,
          source_type: 'node',
          source_id: n.id,
          tags: [KG.categories[n.category] || '概念', n.name]
        });
        btn.textContent = '✓ 已存为笔记';
        if (window.AeroNotes && AeroNotes.onSaved) AeroNotes.onSaved(res.note);
      } catch (e) {
        btn.disabled = false; btn.textContent = '💾 存为笔记（含关系）';
        alert('保存失败：' + ((e && e.message) || '未知错误'));
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
          // 规则引擎先跑一次：它管着 20 条人工精选路径（关键词匹配，瞬时返回）
          const rule = Guide.explore(q);

          // ① 命中精选路径 → 直接用。人工撰写的路径质量最好，且用户无需等待
          if (rule && rule.curated) { this.renderExplore(rule); return; }

          // ② 没命中 → 交给 AI 规划（检索见 js/retrieve.js；KG.search 对整句必然落空）
          let r = null;
          let seed = window.AeroRetrieve ? window.AeroRetrieve.summary(q, 12) : '';
          // 把规则引擎给的图谱候选路径也作为种子，补足抽象问题（词面不含概念名）的检索盲区
          if (rule && rule.steps && rule.steps.length) {
            seed = rule.steps.map(s => `${s.id} | ${s.name} | ${s.note || ''}`).join('\n') + '\n' + seed;
          }
          if (Guide.LLM_SLOT && Guide.LLM_SLOT.enabled && seed) {
            try { r = await Guide.LLM_SLOT.ask(q, seed); } catch (e) { r = null; }
          }

          // ③ AI 不可用 / 返回不合法 → 回退规则引擎结果
          if (!r) r = rule;
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
      // 足迹列表（多选综述 UI）交给 js/summary.js 统一渲染，避免两处各写一遍
      if (window.AeroSummary) { AeroSummary.render(); return; }
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
