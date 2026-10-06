/* ═══════════════════════════════════════════════════════════════
   AeroNodeCard —— 节点知识卡片（"没有本地示意图"的节点用）
   ───────────────────────────────────────────────────────────────
   背景：详情页原来对没有图的节点显示"图片待补充"占位，等于什么都没给。
   现在改成：没有本地图 → 调 /api/node-card 让 AI 生成一张知识卡片
   （一句话定义 / 核心公式 / 关系解释 / 一个例子 / 常见误区），
   流程型知识点可能还会附一张 Mermaid 流程图。

   三级缓存，确保"生成一次后不再重复调 API"：
     ① 服务端 .data/store.json 的 node_cards —— 公共缓存，所有人共享
     ② 浏览器 localStorage —— 同一台机器再次打开瞬时出图，连请求都不发
     ③ 都没有才真正调用智谱

   失败兜底：AI 不可用（没配密钥 / 超时）时，用节点自身的教材原文与
   图谱关系拼一张降级卡片 —— 保证"不是空白、不是待补充"。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  const LS_KEY = 'aerokg_nodecard_v1';
  const LS_MAX = 300;

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ── 公式美化：X^2 → X²、X_1 → X₁（普通文本上下标，不引 LaTeX） ── */
  const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', 'n': 'ⁿ', 'i': 'ⁱ' };
  const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋' };
  const mapChars = (str, table) => str.split('').map(c => table[c] || c).join('');

  /** 先转义再替换上下标（^ / _ 与数字不受转义影响，顺序安全） */
  function fmt(value) {
    return esc(value)
      .replace(/\^\s*\{?([0-9+\-n]+)\}?/g, (m, g) => mapChars(g, SUP))
      .replace(/_\s*\{?([0-9+\-]+)\}?/g, (m, g) => mapChars(g, SUB));
  }

  /* ── localStorage 缓存 ── */
  function readCache() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function writeCache(map) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch (e) { /* 隐私模式 / 满 */ }
  }
  function cacheGet(key) {
    const c = readCache()[key];
    return (c && typeof c === 'object') ? c : null;
  }
  function cachePut(key, card) {
    const map = readCache();
    map[key] = Object.assign({}, card, { _t: Date.now() });
    const keys = Object.keys(map);
    if (keys.length > LS_MAX) {                       // 简单 LRU：超量就丢最旧的
      keys.sort((a, b) => (map[a]._t || 0) - (map[b]._t || 0));
      keys.slice(0, keys.length - LS_MAX).forEach(k => delete map[k]);
    }
    writeCache(map);
  }

  /* ── 图谱里的关系 → 喂给 AI 的"上游下游"描述 ── */
  function relationLines(node) {
    try {
      if (!window.AeroKG || !AeroKG.edgesOf) return [];
      return AeroKG.edgesOf(node.id).map(e => {
        const out = e.source === node.id;
        const other = AeroKG.nodeMap[out ? e.target : e.source];
        if (!other) return '';
        return out
          ? (node.name + ' —' + e.type + '→ ' + other.name)
          : (other.name + ' —' + e.type + '→ ' + node.name);
      }).filter(Boolean).slice(0, 8);
    } catch (e) { return []; }
  }

  /* ── 降级卡片：AI 不可用时用教材原文 + 图谱关系拼一张 ── */
  function fallbackCard(node, notice) {
    const rels = relationLines(node);
    return {
      name: node.name,
      definition: node.definition || ('教材中对「' + node.name + '」的定义暂缺。'),
      formula: '无',
      relations: rels.length ? rels.join('；') : '',
      example: node.detail || '',
      pitfalls: '',
      mermaid: '',
      source: 'fallback',
      notice: notice || 'AI 暂时不可用，先用教材原文与图谱关系为你展示这个知识点。'
    };
  }

  const isNone = v => !v || /^[无沒没]\.?$/.test(String(v).trim());

  /* ── 渲染 ── */
  function sec(icon, label, value, cls) {
    if (!value) return '';
    return '<div class="ncard-sec ' + (cls || '') + '">'
      + '<div class="ncard-k">' + icon + ' ' + esc(label) + '</div>'
      + '<div class="ncard-v">' + value + '</div>'
      + '</div>';
  }

  function paint(container, card, fromCache) {
    const name = card.name || '';
    const tag = card.source === 'ai' ? '🤖 AI 生成'
      : card.source === 'fallback' ? '📖 教材原文' : '🤖 AI 生成';

    let html = '<div class="ncard">'
      + '<div class="ncard-top">'
      + '<span class="ncard-badge">🎴 知识卡片</span>'
      + '<span class="ncard-name">' + esc(name) + '</span>'
      + '<span class="ncard-tag">' + tag + '</span>'
      + (fromCache ? '<span class="ncard-cache" title="已缓存，不再重复调用 AI">⚡ 已缓存</span>' : '')
      + '</div>';

    html += sec('📌', '定义', card.definition ? '<p>' + fmt(card.definition) + '</p>' : '', 'ncard-def');

    if (!isNone(card.formula)) {
      html += '<div class="ncard-sec ncard-formula-sec">'
        + '<div class="ncard-k">🧮 核心公式</div>'
        + '<div class="ncard-formula">' + fmt(card.formula) + '</div>'
        + '</div>';
    }

    html += sec('🕸️', '关系解释', card.relations ? '<p>' + fmt(card.relations) + '</p>' : '');
    html += sec('💡', '例子', card.example ? '<p>' + fmt(card.example) + '</p>' : '');
    html += sec('⚠️', '常见误区', card.pitfalls ? '<p>' + fmt(card.pitfalls) + '</p>' : '');

    if (card.mermaid) {
      html += '<div class="ncard-sec ncard-mmd-sec">'
        + '<div class="ncard-k">🧭 流程图</div>'
        + '<div class="ncard-mmd" data-mmd="1"></div>'
        + '</div>';
    }

    if (card.notice) html += '<div class="ncard-note">' + esc(card.notice) + '</div>';
    html += '</div>';

    container.innerHTML = html;

    if (card.mermaid && window.AeroMermaid) {
      const box = container.querySelector('.ncard-mmd');
      if (box) AeroMermaid.render(card.mermaid, box);
    }
  }

  function skeleton(container) {
    container.innerHTML = '<div class="ncard ncard-loading">'
      + '<div class="ncard-top"><span class="ncard-badge">🎴 知识卡片</span>'
      + '<span class="ncard-spin">AI 正在生成…</span></div>'
      + '<div class="sk-line w90"></div><div class="sk-line w75"></div>'
      + '<div class="sk-line w85"></div><div class="sk-line w60"></div>'
      + '<div class="ncard-hint">第一次打开这个知识点需要等 AI 写一小段，之后会永久缓存、秒开。</div>'
      + '</div>';
  }

  /**
   * 渲染某个节点的知识卡片。
   * @param {object} node   AeroKG 节点对象
   * @param {HTMLElement} container 承载容器
   */
  async function render(node, container) {
    if (!container || !node) return;
    const key = String(node.id || node.name || '');
    container.__ncardReq = key;                      // 快速切换节点时的竞态守卫

    const local = cacheGet(key);
    if (local) { paint(container, local, true); return; }

    skeleton(container);
    let res = null;
    try {
      res = await AeroAPI.nodeCard({
        id: node.id, name: node.name, category: node.category,
        definition: node.definition, detail: node.detail,
        relations: relationLines(node)
      });
    } catch (e) {
      res = { ok: false, notice: '生成知识卡片失败：' + ((e && e.message) || '未知错误') };
    }
    if (container.__ncardReq !== key) return;        // 用户已经切到别的节点了

    if (res && res.ok && res.card) {
      if (!res.cached) cachePut(key, res.card);
      paint(container, res.card, !!res.cached);
    } else {
      // 不空白：用教材原文 + 图谱关系兜底
      paint(container, fallbackCard(node, res && res.notice), false);
    }
  }

  window.AeroNodeCard = { render: render, _cache: { read: readCache, get: cacheGet }, _fmt: fmt };
})();
