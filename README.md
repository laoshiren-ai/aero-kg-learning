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
| 🧩 **多关键词 AI 综述** | 足迹页勾选 3–8 个关键词 → 生成「关系总图」（Mermaid graph）+ 综述文字 + 关键关系 + 生活例子 + 易错点 + 教材出处；**图为本地图谱即时生成（毫秒级）**，AI 综述随后就位；一键「存为笔记」 |
| 📒 **笔记本 + 知识卡片复习** | 问答 / 概念详情 / 综述都能一键存为笔记；笔记可让 AI 拆成 3–8 张可编辑卡片；复习页翻卡 + 三档反馈（忘了/模糊/记得），按简化 SM-2 计算下次复习时间；答错自动请 AI 解释；可选「选择题模式」当场出题 |
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

> **关于新功能（综述 / 笔记本 / 复习）**：这些接口都在 `server.js` 的 `/api/*` 路由里，
> 需要 Node 单端口服务（方式一）。在纯静态托管（方式三 / 直接双击 index.html）下，
> 前端 `AeroAPI` 探测不到后端会自动降级为**浏览器本地模式**——笔记、卡片、复习全流程照常可用
> （数据存在本机 localStorage），只是「AI 综述 / AI 拆卡片 / AI 解释 / AI 出题」会走本地兜底。
> Vercel（方式二）目前只搬了 `/api/chat`，新功能同样走本地模式。

## 🗂️ 目录结构

```
aero-kg-learning/
├── index.html          # 单页应用（图谱 / 向导 / 足迹 / 笔记本 / 复习 / 关于）
├── server.js           # ⭐ 零依赖单端口服务：静态页 + /api/* 路由（平台托管用）
├── server/             # 后端模块（薄路由 + 各业务处理器）
│   ├── store.js        # 笔记/卡片/复习日志的 JSON 持久化（原子写、按用户隔离、SM-2）
│   ├── llm.js          # 智谱调用封装（glm-4-flash → glm-4-air 兜底、JSON 修复）
│   ├── kgdata.js       # 从 data/kg.js 取节点/关系、组装上下文、图谱版综述兜底
│   ├── prompts.js      # 内嵌提示词（综述 / 笔记转卡片 / 答错解释 / 出题）
│   ├── summarize.js    # POST /api/summarize/keywords
│   ├── notes.js        # 笔记 CRUD + 生成卡片
│   ├── cards.js        # 到期卡片 / 复习 / 解释 / 出题
│   └── chat.js         # /api/chat 智谱代理
├── api/chat.js         # Vercel Serverless 版智谱代理（同契约，Vercel 部署用）
├── package.json        # npm start → node server.js
├── css/style.css       # 浅色主题 + 响应式（≤900px 切抽屉）
├── js/
│   ├── kg 数据见 data/；渲染见 graph.js；编排见 app.js
│   ├── user.js         # 轻量用户身份（localStorage uid，随请求头 X-User-Id 发给服务端）
│   ├── api.js          # AeroAPI 统一数据层：有后端走服务端，无后端自动降级 localStorage
│   ├── mermaid-view.js # Mermaid 渲染封装（失败回退显示源码）
│   ├── summary.js      # 足迹多选 + 生成综述弹窗（图谱版即时 + AI 版升级）
│   ├── notes.js        # 笔记本页（列表/详情/编辑/生成可编辑卡片）
│   ├── review.js       # 复习页（翻卡 + 三档反馈 + 答错 AI 解释 + 选择题模式）
│   ├── guide.js        # AI 向导规则引擎 + LLM 接入预留位（LLM_SLOT）
│   ├── chat.js         # 右下角 AI 问答窗口（悬浮按钮 + RAG 检索 + 对话渲染 + 存为笔记）
│   ├── search.js       # 搜索（四级打分：精确/前缀/包含/定义别名）
│   ├── graph.js        # ECharts 力导向图
│   └── app.js          # 视图切换 / 详情面板 / 向导界面 / 一键存笔记
├── data/
│   ├── kg.js           # ⭐ 知识图谱数据：145 节点 + 214 边，每条带书页出处
│   └── paths.js        # 20 条精选学习路径（探索模式匹配用）
├── vendor/
│   ├── echarts.min.js
│   └── mermaid.min.js  # 关系总图渲染（本地打包，国内直连）
└── .data/              # 运行时数据（笔记/卡片/复习日志，已 gitignore）
```

## 🔌 API

除 `/api/chat` 外，本轮新增以下接口（均为 JSON；服务端按请求头 `X-User-Id` 或 `?user_id` 隔离数据）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/summarize/keywords` | `{keywords:[3..8], relations?, chapterId?}` → `{data:{title,summary,key_relations,example,misconceptions,mermaid,citations}, meta}` |
| GET/POST | `/api/notes` | 笔记列表 / 新建笔记 |
| GET/PUT/DELETE | `/api/notes/:id` | 笔记详情 / 更新 / 删除 |
| POST | `/api/notes/:id/cards` | 生成卡片（不带 `cards` 走 AI 生成；带 `cards` 则直接保存编辑后的草稿） |
| GET | `/api/cards/due` | 到期卡片（含 `note_title` 与三档反馈的下次时间预览） |
| POST | `/api/cards` | 新建卡片（快捷键兜底/手工加卡） |
| PUT/DELETE | `/api/cards/:id` | 编辑 / 删除卡片 |
| POST | `/api/cards/:id/review` | `{rating: again\|hard\|good}` → 按简化 SM-2 更新 `due/interval/ease/reps` |
| POST | `/api/cards/:id/explain` | 答错后请 AI 解释（≤200 字纯文本） |
| POST | `/api/cards/:id/quiz` | AI 依据卡片出一道单选题 |
| GET | `/api/stats` | 笔记 / 卡片 / 复习次数统计 |
| GET | `/api/health` | 健康检查（含真实图谱规模 + 是否已配置 Key） |

> **间隔重复算法（简化 SM-2）**：卡片初始 `interval=0, ease=2.5, due=now`。
> 记得：`interval=max(1, interval×2)`，`ease+=0.1`；模糊：`interval=max(1, interval×1.2)`；
> 忘了：`interval=1`，`ease=max(1.3, ease-0.2)`。三档均 `reps+=1`，`due=now+interval 天`。

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
