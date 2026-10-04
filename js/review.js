/* ═══════════════════════════════════════════════════════════════
   复习页（知识卡片 · 间隔重复）
   ───────────────────────────────────────────────────────────────
   · 取「今日到期」卡片 → 正面 → 点击翻面 → 背面
   · 三档反馈：忘了 / 模糊 / 记得（按钮上直接标出"下次什么时候再见"）
   · 提交后 due / interval / ease / reps 按简化 SM-2 更新
   · 答「忘了」自动请求 AI 解释（也可手动点「AI 解释」）
   · 可选「选择题模式」：AI 根据卡片临时出一道单选
   快捷键：空格翻面，1 / 2 / 3 = 忘了 / 模糊 / 记得
   ═══════════════════════════════════════════════════════════════ */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const S = {
    loaded: false,
    cards: [],
    i: 0,
    flipped: false,
    busy: false,
    done: 0,
    stat: { again: 0, hard: 0, good: 0 },
    lastResult: null,
    awaitNext: false,       // 答「忘了」后停留在此卡看解释，等用户点「继续下一张」
    explain: null,          // { loading, text, notice }
    quizMode: false,
    quiz: null,             // { loading, stem, options, answer_index, explanation, picked, notice }
    local: false
  };

  function fmtWhen(due) {
    if (!due) return '—';
    const days = (due - Date.now()) / 86400000;
    if (days < 0.5) return '今天内';
    const d = Math.round(days);
    return d === 1 ? '明天' : (d + ' 天后');
  }

  async function load() {
    const host = $('reviewMain');
    if (host) host.innerHTML = '<div class="rv-empty">加载中…</div>';
    try {
      const res = await AeroAPI.dueCards({ limit: 60 });
      S.cards = res.cards || [];
      S.local = !!res.local;
      S.i = 0; S.flipped = false; S.done = 0;
      S.stat = { again: 0, hard: 0, good: 0 };
      S.lastResult = null; S.explain = null; S.quiz = null;
      S.awaitNext = false;
      S.loaded = true;
      updateBadge(res.total_due || 0);
    } catch (e) {
      if (host) host.innerHTML = '<div class="rv-empty">读取失败：' + esc(e.message) + '</div>';
      return;
    }
    render();
  }

  function updateBadge(n) {
    const b = $('navDueBadge');
    if (!b) return;
    if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = ''; }
    else b.style.display = 'none';
  }

  /* ────────── 渲染 ────────── */
  function render() {
    const host = $('reviewMain');
    if (!host) return;
    const total = S.cards.length;

    if (!total) {
      host.innerHTML = `<div class="rv-empty">
        <div class="nh-icon">🎉</div>
        <h3>今天没有到期卡片</h3>
        <p>间隔重复的节奏就是——到期才复习，没到期不用刷。<br>
        去「笔记本」给笔记生成卡片，或者明天再来。</p>
        <div class="rv-actions">
          <button class="btn-primary" id="rvToNotes">📒 去笔记本生成卡片</button>
          <button class="btn-ghost" id="rvRefresh">↻ 刷新</button>
        </div>
        ${S.local ? '<div class="sm-note">当前是本地模式：数据存在这台浏览器里。</div>' : ''}
      </div>`;
      $('rvToNotes').addEventListener('click', () => { const b = document.querySelector('[data-view="notes"]'); if (b) b.click(); });
      $('rvRefresh').addEventListener('click', load);
      return;
    }

    if (S.i >= total) { renderDone(host); return; }
    const card = S.cards[S.i];

    host.innerHTML = `
      <div class="rv-wrap">
        <div class="rv-top">
          <div class="rv-progress"><b>${S.i + 1}</b> / ${total}</div>
          <div class="rv-counts">
            <span class="rc again">忘了 ${S.stat.again}</span>
            <span class="rc hard">模糊 ${S.stat.hard}</span>
            <span class="rc good">记得 ${S.stat.good}</span>
          </div>
          <label class="rv-quiz-toggle"><input type="checkbox" id="rvQuizMode" ${S.quizMode ? 'checked' : ''}> 选择题模式</label>
        </div>

        ${card.note_title ? `<div class="rv-note-src">来自笔记：${esc(card.note_title)}</div>` : ''}

        <div class="rv-card ${S.flipped ? 'flipped' : ''}" id="rvCard">
          <div class="rv-face">
            <div class="rv-face-label">正面 · 想清楚再翻</div>
            <div class="rv-q">${esc(card.front)}</div>
            ${S.flipped ? '' : '<div class="rv-flip-hint">点击卡片翻面（或按空格）</div>'}
          </div>
          ${S.flipped ? `<div class="rv-face rv-back">
            <div class="rv-face-label">背面 · 正确答案</div>
            <div class="rv-a">${esc(card.back)}</div>
            ${(card.tags || []).length ? '<div class="rv-tags">' + card.tags.map(t => '<span class="ni-tag">' + esc(t) + '</span>').join('') + '</div>' : ''}
          </div>` : ''}
        </div>

        ${S.quizMode ? quizHtml(card) : ''}
        ${S.explain ? explainHtml() : ''}

        <div class="rv-btns" id="rvBtns">
          ${S.awaitNext
            ? '<button class="btn-primary rv-continue" id="rvNext">继续下一张 →</button>'
            : (S.flipped ? ratingButtons(card) : '<button class="btn-primary rv-show" id="rvShow">显示答案</button>')}
        </div>

        <div class="rv-foot">
          ${S.awaitNext ? '<span class="rv-kbd">看完解释后点「继续下一张」，或按空格 / 回车</span>'
            : `<button class="btn-ghost btn-sm" id="rvExplainBtn" ${S.explain && S.explain.loading ? 'disabled' : ''}>🤖 AI 解释这张卡</button>
          <span class="rv-kbd">快捷键：空格翻面 · 1 忘了 · 2 模糊 · 3 记得</span>`}
        </div>
      </div>`;

    bind(card);
  }

  function ratingButtons(card) {
    const p = card.preview || {};
    const lb = r => p[r] ? fmtWhen(p[r].due) : '—';
    return `
      <button class="rv-rate again" data-r="again"><b>忘了</b><span>下次 ${lb('again')}</span></button>
      <button class="rv-rate hard" data-r="hard"><b>模糊</b><span>下次 ${lb('hard')}</span></button>
      <button class="rv-rate good" data-r="good"><b>记得</b><span>下次 ${lb('good')}</span></button>`;
  }

  function explainHtml() {
    const e = S.explain;
    if (e.loading) return '<div class="rv-explain"><div class="rv-explain-head">🤖 AI 解释</div><div class="mmd-loading">正在生成解释…</div></div>';
    if (e.text) return `<div class="rv-explain"><div class="rv-explain-head">🤖 AI 解释</div><div class="rv-explain-body">${esc(e.text).replace(/\n/g, '<br>')}</div></div>`;
    if (e.notice) return `<div class="rv-explain warn"><div class="rv-explain-head">🤖 AI 解释</div><div class="rv-explain-body">${esc(e.notice)}</div></div>`;
    return '';
  }

  function quizHtml(card) {
    const q = S.quiz;
    if (!q) return `<div class="rv-quiz"><div class="rv-quiz-head">📝 选择题模式</div>
      <div class="rv-quiz-body">让 AI 根据这张卡片临时出一道单选题，答完仍由你决定三档反馈。</div>
      <button class="btn-ghost btn-sm" id="rvQuizGen">✨ 出题</button></div>`;
    if (q.loading) return `<div class="rv-quiz"><div class="rv-quiz-head">📝 选择题模式</div><div class="mmd-loading">AI 正在出题…</div></div>`;
    if (q.notice) return `<div class="rv-quiz warn"><div class="rv-quiz-head">📝 选择题模式</div><div class="rv-quiz-body">${esc(q.notice)}</div><button class="btn-ghost btn-sm" id="rvQuizGen">重试</button></div>`;
    const picked = q.picked;
    return `<div class="rv-quiz">
      <div class="rv-quiz-head">📝 选择题 · ${esc(q.stem)}</div>
      <div class="rv-quiz-opts">
        ${q.options.map((o, i) => {
          let cls = '';
          if (picked !== null && picked !== undefined) {
            if (i === q.answer_index) cls = 'right';
            else if (i === picked) cls = 'wrong';
          }
          return `<button class="rv-opt ${cls}" data-i="${i}" ${picked === null || picked === undefined ? '' : 'disabled'}>${String.fromCharCode(65 + i)}. ${esc(o)}</button>`;
        }).join('')}
      </div>
      ${(picked === null || picked === undefined) ? '' : `<div class="rv-quiz-res ${picked === q.answer_index ? 'ok' : 'no'}">
        ${picked === q.answer_index ? '✓ 答对了' : '✗ 答错了'} ${q.explanation ? '— ' + esc(q.explanation) : ''}
      </div>`}
    </div>`;
  }

  /* ────────── 交互 ────────── */
  function bind(card) {
    const host = $('reviewMain');

    const cardEl = $('rvCard');
    if (cardEl) cardEl.addEventListener('click', () => { if (!S.flipped) { S.flipped = true; render(); } });

    const show = $('rvShow');
    if (show) show.addEventListener('click', () => { S.flipped = true; render(); });

    host.querySelectorAll('.rv-rate').forEach(b => b.addEventListener('click', () => rate(b.dataset.r)));

    const eb = $('rvExplainBtn');
    if (eb) eb.addEventListener('click', () => askExplain(card));

    const nx = $('rvNext');
    if (nx) nx.addEventListener('click', next);

    const qt = $('rvQuizMode');
    if (qt) qt.addEventListener('change', () => {
      S.quizMode = qt.checked; S.quiz = null;
      if (S.quizMode && !S.quiz) { render(); genQuiz(card); return; }
      render();
    });
    const qg = $('rvQuizGen');
    if (qg) qg.addEventListener('click', () => genQuiz(card));
    host.querySelectorAll('.rv-opt').forEach(b => b.addEventListener('click', () => {
      if (S.quiz && (S.quiz.picked !== null && S.quiz.picked !== undefined)) return;
      S.quiz.picked = Number(b.dataset.i);
      if (S.quiz.picked !== S.quiz.answer_index) askExplain(card, '（选择题答错，我的选择是：' + S.quiz.options[S.quiz.picked] + '）');
      render();
    }));
  }

  function renderDone(host) {
    host.innerHTML = `<div class="rv-empty">
      <div class="nh-icon">✅</div>
      <h3>本轮完成，共复习 ${S.done} 张</h3>
      <p>忘了 ${S.stat.again} · 模糊 ${S.stat.hard} · 记得 ${S.stat.good}<br>
      「忘了」的卡片明天会再来找你，「记得」的会越走越远。</p>
      <div class="rv-actions">
        <button class="btn-primary" id="rvAgain">看看还有没有到期的</button>
        <button class="btn-ghost" id="rvToNotes2">📒 去笔记本</button>
      </div>
    </div>`;
    $('rvAgain').addEventListener('click', load);
    $('rvToNotes2').addEventListener('click', () => { const b = document.querySelector('[data-view="notes"]'); if (b) b.click(); });
  }

  async function rate(rating) {
    if (S.busy || S.awaitNext) return;
    const card = S.cards[S.i];
    if (!card) return;
    S.busy = true;
    try {
      const res = await AeroAPI.reviewCard(card.id, rating);
      S.stat[rating] = (S.stat[rating] || 0) + 1;
      S.done++;
      S.lastResult = res;
      S.quiz = null;
      if (rating === 'again') {
        // 答错：停留在这张卡上，把正确答案和 AI 解释一起给用户看，看完再继续
        S.flipped = true;
        S.awaitNext = true;
        S.explain = null;                 // 清掉上一张的残留
        askExplain(card);                 // 内部会置 loading 并渲染当前卡
        updateBadge(Math.max(0, S.cards.length - S.i - 1));
      } else {
        S.i++;
        S.flipped = false;
        S.explain = null;
        S.awaitNext = false;
        render();
        updateBadge(Math.max(0, S.cards.length - S.i));
      }
    } catch (e) {
      alert('提交失败：' + e.message);
    } finally {
      S.busy = false;
    }
  }

  function next() {
    if (S.i >= S.cards.length) { render(); return; }
    S.i++;
    S.flipped = false;
    S.awaitNext = false;
    S.explain = null;
    S.quiz = null;
    render();
    updateBadge(Math.max(0, S.cards.length - S.i));
  }

  async function askExplain(card, prefix) {
    if (!card || (S.explain && S.explain.loading)) return;
    S.explain = { loading: true };
    if (S.i < S.cards.length && S.cards[S.i] && S.cards[S.i].id === card.id) render();
    try {
      const res = await AeroAPI.explainCard(card.id, prefix || '');
      S.explain = { loading: false, text: res.text || '', notice: res.notice || '' };
    } catch (e) {
      S.explain = { loading: false, notice: 'AI 解释失败：' + e.message };
    }
    // 只在该卡还显示在屏幕上时才重绘（答「忘了」后卡片会停留，因此解释能正常显示）
    if (S.i < S.cards.length && S.cards[S.i] && S.cards[S.i].id === card.id) render();
  }

  async function genQuiz(card) {
    S.quiz = { loading: true };
    render();
    try {
      const res = await AeroAPI.quizCard(card.id);
      if (res.ok && res.quiz) {
        S.quiz = { loading: false, stem: res.quiz.stem, options: res.quiz.options, answer_index: res.quiz.answer_index, explanation: res.quiz.explanation, picked: null };
      } else {
        S.quiz = { loading: false, notice: res.notice || '出题失败，请重试。' };
      }
    } catch (e) {
      S.quiz = { loading: false, notice: 'AI 出题失败：' + e.message };
    }
    render();
  }

  /* ── 快捷键 ── */
  document.addEventListener('keydown', e => {
    const view = $('view-review');
    if (!view || !view.classList.contains('active')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (S.awaitNext) {                    // 看解释阶段：空格 / 回车 = 继续下一张
      if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); next(); }
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      if (!S.flipped && S.i < S.cards.length) { e.preventDefault(); S.flipped = true; render(); }
      return;
    }
    if (!S.flipped) return;
    if (e.key === '1') rate('again');
    else if (e.key === '2') rate('hard');
    else if (e.key === '3') rate('good');
  });

  window.AeroReview = {
    open() { if (!S.loaded) load(); else render(); },
    refresh() { return load(); },
    badge() { return S.cards.length - S.i; },
    _state: S
  };

  // 打开页面时顺便刷新一下角标
  document.addEventListener('DOMContentLoaded', () => {
    AeroAPI.dueCards({ limit: 1 }).then(r => updateBadge(r.total_due || 0)).catch(() => {});
  });
})();
