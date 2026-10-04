/**
 * ═══════════════════════════════════════════════════════════
 * 服务端知识图谱访问（读 data/kg.js，与前端同一份数据）
 * ───────────────────────────────────────────────────────────
 * data/kg.js 是浏览器脚本（window.AeroKG = {...}），这里用 node:vm
 * 造一个最小 window 沙箱把它跑起来 —— 零依赖，且**单一数据源**：
 * 前端图谱、后端检索永远一致，不会各自维护一份。
 *
 * 对外能力：
 *   resolve(keywords, chapterId)   关键词 → 图谱节点（名称/别名/模糊三级）
 *   pairRelations(nodes, extra)    选中节点之间的两两关系（含书页证据）
 *   buildContext(nodes, pairs)     组装"教材片段"给 LLM
 *   fallbackMermaid(nodes, pairs)  不带 AI 时也能画出的关系总图
 * ═══════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const KG_FILE = path.join(ROOT, 'data', 'kg.js');

/* 五类关系的中文说法（用于提示词与兜底文案） */
const REL_CN = {
  '从属': '从属关系',
  '包含': '包含关系',
  '并列': '并列关系',
  '关联': '关联关系',
  '因果': '因果关系'
};
/* 关系图连线上的短标签 */
const REL_SHORT = { '从属': '从属', '包含': '包含', '并列': '并列', '关联': '关联', '因果': '因果' };

let KG = null;
let loadError = null;

function kg() {
  if (KG) return KG;
  if (loadError) return null;
  try {
    const code = fs.readFileSync(KG_FILE, 'utf8');
    const sandbox = { window: {}, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'data/kg.js' });
    const loaded = sandbox.window.AeroKG;
    if (!loaded || !Array.isArray(loaded.nodes)) throw new Error('data/kg.js 未导出 AeroKG.nodes');
    loaded.prepare();
    KG = loaded;
    return KG;
  } catch (e) {
    loadError = e.message;
    return null;
  }
}

function available() { return !!kg(); }
function meta() {
  const G = kg();
  if (!G) return { ok: false, error: loadError };
  return { ok: true, nodes: G.nodes.length, edges: G.edges.length, source: (G.meta && G.meta.source) || '' };
}

/* ── 章节归一化 ──
   前端可能传 'ch2' / '2' / '第2章' / 'engine'（类别键）。识别不了就不过滤。 */
function parseChapter(chapterId) {
  const s = String(chapterId || '').trim();
  if (!s) return null;
  const m = s.match(/([123])\s*$/) || s.match(/ch\s*([123])/i);
  if (/^(ch|第|chapter)?\s*[123]\s*章?$/i.test(s) && m) return { kind: 'ch', value: Number(m[1]) };
  const G = kg();
  if (G && G.categories && G.categories[s]) return { kind: 'category', value: s };
  if (m) return { kind: 'ch', value: Number(m[1]) };
  return null;
}

/** 关键词 → 节点：① 全名相等 ② 别名相等 ③ 包含/模糊（KG.search） */
function resolve(keywords, chapterId) {
  const G = kg();
  if (!G) return { nodes: [], unresolved: keywords.slice(), meta: { ok: false, error: loadError } };
  const chap = parseChapter(chapterId);
  const nodes = [], unresolved = [], seen = new Set();

  (keywords || []).forEach(kw => {
    const k = String(kw || '').trim();
    if (!k || seen.has(k)) return;
    let hit = G.nodes.find(n => n.name === k)
      || G.nodes.find(n => (n.aliases || []).some(a => a === k))
      || G.nodes.find(n => n.name && (n.name.includes(k) || k.includes(n.name) && n.name.length >= 2));
    if (!hit) {
      const s = G.search(k, 1);
      hit = s && s[0] ? G.nodeMap[s[0].id] : null;
    }
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      nodes.push({ node: hit, keyword: k, chapterMatch: !chap || (chap.kind === 'ch' ? hit.ch === chap.value : hit.category === chap.value) });
    } else {
      unresolved.push(k);
    }
  });

  return { nodes: nodes, unresolved: unresolved, chapter: chap, meta: { ok: true } };
}

/** 选中节点之间的两两关系（只看图谱里真实存在的直连边，不编造） */
function pairRelations(nodes, extra) {
  const G = kg();
  const out = [];
  const seenKey = new Set();
  const push = (fromId, toId, type, evidence) => {
    const key = fromId + '→' + toId;
    if (seenKey.has(key)) return;
    const a = G.nodeMap[fromId], b = G.nodeMap[toId];
    if (!a || !b) return;
    seenKey.add(key);
    out.push({
      from: a.name, to: b.name, relation: REL_CN[type] || type || '关联',
      type: type, evidence: evidence || '', from_id: a.id, to_id: b.id
    });
  };

  const ids = nodes.map(x => x.node ? x.node.id : x.id).filter(Boolean);
  // ① 图谱直连边（两端都在选中集合里，两个方向都看）
  G.edges.forEach(e => {
    if (ids.indexOf(e.s) >= 0 && ids.indexOf(e.t) >= 0) push(e.s, e.t, e.type, e.ev);
  });
  // ② 前端随请求带上来的 relations（同样要能在图谱里对上，防止凭空出现的关系）
  (extra || []).forEach(r => {
    if (!r || !r.from || !r.to) return;
    const a = G.nodes.find(n => n.name === r.from) || G.nodes.find(n => n.name === String(r.from).trim());
    const b = G.nodes.find(n => n.name === r.to) || G.nodes.find(n => n.name === String(r.to).trim());
    if (!a || !b) return;
    const type = Object.keys(REL_CN).find(t => REL_CN[t] === r.relation) || r.relation || '关联';
    push(a.id, b.id, type, r.evidence || '');
  });
  return out;
}

