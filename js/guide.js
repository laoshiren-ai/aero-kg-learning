/* ═══════════════════════════════════════════════
   AI 学习向导 — 规则引擎
   · 基于图谱关系的路径推荐（无需后端）
   · 浏览足迹记录（localStorage）
   · 预留 LLM API 接入位（见 LLM_SLOT）
   ═══════════════════════════════════════════════ */
(function () {
  const TRAIL_KEY = 'aerokg_trail_v1';
  const MAX_TRAIL = 60;

  const Guide = {
    trail: [],

    /* ── 足迹 ─────────────────────── */
    loadTrail() {
      try { this.trail = JSON.parse(localStorage.getItem(TRAIL_KEY)) || []; }
      catch (e) { this.trail = []; }
      return this.trail;
    },
    pushVisit(node) {
      const t = Date.now();
      this.trail = this.trail.filter(x => x.id !== node.id);
      this.trail.push({ id: node.id, name: node.name, t });
      if (this.trail.length > MAX_TRAIL) this.trail = this.trail.slice(-MAX_TRAIL);
      try { localStorage.setItem(TRAIL_KEY, JSON.stringify(this.trail)); } catch (e) {}
    },
    clearTrail() {
      this.trail = [];
      try { localStorage.removeItem(TRAIL_KEY); } catch (e) {}
    },
    visitedSet() { return new Set(this.trail.map(x => x.id)); },

    /* ── 核心推荐：给定当前节点，产出下一步建议 ──
       规则优先级：
       1) 因果/关联 → 沿知识链向前走（"你刚了解了X，接下来看Y"）
       2) 从属 → 同父节点的兄弟概念（并列拓展）
       3) 包含 → 当前节点的子概念（向下深入）
       4) 从属 → 当前节点的父概念（向上回溯）
       未访问过的节点优先 */
    recommend(nodeId) {
      const KG = window.AeroKG;
      const node = KG.nodeMap[nodeId];
      if (!node) return [];
      const visited = this.visitedSet();
      const edges = KG.edgesOf(nodeId);
      const byType = t => edges.filter(e => e.type === t);
      const other = e => (e.source === nodeId ? e.target : e.source);

      const recs = [];
      const push = (e, kind, why) => {
        const o = other(e);
        if (!KG.nodeMap[o] || o === nodeId) return;
        recs.push({
          id: o, kind, why,
          isNew: !visited.has(o),
          weight: (e.type === '因果' ? 3 : e.type === '关联' ? 2.4 : kind === 'sibling' ? 2 : 1.6)
            + (!visited.has(o) ? 1.2 : 0)
        });
      };

      // 1) 因果/关联链
      byType('因果').forEach(e => push(e, 'chain', e.type === '因果' ? '知识链下一步' : '强关联概念'));
      byType('关联').forEach(e => push(e, 'chain', '关联概念'));
      // 2) 同父兄弟（并列）
      const parents = byType('从属').filter(e => e.target === nodeId).map(e => e.source);
      parents.forEach(p => {
        edges.filter(x => x.type === '从属' && x.source === p && x.target !== nodeId)
          .forEach(s => push(s, 'sibling', `与「${KG.nodeMap[p].name}」下的其他分支对照`));
      });
      // 3) 子概念（包含）
      byType('包含').forEach(e => push(e, 'child', '向下深入：组成部分'));
      // 4) 父概念
      byType('从属').forEach(e => { if (e.target === nodeId) push(e, 'parent', '向上回溯：整体框架'); });

      // 去重（同一目标取最高权重）
      const best = {};
      recs.forEach(r => { if (!best[r.id] || r.weight > best[r.id].weight) best[r.id] = r; });
      return Object.values(best).sort((a, b) => b.weight - a.weight).slice(0, 4);
    },

    /* ── 探索模式：问题 → 学习路径 ──
       先命中 paths.json 的预置路径（关键词匹配）；
       未命中则在图谱上做 BFS 找与问题关键词最相关的节点链。 */
    explore(question) {
      const KG = window.AeroKG;
      const q = (question || '').trim();
      if (!q) return null;

      // 1) 预置路径匹配（按命中关键词计数）
      let bestPath = null, bestScore = 0;
      (window.AeroPaths || []).forEach(p => {
        let score = 0;
        p.match.forEach(k => { if (q.includes(k)) score += k.length >= 3 ? 2 : 1; });
        if (score > bestScore) { bestScore = score; bestPath = p; }
      });
      if (bestPath && bestScore >= 2) {
        return {
          question: q, title: bestPath.title, intro: bestPath.intro,
          steps: bestPath.steps.map(id => {
            const n = KG.nodeMap[id];
            return n ? { id, name: n.name, note: n.definition.slice(0, 60) + '…' } : null;
          }).filter(Boolean),
          curated: true
        };
      }

      // 2) 图谱检索式路径：找到问题中最相关的节点 → 沿边扩展一条 4 站路径
      const hits = KG.search(q, 6);
      if (!hits.length) return { question: q, miss: true };
      const start = hits[0];
      const steps = [{ id: start.id, name: start.name, note: start.definition.slice(0, 60) + '…' }];
      const seen = new Set([start.id]);
      let cur = start.id;
      while (steps.length < 4) {
        const nxt = this.recommend(cur).filter(r => !seen.has(r.id) && r.kind !== 'parent');
        if (!nxt.length) {
          const par = KG.edgesOf(cur).find(e => e.type === '从属' && e.target === cur);
          if (!par || seen.has(par.source)) break;
          steps.push({ id: par.source, name: KG.nodeMap[par.source].name, note: '整体框架视角', parentStep: true });
          seen.add(par.source); cur = par.source; continue;
        }
        const r = KG.nodeMap[nxt[0].id];
        steps.push({ id: r.id, name: r.name, note: r.definition.slice(0, 60) + '…' });
        seen.add(r.id); cur = r.id;
      }
      return { question: q, title: `围绕「${start.name}」的探索路径`, intro: '这是 AI 向导根据图谱关系为你生成的路径：', steps, curated: false };
    },

    /* ── 知识地图统计 ── */
    mapStats() {
      const KG = window.AeroKG;
      const visited = this.visitedSet();
      const total = Object.keys(KG.nodeMap).length;
      const byCat = {};
      visited.forEach(id => {
        const n = KG.nodeMap[id];
        if (!n) return;
        byCat[n.category] = (byCat[n.category] || 0) + 1;
      });
      return { visited: visited.size, total, byCat, pct: total ? Math.round(visited.size / total * 100) : 0 };
    }
  };

  /* ═══ LLM_SLOT ═══════════════════════════════════
     AI 学习路径规划（经 Vercel Serverless 代理 /api/chat 调用智谱 glm-4-flash）
     · API Key 只存在 Vercel 服务端环境变量 ZHIPU_API_KEY，前端零密钥
     · 静态托管（GitHub Pages 等）下 /api/chat 不存在 → ask() 返回 null
       → 调用方自动回退到本地规则引擎 explore()，网站永不报错
     ═══════════════════════════════════════════════ */
  Guide.LLM_SLOT = {
    enabled: true,
    endpoint: '/api/chat',             // Vercel 部署后自动生效；本地静态预览自动回退
    apiKey: '',                        // 刻意留空：密钥在服务端，前端永远接触不到

    async ask(question, kgSummary) {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: [
              '你是「航空航天知识图谱」网站的 AI 学习向导。',
              '任务：针对用户问题规划一条 3-6 站学习路径（不直接灌输答案），说明每站解决什么。',
              '只能使用【参考资料】中列出的概念，必须用其竖线前的英文 id，按学习先后排序。',
              '严格输出一个 JSON 对象，不要 markdown 代码块，格式：',
              '{"title":"路径标题","intro":"一句话说明该路径为何能回答问题","steps":[{"id":"节点id","why":"这一站解决什么"}]}',
              '',
              '用户问题：' + question
            ].join('\n'),
            context: kgSummary || ''
          })
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || data.ok !== true || !data.answer) return null;
        // 从回答中提取 JSON（容忍模型用 ```json 包裹）
        const m = data.answer.match(/\{[\s\S]*\}/);
        if (!m) return null;
        let plan;
        try { plan = JSON.parse(m[0]); } catch (e) { return null; }
        const KG = window.AeroKG;
        const steps = (Array.isArray(plan.steps) ? plan.steps : [])
          .map(s => {
            const n = KG.nodeMap[s && s.id];
            if (!n) return null; // 模型给了图谱外的 id → 丢弃该站
            const why = (s && typeof s.why === 'string' && s.why.trim())
              ? s.why.trim() : n.definition;
            return { id: n.id, name: n.name, note: why.slice(0, 80) };
          })
          .filter(Boolean);
        if (steps.length < 2) return null; // 有效站点太少 → 回退规则引擎
        return {
          question: question,
          title: (typeof plan.title === 'string' && plan.title.trim()) || ('围绕「' + question + '」的 AI 路径'),
          intro: (typeof plan.intro === 'string' && plan.intro.trim()) || 'AI 向导根据知识图谱为你规划的路径：',
          steps: steps,
          curated: false,
          ai: true
        };
      } catch (e) {
        return null; // 静态托管 404 / 网络异常 → 回退规则引擎
      }
    }
  };

  window.Guide = Guide;
})();
