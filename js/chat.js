/* ═══════════════════════════════════════════════
   AI 问答窗口（Chat Widget）— 右下角悬浮即时对话框
   ───────────────────────────────────────────────
   提问链路（RAG）：
     ① 本地知识图谱检索：KG.search 关键词命中 + 一跳关系扩展
     ② 组装 context（概念·定义·书页出处·关系）
     ③ POST /api/chat（本站 Node 服务端代理 → 智谱 glm-4-flash）
     ④ 回答渲染在对话框内，附「相关概念」chips 可点击跳转图谱
   降级：
     页面背后没有后端（如直接双击打开本地文件）时，
     对话框内给出提示，不弹系统错误、不影响其余功能。
   API Key 只存在服务端（环境变量或 server-config.json），前端零密钥。
   ═══════════════════════════════════════════════ */
(function () {
  const ENDPOINT = '/api/chat';
  const TIMEOUT_MS = 35000;   // 客户端超时（服务端 28s 熔断在前）
  const MAX_CONTEXT = 11000;  // api/chat.js 限 12000，留余量
  const MAX_PROMPT = 3900;    // api/chat.js 限 4000，留余量
  const HISTORY_TURNS = 2;    // 每次携带最近 N 轮对话作为上下文
  const KEEP_TURNS = 10;      // 内存中保留的对话轮数

  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 极简行内渲染：**加粗** + 换行
  const rich = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

  let fab, panel, msgsBox, input, sendBtn, typingEl = null;
  let sending = false;
  const history = [];   // [{ q, a }]

  /* ─────────── DOM 构建（自注入，index.html 只需引一个 script） ─────────── */
  function build() {
    fab = document.createElement('button');
    fab.id = 'chatFab';
    fab.className = 'chat-fab';
    fab.title = 'AI 问答助手';
    fab.setAttribute('aria-label', '打开 AI 问答');
    fab.innerHTML = '💬<span class="fab-dot"></span>';
    fab.addEventListener('click', toggle);
    document.body.appendChild(fab);

    panel = document.createElement('div');
    panel.id = 'chatPanel';
    panel.className = 'chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.innerHTML = `
      <div class="chat-head">
        <span class="ch-emoji">🤖</span>
        <div class="ch-title"><b>AI 问答助手</b><span>依据教材知识图谱 · 即时问答</span></div>
        <button id="chatClear" title="清空对话">🧹</button>
        <button id="chatClose" title="收起">✕</button>
      </div>
      <div class="chat-msgs" id="chatMsgs"></div>
      <div class="chat-input-row">
        <input id="chatInput" type="text" maxlength="500" placeholder="问我任何航空航天问题…" autocomplete="off">
        <button class="chat-send" id="chatSend" title="发送" aria-label="发送">➤</button>
      </div>
      <div class="chat-foot-hint">回答由 AI 依据《航空航天概论》知识图谱生成，仅供参考</div>`;
    document.body.appendChild(panel);

    msgsBox = panel.querySelector('#chatMsgs');
    input = panel.querySelector('#chatInput');
    sendBtn = panel.querySelector('#chatSend');
    panel.querySelector('#chatClose').addEventListener('click', toggle);
    panel.querySelector('#chatClear').addEventListener('click', () => {
      history.length = 0;
      msgsBox.innerHTML = '';
      welcome();
      input.focus();
    });
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    welcome();
  }

  function welcome() {
    addMsg('ai', '你好！我是本站的 AI 问答助手 🛰️\n教材的知识都装在我背后那张图谱里 —— 直接提问就好，比如：**为什么飞机能飞起来？**、**涡扇和涡喷有什么区别？**\n（回答通常需要几秒钟）');
  }

  function toggle() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) setTimeout(() => input.focus(), 120);
  }

  function scrollBottom() { msgsBox.scrollTop = msgsBox.scrollHeight; }

  function addMsg(role, text, hits, isError) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-' + role + (isError ? ' error' : '');
    let html = '<div class="msg-text">' + rich(text) + '</div>';
    if (role === 'ai' && hits && hits.length) {
      html += '<div class="msg-chips"><span class="chips-label">相关概念：</span>' +
        hits.slice(0, 4).map(n => '<span class="msg-chip" data-id="' + esc(n.id) + '">' + esc(n.name) + '</span>').join('') +
        '</div>';
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll('.msg-chip').forEach(el =>
      el.addEventListener('click', () => {
        // 移动端：先收起面板，让出详情抽屉
        if (window.matchMedia('(max-width: 900px)').matches) panel.classList.remove('open');
        if (window.App) App.openNode(el.dataset.id, { fromSearch: true });
      }));
    msgsBox.appendChild(wrap);
    scrollBottom();
  }

  function showTyping() {
    hideTyping();
    typingEl = document.createElement('div');
    typingEl.className = 'chat-typing';
    typingEl.innerHTML = '<i></i><i></i><i></i>';
    msgsBox.appendChild(typingEl);
    scrollBottom();
  }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }
  function setSending(v) { sending = v; sendBtn.disabled = v; }

  /* ─────────── 检索：问题→节点（闭式词表反向包含 + 滑窗兜底）→ 一跳扩展 ───────────
     用户问的是完整句子（如「为什么飞机能飞起来？」），
     KG.search 是「名字包含查询词」的子串匹配，对整句必然落空；
     因此主策略反过来：节点名 / 别名 是否出现在问题里（词表封闭，约150节点，O(N)），
     全落空时再用 2-4 字滑窗走 KG.search 兜底（命中定义 / 别名文本）。 */
  function retrieve(q) {
    const KG = AeroKG;
    const score = {};
    const add = (n, w) => { if (n && n.id) score[n.id] = (score[n.id] || 0) + w; };

    // ① 反向包含：节点名 / 别名出现在问题中，名字越长权重越高
    KG.nodes.forEach(n => {
      if (n.name && n.name.length >= 2 && q.indexOf(n.name) >= 0) add(n, 10 + n.name.length);
      (n.aliases || []).forEach(a => { if (a && a.length >= 2 && q.indexOf(a) >= 0) add(n, 6 + a.length); });
    });

    // ② 兜底：2-4 字滑窗正向检索（长窗优先，命中定义/别名文本）
    if (!Object.keys(score).length) {
      const grams = [];
      for (let L = Math.min(4, q.length); L >= 2; L--)
        for (let i = 0; i + L <= q.length; i++) grams.push(q.slice(i, i + L));
      grams.slice(0, 60).forEach(g =>
        KG.search(g, 3).forEach(h => add(h, (h._score || 1) * 0.1)));
    }

    let hits = Object.keys(score).sort((a, b) => score[b] - score[a])
      .map(id => KG.nodeMap[id]).filter(Boolean);
    if (!hits.length) hits = KG.search(q, 6);
    hits = hits.slice(0, 6);

    const picked = [], seen = new Set();
    const push = (n, top) => {
      if (n && !seen.has(n.id) && picked.length < 10) { seen.add(n.id); picked.push({ n: n, top: top }); }
    };
    hits.forEach(h => push(h, true));
    // 从前 3 个命中节点沿边扩展邻居（因果/关联优先），给模型更多图谱上下文
    hits.slice(0, 3).forEach(h => {
      KG.edgesOf(h.id).slice()
        .sort((a, b) => ((b.type === '因果') - (a.type === '因果')) || ((b.type === '关联') - (a.type === '关联')))
        .forEach(e => push(KG.nodeMap[e.s === h.id ? e.t : e.s], false));
    });

    let context = '';
    for (const p of picked) {
      const n = p.n;
      const rels = KG.edgesOf(n.id).map(e => {
        const other = KG.nodeMap[e.s === n.id ? e.t : e.s];
        if (!other) return '';
        return (e.s === n.id ? '→' : '←') + other.name + '（' + e.type + '）';
      }).filter(Boolean).slice(0, 5).join('；');
      const line = '【' + n.name + '】(' + n.id + ' · ' + (KG.categories[n.category] || n.category) +
        (n.evidence ? ' · ' + n.evidence : '') + ')：' + (n.definition || '') +
        (p.top && n.detail ? ' 详解：' + String(n.detail).slice(0, 130) : '') +
        (rels ? ' 关系：' + rels : '');
      if (context.length + line.length > MAX_CONTEXT) break;
      context += line + '\n';
    }
    return { context: context.trim(), topHits: hits.slice(0, 4) };
  }

  /* ─────────── 提示词组装（含最近对话，支持追问） ─────────── */
  function buildPrompt(q) {
    const lines = [
      '你是「航空航天知识图谱」网站的 AI 问答助手，依据《航空航天概论》第3版第2章（飞行原理）、第3章（动力装置）回答学习者的问题。',
      '回答要求：',
      '1) 简体中文，条理清晰，控制在 300 字以内；',
      '2) 优先依据【参考资料】回答，可补充教材范围内的常识；超出资料和教材范围的部分必须明确说明「教材未涉及」，不要编造；',
      '3) 涉及概念时使用参考资料中的标准名称；',
      '4) 禁止 markdown 标题和代码块，可用「①②」或短横行分点。'
    ];
    if (history.length) {
      lines.push('', '【最近对话】');
      history.slice(-HISTORY_TURNS).forEach(h => {
        lines.push('问：' + h.q, '答：' + String(h.a).slice(0, 180));
      });
    }
    lines.push('', '【用户问题】' + q);
    return lines.join('\n').slice(0, MAX_PROMPT);
  }

  /* ─────────── 错误 → 用户能看懂的一句话 ─────────── */
  function friendlyError(err, status, data) {
    const hint = data && data.error ? String(data.error) : '';
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'AI 响应超时了，请稍后重试。';
    if (err instanceof TypeError) return '连不上 AI 服务 —— 当前页面背后没有可用的后端（例如直接双击打开的本地文件）。用 `node server.js` 启动本站、或访问已发布的服务地址，即可正常问答。';
    if (status === 404) return '当前页面没有 /api/chat 接口（看起来是纯静态托管）。请以 Node 服务方式运行本站，AI 问答才会生效。';
    if (status === 500 && hint.includes('ZHIPU_API_KEY')) return '服务器还没配置 AI 密钥：请设置环境变量 ZHIPU_API_KEY，或在项目根目录创建 server-config.json 填入智谱 API Key。';
    if (hint.includes('401')) return '智谱 API Key 无效或已过期：请到智谱开放平台重新生成后更新服务器配置。';
    if (status === 504) return 'AI 响应超时了，请稍后重试。';
    if (status === 413) return '问题太长了，请缩短后再试。';
    return 'AI 服务暂时不可用（' + (status || '网络异常') + '），请稍后重试。';
  }

  /* ─────────── 发送 ─────────── */
  async function send() {
    if (sending) return;
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    input.value = '';
    addMsg('user', q);
    setSending(true);
    showTyping();
    try {
      const ret = retrieve(q);
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: buildPrompt(q), context: ret.context }),
        signal: (window.AbortSignal && AbortSignal.timeout) ? AbortSignal.timeout(TIMEOUT_MS) : undefined
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw Object.assign(new Error('http_' + res.status), { __status: res.status, __data: data });
      const answer = data && data.answer;
      if (!answer) throw Object.assign(new Error('empty_answer'), { __status: 502 });
      addMsg('ai', answer, ret.topHits);
      history.push({ q: q, a: answer });
      if (history.length > KEEP_TURNS) history.shift();
    } catch (err) {
      addMsg('ai', friendlyError(err, err && err.__status, err && err.__data), null, true);
    } finally {
      hideTyping();
      setSending(false);
      input.focus();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
