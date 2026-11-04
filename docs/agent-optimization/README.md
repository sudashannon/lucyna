# Lucyna Agent 模块优化方案

这组方案把日常自动化的中心放在整个 Work 的协作过程。Lucyna 汇总同一 Work 下的多个 session，结合用户与 OMP agent 的对话，帮助继续工作、补全提示词、找到已有资料并维护 Work 过程。AntOmniEvo 保留为高级实验能力。

方案强调用户在使用 Work 时能直接获得的协作支持。模型负责理解、归纳和建议，原生 OMP 继续负责主会话及其中工具调用。工作区资料和长期知识保留各自来源与版本。

## 模块导航

| 模块 | 设计文档 | 当前状态 |
| --- | --- | --- |
| Work 状态与多会话汇总 | [work-context.md](work-context.md) | 本机与远端面板、固定栏目摘要、出处展开和继续工作草稿已实现；主线归组待做 |
| 提示词补全与继续工作 | [prompt-assistance.md](prompt-assistance.md) | 本机与远端对话提示补全已接入；本机 Work 资料建议随草稿助手接入 |
| Work 资料发现、引用与导入 | [assets-and-references.md](assets-and-references.md) | 本机 Work 文件和已保存资料可推荐、预览并选段加入草稿；远端资产与全局知识推荐待做 |
| 流程提醒与 Work 偏好 | [workflow-assistance.md](workflow-assistance.md) | 四类有出处的流程提醒及草稿操作已接入；独立偏好引擎待做 |
| 原生 OMP 与子代理 | [omp-and-subagents.md](omp-and-subagents.md) | 会话事件已接摘要并显示 Work 面板；任务归组待加强 |
| SSH 会话与远程 Work | [ssh-work.md](ssh-work.md) | 已打开会话和面板已接入，远端历史批量补齐待做 |
| Work Runner | [work-runner.md](work-runner.md) | WSL 后台执行已接入，协作闭环待加强 |
| AuxiliaryAgent | [auxiliary-agent.md](auxiliary-agent.md) | 已提供 Work 摘要、输入补全、资料建议和流程提醒请求；统一调度待做 |
| 知识沉淀与维护 | [knowledge.md](knowledge.md) | L1/L2 沉淀已接入，来源变化维护开发中 |
| Work 状态与事件持久化 | [persistence.md](persistence.md) | 摘要与流程提醒分别按 Work 身份持久化；提示候选和资料建议不持久化 |
| 自动进化 | [evolution.md](evolution.md) | 新策略默认关闭，历史配置保留为高级实验 |

## 实施顺序

### 第一阶段，形成 Work 助手最小闭环

目标是建立 Work 范围的多 session 状态汇总，最终支持当前主线、已确认决定、阻塞和下一步。提供一份基于该摘要的“继续工作”内容，并可放入当前草稿。后续可从来源跳回原会话和证据。当前摘要使用固定栏目，还没有独立工作主线归组。

首批摘要服务、本机与远端 Work 面板及继续工作草稿已接入。服务可接收本机和已打开 SSH 会话事件，并批量补齐最多 12 条本机历史；远端批量历史读取未接入。摘要引用可展开查看对话出处，但当前不能跳转到原 session。输入草稿时可从 Work 对话生成有出处的提示补全；本机 Work 文件和已保存资料可按元数据推荐，用户选择后才读取快照。Work 内跨会话流程提醒已接入，可将建议和出处加入草稿。远端资产推荐、全局知识推荐、跨 Work 资料导入和主线归组仍待后续接入。

### 第二阶段，连接输入与资料

继续细化输入补全与资料使用体验。已有对话提示补全和本机 Work 资料推荐，后续接入其他 session 的具体产物跳转、全局知识推荐、跨 Work 显式复制以及结构化引用记录。用户选择后才把内容加入草稿或保存到 Work，并保留来源与版本。

### 第三阶段，帮助维持工作流程

已有会话交接、`SESSION.md` 维护、重复阻塞和成果复用提醒，用户可标记状态或把带出处的建议放入当前草稿。后续再加入用户可管理的 Work 范围偏好和显式维护动作。

### 并行改进，覆盖执行与支撑模块

完善 OMP 任务与产物的关联、SSH 远端能力、Work Runner 环境适配、AuxiliaryAgent 调度和知识来源维护。调整持久化时保持会话、Work、host 和来源版本的明确归属。

## 共同约定

- Work 是汇总、偏好和流程提示的边界。同名 Work 不能仅凭名称合并。
- 本机 Work 由执行主机、Work 根路径及 Work 登记共同识别。远程 Work 还包含 hostId。
- session 标题便于浏览。资料和状态关联使用原生会话身份与原始路径，不用标题猜测。
- 对话内容和未来纳入的工具输出都保留出处。后续将用户确认、agent 建议和实际工具结果分别标记。
- 摘要和建议应展示来源、时间及可能缺失的覆盖范围。当前引用可展开查看对话原文，跳回原 session 的入口待做。
- 提示词建议、资料推荐和流程提示均回到对应 session 的草稿或明确操作中，避免在用户发送或确认前改变会话。
- Work 助手读写通过主进程和受限宿主执行。模型不获得额外工具权限或文件写入权。
- 运行环境、模型配置和本地持久化范围都以当前 Work 实际来源为准。切换 Work 或 host 时，不沿用旧范围的结果。

## 现有代码入口

- `src/session-manager.cjs`：会话原生事件、消息读取和 session 生命周期。
- `src/work-assistant.cjs` 与 `src/work-assistant-sources.cjs`：Work 摘要、来源校验、持久化与历史加载。
- `src/work-guidance.cjs` 与 `src/work-guidance-assets.cjs`：草稿提示补全、资产建议与选后快照读取。
- `src/work-workflow.cjs`：带会话及 `SESSION.md` 出处的 Work 流程提醒和状态持久化。
- `src/renderer/workbench-store.ts`：session 身份、消息、草稿、连接和待处理队列。
- `src/renderer/components/WorkDetails.tsx`：Work 进度、资产和后台任务界面。
- `src/work-details.py`：本机 WSL Work 资料清单。
- `src/work-knowledge.cjs`：受限 Work 资产捕获。
- `src/knowledge-consolidation.cjs`：Work 笔记沉淀到知识库。
- `src/work-runner.cjs` 与 `tools/work-runner/`：独立 WSL 后台任务和自动实验。
- `src/hosts/` 与 `tools/lucyna-host/`：SSH host、远程会话和恢复。