/** 两两关系检查：哪些选中的概念之间在图谱里没有直连关系（帮助模型诚实说"未明确说明"） */
function missingPairs(nodes, pairs) {
  const G = kg();
  const names = nodes.map(x => (x.node || x).name);
  const has = new Set(pairs.map(p => p.from + '|' + p.to).concat(pairs.map(p => p.to + '|' + p.from)));
  const miss = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (!has.has(names[i] + '|' + names[j])) miss.push([names[i], names[j]]);
    }
  }
  return miss;
}

/** 组装"教材相关片段"：定义 + 详解 + 书页出处 + 该概念的全部关系 */
function buildContext(nodes, pairs, opts) {
  const G = kg();
  const maxLen = (opts && opts.maxLen) || 9000;
  let ctx = '';

  nodes.forEach(x => {
    const n = x.node || x;
    const rels = G.edgesOf(n.id).map(e => {
      const other = G.nodeMap[e.s === n.id ? e.t : e.s];
      if (!other) return '';
      return (e.s === n.id ? '→ ' : '← ') + other.name + '（' + (REL_CN[e.type] || e.type) + '）';
    }).filter(Boolean).slice(0, 6).join('；');
    const line = '【' + n.name + '】' + (n.evidence ? '（' + n.evidence + '）' : '') + '：'
      + (n.definition || '')
      + (n.detail ? ' 详解：' + String(n.detail).slice(0, 220) : '')
      + (rels ? ' 图中关系：' + rels : '');
    if (ctx.length + line.length > maxLen) return;
    ctx += line + '\n';
  });

  if (pairs.length) {
    ctx += '\n【选中概念之间的已有关系】\n';
    pairs.forEach(p => {
      ctx += p.from + ' → ' + p.to + '：' + p.relation + (p.evidence ? '（' + p.evidence + '）' : '') + '\n';
    });
  }
  const miss = missingPairs(nodes, pairs);
  if (miss.length) {
    ctx += '\n【图中没有直接关系的组合（需要如实说明"教材中未明确说明"）】\n';
    ctx += miss.map(m => m[0] + ' 与 ' + m[1]).join('；') + '\n';
  }
  return ctx.trim();
}

/** 不带 AI 的兜底关系图：只用图谱里真实存在的关系画 */
function fallbackMermaid(nodes, pairs) {
  const G = kg();
  const idOf = {};
  const lines = ['graph TD'];
  nodes.forEach((x, i) => {
    const n = x.node || x;
    idOf[n.name] = 'n' + i;
    lines.push('  n' + i + '["' + String(n.name).replace(/"/g, '') + '"]');
  });
  const drawn = new Set();
  pairs.forEach(p => {
    const a = idOf[p.from], b = idOf[p.to];
    if (!a || !b || a === b) return;
    const key = a + '>' + b;
    if (drawn.has(key)) return;
    drawn.add(key);
    lines.push('  ' + a + ' -->|' + (REL_SHORT[p.type] || p.relation || '关联') + '| ' + b);
  });
  return lines.join('\n');
}

/** 兜底综述：完全不依赖大模型，用图谱里的定义与关系拼出来 */
function fallbackSummary(nodes, pairs) {
  const names = nodes.map(x => (x.node || x).name);
  const relText = pairs.length
    ? pairs.map(p => p.from + ' → ' + p.to + '（' + p.relation + '）').join('；')
    : '图谱中未记录这些概念之间的直接关系。';
  const defs = nodes.map(x => {
    const n = x.node || x;
    return n.name + '：' + (n.definition || '');
  }).join('\n');
  const pages = nodes.map(x => {
    const n = x.node || x;
    return n.name + ' ' + (n.evidence || '');
  }).join('；');
  return {
    title: names.slice(0, 4).join('、') + (names.length > 4 ? ' 等' : '') + ' 的关系梳理',
    summary: '（离线兜底版：AI 服务不可用，以下内容直接摘自知识图谱，未做润色）\n'
      + '你选中的概念是：' + names.join('、') + '。它们的教材定义如下：\n' + defs
      + '\n已记录的关系：' + relText,
    key_relations: pairs.map(p => ({
      from: p.from, to: p.to, relation: p.relation,
      explanation: p.evidence || '图谱中记录的' + p.relation
    })),
    example: '',
    misconceptions: [],
    mermaid: fallbackMermaid(nodes, pairs),
    citations: pages ? ['教材出处：' + pages] : []
  };
}

module.exports = {
  REL_CN, REL_SHORT,
  kg, available, meta, parseChapter,
  resolve, pairRelations, missingPairs, buildContext, fallbackMermaid, fallbackSummary
};
