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
| 💬 **AI 问答窗口** | 右下角悬浮 💬 按钮，点开即聊：本地图谱检索（问题→节点反向匹配 + 一跳关系扩展）→ 组装上下文 → `/api/chat` → AI 即时回答；支持追问（携带最近对话）、回答附「相关概念」chips 一键跳图谱 |
| 📱 **响应式** | PC 侧栏详情 / 移动端抽屉式详情，一套代码两端适配 |

探索模式示例：输入「为什么飞机能飞起来？」→
**相对运动原理 → 伯努利定理 → 翼型 → 机翼升力 → 迎角 → 气动布局**，每一站可点击深入。

## 🚀 本地运行

零依赖，无需构建。三种方式任选：

```bash
# 方式一（推荐）：单端口 Node 服务 = 静态页 + AI 代理，一条命令全都有
ZHIPU_API_KEY=你的key node server.js        # Windows: set ZHIPU_API_KEY=... && node server.js
# → http://localhost:3000

# 方式二：只想看页面（没有 AI）
python -m http.server 8080                   # 或直接双击 index.html

# 方式三：只想调 AI 链路（不配环境变量也行，见「密钥配置」）
node server.js
```

> 页面放在本地 / 静态托管（file://、GitHub Pages）打开时，AI 探测会自动失败并**回退到内置规则引擎**，
> 网站功能不缺失、不报错——只是问答窗口会提示你去看部署说明。

## 🔑 密钥配置（开启 AI 问答 / AI 探索）

AI 由智谱 `glm-4-flash` 驱动，服务端持钥、前端零密钥。Key 读取优先级：

1. 环境变量 `ZHIPU_API_KEY`
2. 项目根目录 `server-config.json` → `{ "zhipuApiKey": "你的key" }`（已被 `.gitignore` 排除，且被服务端 HTTP 屏蔽，永不外泄）

都没有时，`/api/chat` 返回 500 并在窗口内提示如何配置——**页面其余功能完全不受影响**。

Key 在 [open.bigmodel.cn](https://open.bigmodel.cn) 免费申请。**若返回 401「令牌已过期或验证不正确」，说明 Key 已失效，需重新生成。**

## 📦 部署

### 方式一：平台托管（Node 单端口服务 · 国内直连，推荐）
`server.js` 是一个零依赖单端口服务，同时提供静态页与 `/api/chat`，**任何支持 Node 的平台都能跑**：

1. 平台从 `package.json` 识别 `npm start` → `node server.js`，自动注入 `PORT`，监听 `0.0.0.0`
2. 配置环境变量 `ZHIPU_API_KEY`（或用 `server-config.json`）→ 重新部署即可启用 AI

### 方式二：Vercel（海外，国内访问需代理）
1. [vercel.com/new](https://vercel.com/new) 导入本仓库，Framework Preset 选 **Other**，零配置 Deploy
2. **Settings → Environment Variables** 添加 `ZHIPU_API_KEY` → 重新部署
3. `api/chat.js` 自动成为 Serverless 函数（`/api/chat`），与 `server.js` 同契约，前端无需改动

> 本地调试 Serverless：`npm i -g vercel && vercel dev`。

### 方式三：GitHub Pages（纯静态，无 AI）
`Settings → Pages → Source: Deploy from a branch → main / (root)`。
AI 探测失败自动回退规则引擎——功能不缺失，只是没有 LLM 问答。

> 两种后端实现共用同一份 `/api/chat` 契约（`{ prompt, context }` → `{ ok, answer }`），
> 前端 `fetch('/api/chat')` 一行代码两边通吃。

## 🗂️ 目录结构

```
aero-kg-learning/
├── index.html          # 单页应用（图谱 / AI 向导 / 关于 三视图）
├── server.js           # ⭐ 零依赖单端口服务：静态页 + /api/chat 智谱代理（平台托管用）
├── api/chat.js         # Vercel Serverless 版智谱代理（同契约，Vercel 部署用）
├── package.json        # npm start → node server.js
├── css/style.css       # 浅色主题 + 响应式（≤900px 切抽屉）
├── js/
│   ├── kg 数据见 data/；渲染见 graph.js；编排见 app.js
│   ├── guide.js        # AI 向导规则引擎 + LLM 接入预留位（LLM_SLOT）
│   ├── chat.js         # 右下角 AI 问答窗口（悬浮按钮 + RAG 检索 + 对话渲染）
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
