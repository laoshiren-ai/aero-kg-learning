/* ═══════════════════════════════════════════════════════════════
   AeroRetrieve — 面向 LLM 的图谱检索（chat.js 与 app.js 共用）

   为什么不能直接用 KG.search：
     KG.search 是「节点名包含查询词」的正向子串匹配。用户在对话框 /
     探索框里输入的是**整句问句**（「为什么飞机能飞起来？」），正向匹配
     必然一条都命中不了 —— 检索结果为空，模型只能自己编概念 id。

   所以主策略反过来：判断**节点名 / 别名是否出现在问题里**（词表封闭，
   约 150 个节点，O(N) 足够快）；全落空时再用 2-4 字滑窗走 KG.search
   兜底（命中节点定义 / 别名文本）。

   对外接口：
     AeroRetrieve.hits(q, limit)          → 命中节点数组（已按相关度排序）
     AeroRetrieve.summary(q, limit)       → "id | 名称 | 定义" 多行文本（给 LLM 看）
     AeroRetrieve.context(q, opts)        → { context, topHits }  富上下文（RAG）
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const MAX_CONTEXT = (global.AeroChatCfg && global.AeroChatCfg.maxContext) || 11000;

  /* 反向包含 + 滑窗兜底 → 相关节点排序 */
  function hits(q, limit) {
    const KG = global.AeroKG;
    limit = limit || 6;
    if (!KG || !q) return [];
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

    let out = Object.keys(score).sort((a, b) => score[b] - score[a])
      .map(id => KG.nodeMap[id]).filter(Boolean);
    if (!out.length) out = KG.search(q, limit);       // 最后再退回原搜索
    return out.slice(0, limit);
  }

  /* 一跳关系扩展：命中节点 + 因果/关联优先的邻居 */
  function pickWithNeighbors(hitted, maxTotal) {
    const KG = global.AeroKG;
    const picked = [], seen = new Set();
    const push = (n, top) => {
      if (n && !seen.has(n.id) && picked.length < maxTotal) { seen.add(n.id); picked.push({ n: n, top: !!top }); }
    };
    hitted.forEach(h => push(h, true));
    hitted.slice(0, 3).forEach(h => {
      KG.edgesOf(h.id).slice()
        .sort((a, b) => ((b.type === '因果') - (a.type === '因果')) || ((b.type === '关联') - (a.type === '关联')))
        .forEach(e => push(KG.nodeMap[e.s === h.id ? e.t : e.s], false));
    });
    return picked;
  }

  function relLine(n) {
    const KG = global.AeroKG;
    return KG.edgesOf(n.id).map(e => {
      const other = KG.nodeMap[e.s === n.id ? e.t : e.s];
      if (!other) return '';
      return (e.s === n.id ? '→' : '←') + other.name + '（' + e.type + '）';
    }).filter(Boolean).slice(0, 5).join('；');
  }

  /* 给 LLM 的精简清单：id | 名称 | 定义（路径规划要点名 id，所以 id 必须在前）
     必须带上「一跳邻居」：只给直接命中的节点时，抽象问题往往只命中 1 个节点，
     模型没有可用的合法 id，就会从定义文本里硬造概念名 → 全部校验失败 → 白白回退。 */
  function summary(q, limit) {
    limit = limit || 12;
    const picked = pickWithNeighbors(hits(q, limit), limit + 6);
    return picked
      .map(p => [p.n.id, p.n.name, String(p.n.definition || '').slice(0, 50)].join(' | '))
      .join('\n');
  }

  /* 富上下文：概念名 · id · 类别 · 书页出处 · 定义（+详解）· 关系 */
  function context(q, opts) {
    const KG = global.AeroKG;
    const maxLen = (opts && opts.maxLen) || MAX_CONTEXT;
    const top = hits(q, (opts && opts.hits) || 6);
    const picked = pickWithNeighbors(top, (opts && opts.maxNodes) || 10);

    let ctx = '';
    for (const p of picked) {
      const n = p.n;
      const rels = relLine(n);
      const line = '【' + n.name + '】(' + n.id + ' · ' + (KG.categories[n.category] || n.category) +
        (n.evidence ? ' · ' + n.evidence : '') + ')：' + (n.definition || '') +
        (p.top && n.detail ? ' 详解：' + String(n.detail).slice(0, 130) : '') +
        (rels ? ' 关系：' + rels : '');
      if (ctx.length + line.length > maxLen) break;
      ctx += line + '\n';
    }
    return { context: ctx.trim(), topHits: top.slice(0, 4) };
  }

  global.AeroRetrieve = { hits: hits, summary: summary, context: context };
})(typeof window !== 'undefined' ? window : globalThis);
