/* ═══════════════════════════════════════════════
   搜索 — 拼音无关的中文前缀/包含匹配 + 别名
   ═══════════════════════════════════════════════ */
(function () {
  const input = document.getElementById('searchInput');
  const box = document.getElementById('searchResults');
  let activeIdx = -1, items = [];

  function render(kw) {
    const KG = window.AeroKG;
    if (!kw.trim()) { box.classList.remove('open'); return; }
    const hits = KG.search(kw, 10);
    items = hits; activeIdx = -1;
    if (!hits.length) {
      box.innerHTML = `<div class="sr-empty">没有找到「${escapeHtml(kw)}」相关的知识点<br><span style="font-size:11px">试试：升力、伯努利、涡扇、火箭、失速、马赫数</span></div>`;
      box.classList.add('open'); return;
    }
    box.innerHTML = hits.map((h, i) => `
      <div class="sr-item" data-id="${h.id}">
        <span class="sr-dot" style="background:${KG.catColor(h.category)}"></span>
        <span class="sr-name">${highlight(h.name, kw)}</span>
        <span class="sr-cat">${KG.categories[h.category] || ''}</span>
      </div>`).join('');
    box.classList.add('open');
    box.querySelectorAll('.sr-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        pick(el.dataset.id);
      });
    });
  }

  function pick(id) {
    box.classList.remove('open');
    input.value = '';
    window.App.openNode(id, { fromSearch: true });
  }

  function highlight(name, kw) {
    const i = name.indexOf(kw);
    if (i < 0) return escapeHtml(name);
    return escapeHtml(name.slice(0, i)) + '<b style="color:var(--accent)">' + escapeHtml(kw) + '</b>' + escapeHtml(name.slice(i + kw.length));
  }
  function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('focus', () => { if (input.value) render(input.value); });
  input.addEventListener('blur', () => setTimeout(() => box.classList.remove('open'), 150));
  input.addEventListener('keydown', e => {
    if (!box.classList.contains('open')) return;
    const els = box.querySelectorAll('.sr-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, els.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && els[activeIdx]) pick(els[activeIdx].dataset.id);
      else if (items.length) pick(items[0].id);
      return;
    } else if (e.key === 'Escape') { box.classList.remove('open'); return; }
    else return;
    els.forEach((el, i) => el.classList.toggle('hot', i === activeIdx));
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.searchbox')) box.classList.remove('open');
  });
})();
