/* ═══════════════════════════════════════════════════════════════
   AeroLightbox — 全局图片放大查看器（零依赖，全屏 / 拖拽 / 滚轮缩放）
   ───────────────────────────────────────────────────────────────
   用法：
     AeroLightbox.init()            // 首次初始化（自动建 DOM + 事件委托）
     AeroLightbox.refresh(root)     // 详情页等"后插入的图片"渲染完后重新触发绑定
     AeroLightbox.open(src, cap)    // 手动打开
   约定：任何带 class="zoomable"（或 data-zoomable）的 <img> 点击即全屏放大。
   ───────────────────────────────────────────────────────────────
   为什么用「事件委托」而不是逐张 addEventListener：
     详情面板每次 openNode 都会重写 innerHTML，旧的监听随元素一起被丢弃。
     把监听挂在 document 上，后插入的图片天然可用 —— refresh() 只是显式调用的
     兼容入口（对应"medium-zoom 初始化"的用法），保证"重新触发"这件事一定有。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  const MIN = 1, MAX = 8;

  const S = {
    built: false,
    open: false,
    scale: 1, tx: 0, ty: 0,
    drag: null,          // { x, y, tx, ty }
    moved: 0,            // 本次按下累计位移（区分"点击"与"拖拽"）
    fromBackdrop: false, // 按下时命中的是不是背景（不是图片）
    pinch: null,         // { dist, scale }
    lastTap: 0,
    el: {}               // { overlay, stage, img, cap, zoomTxt }
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ── 构建遮罩 DOM（只建一次） ── */
  function build() {
    if (S.built) return;
    const wrap = document.createElement('div');
    wrap.className = 'alb-overlay';
    wrap.id = 'albOverlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '图片放大查看器');
    wrap.innerHTML = `
      <div class="alb-bar">
        <div class="alb-cap" id="albCap"></div>
        <div class="alb-tools">
          <span class="alb-zoomtxt" id="albZoomTxt">100%</span>
          <button class="alb-btn" data-alb="out" title="缩小（滚轮向下）" aria-label="缩小">−</button>
          <button class="alb-btn" data-alb="in" title="放大（滚轮向上）" aria-label="放大">＋</button>
          <button class="alb-btn" data-alb="reset" title="复位（双击图片）" aria-label="复位">⤢</button>
          <button class="alb-btn alb-close" data-alb="close" title="关闭（Esc）" aria-label="关闭">✕</button>
        </div>
      </div>
      <div class="alb-stage" id="albStage">
        <img class="alb-img" id="albImg" alt="" draggable="false">
      </div>
      <div class="alb-hint">滚轮缩放 · 按住拖拽移动 · 双击复位 · Esc 关闭</div>`;
    document.body.appendChild(wrap);

    S.el = {
      overlay: wrap,
      stage: wrap.querySelector('#albStage'),
      img: wrap.querySelector('#albImg'),
      cap: wrap.querySelector('#albCap'),
      zoomTxt: wrap.querySelector('#albZoomTxt')
    };

    /* 工具条 */
    wrap.querySelector('.alb-tools').addEventListener('click', e => {
      const b = e.target.closest('[data-alb]');
      if (!b) return;
      const a = b.dataset.alb;
      if (a === 'close') close();
      else if (a === 'reset') reset();
      else if (a === 'in') zoomAt(1.25);
      else if (a === 'out') zoomAt(1 / 1.25);
    });

    /* 点背景（非图片）关闭。
       注意：setPointerCapture 会把拖拽结束后的合成 click 重定向到 stage，
       所以不能只看 e.target —— 必须同时要求「按下时命中背景」且「几乎没移动」。
       否则用户拖一下图片就会误关查看器。 */
    S.el.stage.addEventListener('click', () => {
      if (!S.fromBackdrop) return;
      if (S.moved > 4) return;
      close();
    });

    /* 滚轮缩放（以指针为中心） */
    S.el.stage.addEventListener('wheel', e => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      zoomTo(S.scale * f, e.clientX, e.clientY);
    }, { passive: false });

    /* 拖拽平移 + 触摸双指缩放 */
    const stage = S.el.stage;
    stage.addEventListener('pointerdown', e => {
      S.moved = 0;
      // 必须在 setPointerCapture 之前取 e.target（捕获后事件会被重定向）
      S.fromBackdrop = (e.target === stage);
      stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
      S.drag = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty };
      S.el.overlay.classList.add('dragging');
    });
    stage.addEventListener('pointermove', e => {
      if (!S.drag) return;
      const dx = e.clientX - S.drag.x, dy = e.clientY - S.drag.y;
      S.moved = Math.max(S.moved, Math.abs(dx) + Math.abs(dy));
      S.tx = S.drag.tx + dx;
      S.ty = S.drag.ty + dy;
      apply();
    });
    const endDrag = e => {
      S.drag = null;
      S.el.overlay.classList.remove('dragging');
      if (stage.releasePointerCapture && e && e.pointerId != null) {
        try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
      }
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    /* 双击：1x ⇄ 2.2x */
    stage.addEventListener('dblclick', e => {
      e.preventDefault();
      if (S.scale > 1.05) reset();
      else zoomTo(2.2, e.clientX, e.clientY);
    });

    /* 移动端双指捏合 */
    stage.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        S.drag = null;
        S.pinch = { dist: dist2(e.touches), scale: S.scale };
      }
    }, { passive: true });
    stage.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && S.pinch) {
        e.preventDefault();
        const f = dist2(e.touches) / (S.pinch.dist || 1);
        zoomTo(S.pinch.scale * f, (e.touches[0].clientX + e.touches[1].clientX) / 2,
          (e.touches[0].clientY + e.touches[1].clientY) / 2);
      }
    }, { passive: false });
    stage.addEventListener('touchend', () => { S.pinch = null; }, { passive: true });

    /* Esc 关闭 */
    document.addEventListener('keydown', e => {
      if (!S.open) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === '0') reset();
      else if (e.key === '+' || e.key === '=') zoomAt(1.25);
      else if (e.key === '-') zoomAt(1 / 1.25);
    });

    /* 统一入口：事件委托 —— 后插入的 .zoomable 图片自动生效 */
    document.addEventListener('click', e => {
      const t = e.target.closest('img.zoomable, [data-zoomable]');
      if (!t) return;
      e.preventDefault();
      open(t.getAttribute('data-src') || t.currentSrc || t.src,
        t.getAttribute('data-caption') || t.getAttribute('alt') || '');
    });

    S.built = true;
  }

  function dist2(ts) {
    const dx = ts[0].clientX - ts[1].clientX, dy = ts[0].clientY - ts[1].clientY;
    return Math.hypot(dx, dy);
  }

  function apply() {
    S.el.img.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.scale})`;
    if (S.el.zoomTxt) S.el.zoomTxt.textContent = Math.round(S.scale * 100) + '%';
  }

  /* 以视口坐标 (cx, cy) 为不动点缩放到 target */
  function zoomTo(target, cx, cy) {
    const s = clamp(target, MIN, MAX);
    const r = S.el.stage.getBoundingClientRect();
    const vx = cx - r.left - r.width / 2;
    const vy = cy - r.top - r.height / 2;
    const ratio = s / S.scale;
    S.tx = vx - ratio * (vx - S.tx);
    S.ty = vy - ratio * (vy - S.ty);
    S.scale = s;
    apply();
  }
  /* 以画面中心缩放（工具条 +/- 用） */
  function zoomAt(f) {
    const r = S.el.stage.getBoundingClientRect();
    zoomTo(S.scale * f, r.left + r.width / 2, r.top + r.height / 2);
  }
  function reset() { S.scale = 1; S.tx = 0; S.ty = 0; apply(); }

  function open(src, caption) {
    if (!src) return;
    build();
    S.el.img.src = src;
    S.el.img.alt = caption || '';
    S.el.cap.textContent = caption || '';
    S.el.cap.style.display = caption ? '' : 'none';
    S.el.overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
    S.open = true;
    reset();
  }
  function close() {
    if (!S.built) return;
    S.el.overlay.classList.remove('show');
    document.body.style.overflow = '';
    S.open = false;
    S.drag = null; S.pinch = null;
  }

  /* 显式"重新触发"入口：详情页 new HTML 渲染完后调用 */
  function refresh(root) {
    build();
    const scope = root || document;
    // 事件委托已覆盖新图片；这里只做一次"可点性"标记，便于排查与样式联动
    scope.querySelectorAll('img.zoomable, [data-zoomable]').forEach(img => {
      img.setAttribute('data-zoom-bound', '1');
      img.style.cursor = 'zoom-in';
    });
    return scope.querySelectorAll('img.zoomable, [data-zoomable]').length;
  }

  window.AeroLightbox = {
    init: function (root) { build(); return refresh(root); },
    refresh: refresh,
    open: open,
    close: close,
    reset: reset,
    isOpen: function () { return S.open; },
    _state: S
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => build());
  } else {
    build();
  }
})();
