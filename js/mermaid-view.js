/* ═══════════════════════════════════════════════════════════════
   AeroMermaid —— Mermaid 渲染封装（本地 vendor 库，不依赖 CDN）
   ───────────────────────────────────────────────────────────────
   要求："Mermaid 用前端库渲染，若渲染失败显示原始代码"。
   所以这里把两件事都做掉：
     · 渲染成功 → 塞入 SVG
     · 渲染失败（语法不合法 / 库没加载上）→ 原样显示 Mermaid 源码，
       并给一个「复制代码」按钮，用户仍能把图拿到 mermaid.live 去用
   ═══════════════════════════════════════════════════════════════ */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let inited = false;
  let seq = 0;

  function init() {
    if (inited) return true;
    if (!window.mermaid) return false;
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: '"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif',
        themeVariables: {
          fontSize: '13px',
          primaryColor: '#eaf1fd',
          primaryTextColor: '#1f2a3a',
          primaryBorderColor: '#2f6fd6',
          lineColor: '#8ba3c7',
          secondaryColor: '#f4f6fa',
          tertiaryColor: '#ffffff',
          edgeLabelBackground: '#ffffff'
        },
        flowchart: { htmlLabels: false, curve: 'basis', useMaxWidth: true }
      });
      inited = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function cleanup(id) {
    ['d' + id, id].forEach(x => {
      const el = document.getElementById(x);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  /** 原始代码块（渲染失败时的兜底展示） */
  function rawBlock(code, note) {
    return '<div class="mmd-raw-wrap">'
      + '<div class="mmd-raw-tip">⚠ ' + esc(note || '关系图渲染失败，下面是原始 Mermaid 代码（可直接复制到 mermaid.live 查看）') + '</div>'
      + '<pre class="mmd-raw">' + esc(code) + '</pre>'
      + '<button class="btn-ghost btn-copy-mmd" type="button">复制 Mermaid 代码</button>'
      + '</div>';
  }

  function bindCopy(root, code) {
    const b = root.querySelector('.btn-copy-mmd');
    if (!b) return;
    b.addEventListener('click', () => {
      const done = () => { b.textContent = '已复制 ✓'; setTimeout(() => { b.textContent = '复制 Mermaid 代码'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done).catch(fallback);
      } else fallback();
      function fallback() {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { b.textContent = '复制失败，请手动选中'; }
        document.body.removeChild(ta);
      }
    });
  }

  /**
   * 把 code 渲染到 container。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function render(code, container) {
    const src = String(code || '').trim();
    if (!src) {
      container.innerHTML = '<div class="mmd-empty">（没有关系图数据）</div>';
      return { ok: false, error: 'empty' };
    }
    if (!init()) {
      container.innerHTML = rawBlock(src, 'Mermaid 渲染库未加载，下面是原始代码');
      bindCopy(container, src);
      return { ok: false, error: 'no_lib' };
    }
    const id = 'mmd' + (++seq) + '_' + Date.now().toString(36);
    try {
      if (typeof window.mermaid.parse === 'function') {
        await window.mermaid.parse(src);         // 先验语法：不合法直接走兜底，避免半成品 SVG
      }
      const out = await window.mermaid.render(id, src);
      cleanup(id);
      container.innerHTML = out && out.svg ? out.svg : '';
      if (!container.innerHTML.trim()) throw new Error('empty svg');
      return { ok: true };
    } catch (e) {
      cleanup(id);
      container.innerHTML = rawBlock(src, '关系图渲染失败（' + ((e && e.message) || '语法错误').slice(0, 80) + '），下面是原始代码');
      bindCopy(container, src);
      return { ok: false, error: (e && e.message) || 'render_error' };
    }
  }

  window.AeroMermaid = { render: render, rawBlock: rawBlock, available: () => !!window.mermaid, init: init };
})();
