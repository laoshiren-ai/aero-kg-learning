# 🛰️ 航空航天知识图谱学习向导 (AeroKG)

> 把一本权威教材，变成一个可交互、可漫游、有 AI 向导的知识网络。
> 数据来源：《航空航天概论》第 3 版（贾玉红主编）第 2 章「飞行器飞行原理」+ 第 3 章「飞行器动力装置」

![screens](https://img.shields.io/badge/节点-145-blue) ![edges](https://img.shields.io/badge/关系-214-green) ![paths](https://img.shields.io/badge/学习路径-20-orange)

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🔍 **搜索与解释** | 输入任意关键词（如「涡轮风扇发动机」），输出定义、核心解释、相关词列表，**明确标注关系类型**（从属/包含/并列/关联/因果） |
| 🕸️ **交互式知识图谱** | ECharts 力导向图，145 个概念节点、214 条关系边，支持缩放/拖拽/图例过滤/点击进详情；节点颜色=知识类别，连线样式=关系类型 |
| 🧭 **AI 学习向导** | ① 根据当前节点推荐下一步（因果链优先）② 浏览足迹 + 个性化知识地图（覆盖率统计）③ **探索模式**：提问不给答案，给学习路径 |
| 📱 **响应式** | PC 侧栏详情 / 移动端抽屉式详情，一套代码两端适配 |

探索模式示例：输入「为什么飞机能飞起来？」→
**相对运动原理 → 伯努利定理 → 翼型 → 机翼升力 → 迎角 → 气动布局**，每一站可点击深入。

## 🚀 本地运行

零依赖纯前端，无需构建：

```bash
# 方式一：直接双击 index.html
# 方式二（推荐，避免个别浏览器 file:// 限制）：
python -m http.server 8080     # 或 npx serve .
# 打开 http://localhost:8080
```

## 📦 部署

### GitHub Pages
1. Push 本仓库到 GitHub
2. `Settings → Pages → Source: Deploy from a branch → main / (root)`
3. 访问 `https://<你的用户名>.github.io/aero-kg-learning/`

### Vercel（推荐：同时获得 AI 学习向导）
1. [vercel.com/new](https://vercel.com/new) 导入本仓库，Framework Preset 选 **Other**，零配置 Deploy
2. 开启 AI 向导：项目 → **Settings → Environment Variables** 添加
   - `ZHIPU_API_KEY` = 你的智谱 API Key（[open.bigmodel.cn](https://open.bigmodel.cn) 获取）
3. 重新部署后，`api/chat.js` 自动成为 Serverless 函数（`/api/chat`）：
   - 前端 `prompt` + 检索到的图谱 `context` → 服务端持钥调用智谱 `glm-4-flash` → 返回回答
   - Key 永不下发浏览器；探索模式的路径规划自动升级为 AI 规划（带 🤖 徽标）
4. 同一仓库若部署在 GitHub Pages（纯静态），AI 探测失败会**自动回退**到内置规则引擎，功能不缺失

> 本地调试 Serverless：`npm i -g vercel && vercel dev`（需先配置环境变量）。

## 🗂️ 目录结构

```
aero-kg-learning/
├── index.html          # 单页应用（图谱 / AI 向导 / 关于 三视图）
├── api/chat.js         # Vercel Serverless：智谱 glm-4-flash 代理（CORS / 密钥服务端保存）
├── css/style.css       # 浅色主题 + 响应式（≤900px 切抽屉）
├── js/
│   ├── kg 数据见 data/；渲染见 graph.js；编排见 app.js
│   ├── guide.js        # AI 向导规则引擎 + LLM 接入预留位（LLM_SLOT）
│   ├── search.js       # 搜索（四级打分：精确/前缀/包含/定义别名）
│   ├── graph.js        # ECharts 力导向图
│   └── app.js          # 视图切换 / 详情面板 / 向导界面
├── data/
│   ├── kg.js           # ⭐ 知识图谱数据：145 节点 + 214 边，每条带书页出处
│   └── paths.js        # 20 条精选学习路径（探索模式匹配用）
└── vendor/echarts.min.js
```

## 🧠 数据是怎么来的（OPC 工作流）

本项目是「一人公司 + AI 员工」的完整演示：**人只提需求与验收，AI 完成其余全部工序**。

```
① 资料解析   AI 解析 298 页扫描版 PDF（无文字层）→ 定位目录 → OCR 两个核心章节 112 页
② 知识抽取   AI 通读约 28 万字 OCR 文本，抽取概念/定义/五类关系，每条标注书页出处
③ 本体建模   按 UOM 软方法学七阶段建模：61 条业务事实全部通过原文子串校验，
             七类代表性情形 7/7 可表达，结构校验器全绿
④ 网站生成   AI 生成响应式前端 + 规则式推荐引擎（预留 LLM API 接入位）
⑤ 质量验证   Node 数据体检（0 错误）+ Chrome 无头端到端测试（0 报错）
```

建模全过程档案见仓库外 `uom-forge/aero-kg/`（facts.json / model.json / coverage.json /
ontology.svg / check-report.md / self-narrative.md 等十件套）。

## ⚠️ 声明

学习演示项目。知识条目摘编自上述教材并标注书页出处，仅用于教学演示；
多媒体区为占位（建议来源：NASA 官网、维基百科词条、B站公开课）。
「检查通过」只表示当前用例可表达，不表示已覆盖原书全部内容，请以教材原文为准。

## License

MIT
