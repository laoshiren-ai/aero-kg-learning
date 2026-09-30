/* ═══════════════════════════════════════════════
   图谱渲染 — ECharts 力导向图
   · 节点颜色 = 知识类别；边颜色/形状 = 关系类型
   · 缩放 / 拖拽 / 点击进入详情
   ═══════════════════════════════════════════════ */
(function () {
  let chart = null, trailMode = false;
  let activeCats = null;   // null = 全部类别；Set = 过滤后的类别

  const EDGE_STYLE = {
    '从属': { color: '#7d93ad', width: 1.6, type: 'solid' },
    '包含': { color: '#4f9ea0', width: 1.6, type: 'solid' },
    '并列': { color: '#b8923a', width: 1.2, type: 'dashed' },
    '关联': { color: '#c08a8a', width: 1.2, type: 'dotted' },
    '因果': { color: '#d6544a', width: 2.4, type: 'solid' }
  };

  function nodeSize(n) {
    const deg = n._deg || 0;
    return 16 + Math.min(deg * 1.6, 22) + (n.category === 'root' ? 12 : 0);
  }

  function visibleNodes(KG) {
    return activeCats ? KG.nodes.filter(n => activeCats.has(n.category)) : KG.nodes;
  }

  function buildOption() {
    const KG = window.AeroKG;
    const visited = window.Guide.visitedSet();
    const vnodes = visibleNodes(KG);
    const vidSet = new Set(vnodes.map(n => n.id));
    // 边只在两端都可见时显示
    const edges = KG.edges
      .filter(e => vidSet.has(e.source) && vidSet.has(e.target))
      .map(e => {
        const st = EDGE_STYLE[e.type] || EDGE_STYLE['关联'];
        const dim = trailMode && !(visited.has(e.source) && visited.has(e.target));
        return {
          source: e.source, target: e.target,
          lineStyle: {
            color: st.color, width: st.width, type: st.type,
            opacity: dim ? .06 : (e.type === '因果' ? .8 : .5),
            curveness: .08
          }
        };
      });
    const nodes = vnodes.map(n => ({
      id: n.id, name: n.name,
      x: n._x, y: n._y,
      symbolSize: nodeSize(n),
      itemStyle: {
        color: KG.catColor(n.category),
        borderColor: '#fff', borderWidth: 1.5,
        shadowBlur: 4, shadowColor: 'rgba(0,0,0,.15)',
        opacity: trailMode && !visited.has(n.id) ? .22 : 1
      },
      label: {
        show: true, fontSize: 11, color: '#33415a',
        formatter: p => p.name.length > 6 ? p.name.slice(0, 6) + '…' : p.name,
        position: 'bottom', distance: 4
      }
    }));
    return {
      backgroundColor: 'transparent',
      tooltip: {
        formatter: p => {
          if (p.dataType === 'edge') {
            const e = KG.edgeMap[p.data.source + '→' + p.data.target] || {};
            return `<b>${p.data.source_name || ''}</b> —[${e.type || ''}]→ <b>${p.data.target_name || ''}</b>`;
          }
          const n = KG.nodeMap[p.data.id] || {};
          return `<b>${p.name}</b><br><span style="color:#93a1b5;font-size:11px">${KG.categories[n.category] || ''} · 点击查看详情</span>`;
        },
        textStyle: { fontSize: 12 }
      },
      series: [{
        type: 'graph', layout: 'force', roam: true,
        draggable: true,
        data: nodes, links: edges,
        categories: Object.entries(KG.categories).map(([k, v]) => ({ name: v })),
        force: {
          repulsion: 260, gravity: .045, edgeLength: [55, 130],
          friction: .16, layoutAnimation: true
        },
        emphasis: {
          scale: 1.25,
          itemStyle: { shadowBlur: 16, shadowColor: 'rgba(47,111,214,.4)' },
          lineStyle: { opacity: 1, width: 3 }
        },
        scaleLimit: { min: .35, max: 4 },
        edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 7
      }]
    };
  }

  window.GraphView = {
    init() {
      const el = document.getElementById('graphCanvas');
      chart = echarts.init(el);
      chart.setOption(buildOption());
      chart.on('click', p => {
        if (p.dataType === 'node') {
          // p.data.id 是节点 id；兼容旧事件里只有 name 的情况
          const id = (p.data && p.data.id) || p.name;
          window.App.openNode(id);
        }
      });
      window.addEventListener('resize', () => chart.resize());
      this._chart = chart;               // 暴露给调试/测试
      this.renderLegend();
    },
    renderLegend() {
      const KG = window.AeroKG;
      const box = document.getElementById('graphLegend');
      const catRows = Object.entries(KG.categories).map(([k, v]) =>
        `<div class="legend-row" data-cat="${k}"><span class="legend-dot" style="background:${KG.catColor(k)};border-radius:50%"></span>${v}</div>`).join('');
      const edgeRows = Object.entries(EDGE_STYLE).map(([k, s]) =>
        `<div class="legend-row" style="cursor:default"><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="${s.color}" stroke-width="${s.width + .6}" ${s.type !== 'solid' ? `stroke-dasharray="${s.type === 'dashed' ? '5,3' : '2,3'}"` : ''}/></svg>${k}</div>`).join('');
      box.innerHTML = `<div class="legend-title">知识类别（点击过滤）</div>${catRows}
        <div class="legend-title" style="margin-top:8px">关系类型</div>${edgeRows}`;
      activeCats = new Set(Object.keys(KG.categories));
      box.querySelectorAll('.legend-row[data-cat]').forEach(row => {
        row.addEventListener('click', () => {
          const c = row.dataset.cat;
          if (activeCats.has(c)) activeCats.delete(c); else activeCats.add(c);
          row.classList.toggle('dim', !activeCats.has(c));
          // 全量重建：保留节点样式/尺寸，并同步过滤边
          if (activeCats.size === 0) {
            // 全部隐藏无意义，视为恢复全部
            Object.keys(KG.categories).forEach(k => activeCats.add(k));
            box.querySelectorAll('.legend-row[data-cat]').forEach(r => r.classList.remove('dim'));
          }
          chart.setOption(buildOption());
        });
      });
    },
    refresh() { chart && chart.setOption(buildOption()); },
    resetView() {
      if (!chart) return;
      chart.setOption(buildOption());
      chart.dispatchAction({ type: 'restore' });
    },
    relayout() {
      if (!chart) return;
      const KG = window.AeroKG;
      KG.nodes.forEach(n => { n._x = null; n._y = null; });
      chart.setOption(buildOption(), true);
    },
    toggleTrail() {
      trailMode = !trailMode;
      this.refresh();
      return trailMode;
    },
    focusNode(id) {
      if (!chart) return;
      const n = window.AeroKG.nodeMap[id];
      if (!n) return;
      // 图谱节点以中文名注册，highlight 需用 name 而非 id
      chart.dispatchAction({ type: 'highlight', name: n.name });
      setTimeout(() => chart.dispatchAction({ type: 'downplay', name: n.name }), 1600);
    }
  };
})();
