/* ═══════════════════════════════════════════════
   轻量用户身份（复用本站既有的 localStorage 匿名体系）
   ───────────────────────────────────────────────
   本站没有登录系统，原有的"用户"概念就是浏览器本地身份
   （足迹 aerokg_trail_v1 也是这么存的）。笔记本 / 卡片 / 复习
   记录沿用同一套：本地生成一个稳定 uid，通过 X-User-Id 交给
   服务端做数据隔离；换浏览器就是另一个用户，互不影响。
   ═══════════════════════════════════════════════ */
(function () {
  const KEY = 'aerokg_uid_v1';
  const NICK = 'aerokg_nick_v1';

  function pick() {
    let id = '';
    try { id = localStorage.getItem(KEY) || ''; } catch (e) { /* 隐私模式 */ }
    if (!id) {
      id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem(KEY, id); } catch (e) { /* 忽略：本次会话内仍可用 */ }
    }
    return id;
  }

  let nickname = '';
  try { nickname = localStorage.getItem(NICK) || ''; } catch (e) {}

  window.AeroUser = {
    id: pick(),
    get nickname() { return nickname; },
    setNickname(v) {
      nickname = String(v || '').slice(0, 20);
      try { localStorage.setItem(NICK, nickname); } catch (e) {}
      return nickname;
    },
    /** 界面上的显示名（没设昵称就用 uid 后 4 位） */
    label() { return nickname || ('本机用户 · ' + this.id.slice(-4)); }
  };
})();
