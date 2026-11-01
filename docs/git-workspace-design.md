# 工作区文件与 Git 集成设计

日期：2026-11-01。状态：P0–P5 实现已落地，本文所列定向测试通过；跨环境与完整发行矩阵尚未认证，独立 finish review 已对记录的修正批次给出 ship。本文保留原始设计方向与分期；第 2–11 节中未列入第 16 节实际范围的细节仍是设计提案，不能据此推断已交付。实际交付范围、限制和未完成的验收见第 16 节。本文及静态设计图不替代真实运行验收。

## 1. 已确认的产品方向

在现有工作台的工作区主内容区设置 **对话工作 / 工作区文件** 两个标签。把最右侧工具栏中的浏览/预览提升到「工作区文件」，并在该标签内集成 Git。保留全局工作台、知识库、活跃会话导航；不增加独立的全局 Git 入口。

设计覆盖文件浏览、改动审查、暂存、提交、历史、分支和 Worktree，并按依赖分期交付。使用 Impeccable 的 Operate 模式：延续 Lucyna 现有设计系统，采用熟悉的桌面 Git 操作布局。

用户的原始布局指令是：「在工作区功能下，右侧增加标签页进行对话工作和工作区文件浏览两个标签，把最右侧边栏的浏览单独升级为一个标签，在里面集成 git 功能。」

## 2. 界面结构

~~~text
Lucyna 全局导航 │ 我的工作 / Work 列表 │ 当前 Work 的主内容区
工作台         │ lucyna               │ Work 名称 · 执行环境 · 当前仓库/分支
知识库         │   会话 A             │ [ 对话工作 ] [ 工作区文件 ]
活跃会话       │   会话 B             │
               │ docs-site            │ 对话工作：原会话与输入框 + 工作/会话/记忆/事件工具
               │                      │ 工作区文件：[浏览][改动][历史][分支][Worktree]
~~~

「工作区文件」使用原会话和最右工具栏共同占用的内容宽度。进入该标签时隐藏会话工具栏，回到「对话工作」时恢复原工具标签、宽度、展开状态和滚动位置。全局侧栏保持现有主题结构。

### 文件浏览

~~~text
[浏览] [改动 5] [历史] [分支] [Worktree]       当前仓库 lucyna ▾
┌ 工作区文件列表 ──────────────┬ 文件路径 / 刷新 / 查看差异 / 在对话中讨论 ┐
│ SESSION.md                  │                                             │
│ work.json                   │ Markdown / 文本 / 图片阅读器                 │
│ repos/                      │                                             │
│   lucyna/                   │ 文件内容保持真实阅读宽度                     │
│     docs/architecture.md  M │                                             │
│ notes/                      │                                             │
│ scripts/                    │                                             │
└─────────────────────────────┴─────────────────────────────────────────────┘
~~~

浏览范围仍是整个 Work，包括 SESSION.md、work.json、notes、scripts 和已登记的 repos 成员。Git 标记只显示在已验证成员仓库内的文件上；Work 根文件不因位于工作目录下就被视为 Git 文件。初期沿用只读阅读能力，不在此次设计中增加通用代码编辑器。

### 改动审查与提交

~~~text
[浏览] [改动 5] [历史] [分支] [Worktree]       lucyna ▾  分支 ▾  获取  推送
┌ 当前仓库的改动 ─────────────┬ 文件路径 / 未暂存·已暂存 / 统一·并排 ──────┐
│ 已暂存 2                    │ 文件级差异                                  │
│   docs/design.md            │ @@ hunk                       [暂存此块]    │
│   src/work-identity.ts      │ - old                                       │
│ 未暂存 3                    │ + new                                       │
│   src/App.tsx               │                                             │
│   ...                       │ [在对话中讨论]                              │
├ 提交信息 ──────────────────┤                                             │
│ 标题 / 描述                 │                                             │
│ [提交 2 个文件]             │                                             │
└─────────────────────────────┴─────────────────────────────────────────────┘
~~~

提交按钮是改动页的主要操作，推送为独立的次级操作。正文不出现内部协议、进程 ID、数据库状态或运行时实现术语；这些只进入可展开的诊断详情。

静态研究图展示 Blue 浅色的两个主要状态；图中仓库、路径、提交和代码都是演示材料，规范以本文为准：

- [文件浏览设计图](design/git-workspace/browse.png)
- [Git 改动设计图](design/git-workspace/changes.png)

## 3. 五个内部视图

| 视图 | 主要内容 | 主要操作与边界 |
| --- | --- | --- |
| 浏览 | Work 文件列表与文件阅读器；保留面包屑、文内查找、图片和 Markdown | 打开文件、查看该文件差异、把选定内容加入对话草稿；仓库外文件不显示暂存操作 |
| 改动 | 当前成员仓库的冲突、已暂存、未暂存与未跟踪文件；选中文件的 diff | 文件暂存/取消暂存、后续分块暂存、提交；冲突单独成组，不能当作普通已暂存文件 |
| 历史 | 可筛选的分页提交列表、分支/标签标记、提交详情和文件 diff | 默认当前分支；可切换全部历史、搜索作者或消息、比较两次提交；选中历史不 checkout |
| 分支 | 当前分支、本地分支、远端缓存、上游与领先/落后信息 | 分支查看与比较先交付；切换、合并等写操作需通过 Work 生命周期检查 |
| Worktree | 同仓工作树，显示路径、分支、登记归属、锁定与可清理状态 | 当前成员可进入浏览；其他 Work 提供定位入口；创建/删除/移动要协调 Work 登记与活动会话 |

仓库选择器默认列出当前 Work 已登记且验证通过的成员，保留无效成员的错误说明。一个 Work 有多个仓库时，每次提交、推送和分支操作均明确属于一个仓库，不提供“跨仓库一次提交”的暗示。可以提供只读的全部仓库改动摘要，进入具体文件后定位到相应成员。

「改动」徽标按不同文件路径计数。一个文件同时存在暂存和未暂存改动时，可以在两个分组中出现，两个分组数量不能简单相加作为文件总数。目录节点的徽标聚合其真实后代状态。

### 历史的详细构成

顶部是当前分支/全部历史范围、作者与消息筛选，以及“比较”操作。主区是可调宽的提交列表与提交详情；列表行包含提交图连接、消息、作者、时间和短 SHA。详情先显示完整 SHA、父提交和关联 refs，再显示文件列表与差异。选择提交只读取历史，不改当前 checkout；比较两项时明确标注“来源 → 目标”和比较方向。窄窗口中先选择提交，再进入详情，返回恢复筛选、选中项和列表位置。

历史中的“恢复/撤销”等写动作不与普通打开详情共用点击行为。P1 只提供查看和比较；后续动作从明确菜单进入，并显示对当前 Work 分支的影响。分页游标绑定过滤条件和引用快照，刷新后旧游标失效。

### 分支的详细构成

顶部保持当前仓库与执行环境。正文分为“本地分支”和“远端引用”，默认当前分支置顶；表格列出名称、当前/登记标记、最后提交、上游、领先/落后和占用它的 Worktree。选中行打开详情区，主要可用动作为“比较”和“查看历史”。远端数据标注读取/获取时间，不把缓存领先/落后当作已同步结果。

“新建分支”表单包含名称、起点和是否作为当前成员分支；“切换”明确列出受影响的 Work 和活动会话。相关事务能力缺失时，显示原因及“在对话中处理”，而非提供会导致登记漂移的裸 checkout 按钮。不能在用户只是浏览分支列表时自动 stash、fetch 或切换。

### Worktree 的详细构成

顶部展示仓库归组和“刷新”，正文以行列表呈现关联树：分支/分离 HEAD、路径、所属 Work、当前成员标记、锁定/可清理状态。只有已取得真实会话归属时才显示活动连接数，未检查的树标注“状态未读取”，不能用 0 或“干净”填充。

已登记当前成员提供“浏览文件 / 查看改动”，其他 Work 的成员提供“打开所属工作区”。创建面板列出目标 Work、分支/起点和受管目录；删除、移动和完成面板列出实际影响，并检查关联会话、脏文件和锁定状态。不能从“可清理”标记直接推断可以删除目录。“完成 Worktree”是否合并及何时清理由 Work 生命周期决定，操作结果分别呈现，不合并成一个模糊的成功状态。

## 4. 关键交互

1. **从对话到文件。** 点击现有文件引用、工作资产或原“预览”入口，切到当前 Work 的「工作区文件 / 浏览」，定位文件；阅读位置和原对话草稿保留。无需创建或启动 OMP 会话。
2. **从文件到 Git。** 成员仓库内的文件提供“查看差异”，定位「改动」中的相同文件和范围；未跟踪文件展示新增内容，删除文件展示旧内容。未变化文件给出“当前文件没有未提交差异”，保留返回阅读的入口。
3. **选择暂存内容。** 点击文件进入明确的未暂存或已暂存范围；分块操作写明“暂存此块/取消暂存此块”。选中文本用于讨论，选中 diff 行用于暂存，两个动作有独立可见入口。范围过期时要求刷新并重新选择。
4. **提交。** 用户填写标题，可选描述；按钮显示实际暂存文件数和目标分支。提交使用当前仓库真实 index，包括通过终端或代理暂存的内容。成功后显示提交摘要和 SHA，并重新读取状态；提交后仍有未暂存改动是正常结果。提交成功不显示为已推送。
5. **推送。** 操作前显示 remote 与目标分支；执行中显示进度。失败保留已完成的本地提交。不将“取消等待”或传输断开解释为远端操作已经取消。
6. **在对话中讨论。** 将用户选定的文件片段或 diff 加入现有对话草稿，并带 Work/成员/路径/范围/快照版本。切回「对话工作」由用户发送；不另建 agent，不自动发送，也不直接写入 Stele。先复用现有文本附件/草稿机制，超长片段显示截断范围。
7. **定位 Worktree。** 选择已登记成员不切换现有分支。其他 Work 的树通过其真实身份打开；不把未登记的任意路径静默升级为可写仓库。

## 5. 状态与反馈

| 状态 | 展示和可执行动作 |
| --- | --- |
| 未选择 Work | 提示先选择工作区；不启动扫描全盘或自动导入仓库 |
| 无 Git 成员 | 浏览正常；Git 视图说明当前 Work 尚未登记仓库，保留文件入口 |
| 初次读取 / 后台刷新 | 初次使用行骨架；刷新保留上次内容，显示读取时间和刷新状态；迟到结果不能覆盖新选择 |
| 干净工作树 | “当前仓库没有未提交改动”；提供浏览文件、查看历史，不把它当成错误 |
| 改动过期 | “文件已变化，请刷新后重新选择”；保留提交草稿，清除过期的行/块操作目标 |
| 冲突或 rebase/merge 中 | 显示当前仓库操作状态，普通提交按能力禁用；提供查看冲突与原终端入口；不自动跳过冲突 |
| Git 锁占用 | 显示“仓库正被其他操作使用”，可刷新；不删除 index.lock，不按时间猜测锁已失效 |
| hooks / 签名 / 认证失败 | 说明失败环节，保留草稿和可用结果；详情支持展开；不默认绕过 hooks 或签名 |
| 操作结果待核对 | 固定提示条“连接中断，正在核对操作结果”；提供核对与诊断，不显示直接重试提交/推送 |
| 二进制 / 超大 diff / 不支持编码 | 显示类型、大小和已加载范围；支持文件级操作的情况下仅提供文件级操作；不把截断内容用作分块 patch |
| SSH 未连接 / host 缺少能力 | 显示主机与能力状态；保留缓存并注明；提供现有连接/配置入口，不把缓存当作当前磁盘状态 |

同一 Work 中存在运行中的 OMP 会话时，读取文件与 Git 信息继续可用。状态仅从真实 session 数据得出；显示“会话运行中”不等于禁止所有暂存，也不代表应用能独占仓库。

## 6. 视觉、键盘和响应式

延续 DESIGN.md 的 Blue、Classic、Folio、Pixel 以及各自浅/深色，不新增一套 Git 专用品牌。上游页面的拓扑、密度与操作顺序保留；颜色、字体、图标和基础按钮映射到现有 Cindy 体系。Folio 的代码区与操作标签仍用现有无衬线/等宽字体，衬线只出现在允许的阅读标题中。

差异使用新增/删除文字和行号，加上语义背景；状态不只靠红绿区分。未知文件状态、已选择、焦点、运行中与失败具有不同语义。操作条保持紧凑，文件列表与 diff 各自滚动，提交表单有自己的可滚动区域，避免短窗口中按钮被文件列表挤出。

| 可用空间 | 结构 |
| --- | --- |
| 常规桌面 | 保留当前主题导航；文件/改动列表与阅读器或 diff 两栏；历史按空间展开提交列表与详情 |
| 内容区不足以容纳双栏 | 文件/改动列表改为可打开的局部抽屉，主阅读区优先；不擅自改变用户全局侧栏偏好 |
| diff 阅读区不足约 840px | 默认统一 diff；并排模式受实际容器宽度约束，不由整个窗口宽度猜测 |
| 960px 窗口 | 保持两个工作区标签；Git 次级操作进入更多菜单；提交表单可展开，状态与提交目标始终可查 |
| 390px 窄窗 | 沿用全局紧凑导航；文件列表与内容逐级进入；内部视图可横向导航；提交表单独立展开，不让固定按钮遮挡内容 |

两层标签各有独立 tablist，使用方向键、Home/End 切换并保留可见焦点；目录列表按实际树或列表语义实现，不只添加 tree 角色。Esc 关闭局部抽屉并返回触发位置。Ctrl+F 在当前阅读器中搜索；上下文快捷键不抢占对话输入、系统快捷键或已有 Ctrl+K/Ctrl+B。暂存与提交始终存在可见按钮。

## 7. 上游复用方案

采用 **GitDesktop 的改动—差异—提交布局作为统一主线**，不把多个项目各自的页面风格拼在一起。Lucyna 原有文件阅读能力继续使用。Ledger 和 GitBench 作为组件边界或工作树导航的参考；FoldGit 提供仓库归组与 worktree 工作流参考。

| 来源 | 采用部分 | 迁移边界 |
| --- | --- | --- |
| GitDesktop，Apache-2.0，e960a829b8e0daf1d7034a1599280d589033b02c | ChangesPanel、DiffViewer/DiffSurface、CommitBox、HistoryPanel 的布局、状态表达和可抽取交互 | 页面依赖其 TanStack Query、Zustand、快捷键与设置层；先提取 props/callback 边界，再接 Lucyna。Tauri invoke 由受限 Electron IPC 替换，不引入其 Rust 后端或另一套 AI/账户系统 |
| Ledger，MIT，33fde5d6f828639535b5929789aedcf796cec002 | DiffViewer 的数据/行选择/分块操作回调接口；暂存面板与 Worktree 导航参考 | 基础 DiffViewer 边界清楚；提交面板仍绑定 window.conveyor 与插件。仅在依赖验证证明有收益时替代相应模块，不并行维护两个 diff 引擎 |
| GitBench，MIT，fd7761844c88453007e70ea86fa707fdb7619255 | Worktree 导航、文件列表与自动刷新组织方式 | 是改动查看器，不能把其界面视为已有完整提交客户端 |
| FoldGit，MIT，11df44b0ece41d7c556002cfa926a9f4f7a9dbd1 | common-dir 归组、工作树发现、操作排队和过期 patch 的处理思路 | 不嵌入 SwiftUI/WinUI 窗口；完成 worktree 后合并清理的流程必须经过 Lucyna Work 生命周期 |

GitDesktop 调研版本使用 React 19.3、Tailwind 4，并使用 useEffectEvent；Lucyna 当前是 React 19.0、Tailwind 3。迁移切片必须核对 API 和样式依赖，不为迁入一个页面就整体升级应用工具链。保留被复用代码的许可与必要通知，记录固定来源版本及本地改动。

diff 组件迁移验证先比较 GitDesktop 采用的 @git-diff-view/react 与 Ledger 的组件方案；以现有依赖兼容、长 diff 性能、选区正确性和维护成本决定一个实现。设计布局不随这个技术选择改变。

## 8. Lucyna 代码集成位置

下表记录提案阶段的集成目标，不是当前文件清单。实现沿用现有组件与 IPC，并新增了以下受限模块：

`src/renderer/components/WorkspaceFiles.tsx`、`WorkspaceGit.tsx`、`WorkspaceDiff.tsx`；`src/git-service.cjs`、`src/git_workspace.py`、`src/workspace_files.py`；以及 `tools/lucyna-host/workspace.py`。Git 读写共用成员身份和快照校验，远端操作由声明 capability 的 host daemon 处理。

| 当前入口 | 计划变化 |
| --- | --- |
| src/renderer/App.tsx | 在 workbench 内加入工作区内容标签；分离现有工具 Tab 与新 WorkspaceTab；文件标签使用完整内容宽度 |
| components/PrimaryNavigation.tsx | 保持现有全局 Section；不增加 Git 主导航 |
| components/ToolPanels.tsx 的 PreviewPane/DocumentReader | 提取可复用阅读器与已打开文件管理；不再按 OMP session 各自拥有工作区浏览 |
| components/FileBrowser.tsx | 保留有界分页、路径检查、迟到响应隔离；扩展成员 Git 状态映射和更宽布局，避免直接扫描全部目录 |
| components/WorkDetails.tsx | 保留 Work 进展与登记检查；仓库改动/历史按钮转入文件标签中对应成员和视图，避免维护两套 Git 操作页 |
| workspace-files-store.ts、components/workspace-files/ | 新的 Work 级文件/Git 视图状态及页面；沿用现有状态实现习惯，不为迁移引入全局状态框架 |
| src/preload.cjs、src/main.cjs、renderer/types.ts | 增加固定文件与 Git 契约，并校验受信调用来源；不向 renderer 暴露任意 shell/进程调用 |
| src/work-details.cjs、src/work-details.py | 保留兼容的只读入口；逐步让底层 Git 读取共享解析与路径验证，写操作使用独立服务 |
| src/git-service.cjs、受限 Linux Git helper | 成员解析、能力、快照、命令编排、操作记录和执行器适配 |
| src/hosts/、tools/lucyna-host/ | 后续增加明确的 files/git 能力与服务端操作；复用已有 SSH 传输和安装身份 |

~~~mermaid
flowchart TD
  Workbench[工作区双标签] --> Files[工作区文件界面]
  Files --> State[按 Work 和仓库隔离的视图状态]
  Files --> IPC[固定 Electron IPC]
  IPC --> Catalog[服务端 Work 成员与仓库身份校验]
  Catalog --> Git[Git 服务与操作记录]
  Catalog --> Read[文件读取服务]
  Git --> WSL[WSL helper 调用系统 Git]
  Git --> Remote[SSH host Git 能力 后续交付]
  Read --> LocalFiles[现有 WSL 文件读取]
  Read --> RemoteFiles[SSH host 文件读取 后续交付]
  Files --> Draft[现有对话草稿 由用户发送]
~~~

## 9. 身份与状态隔离

工作区内容标签、当前内部视图、目录、打开文件、阅读位置、提交草稿和选中仓库按 Work 保存。沿用 work-identity.ts 的 hostId + 原始 root 规则；本机进一步由执行器上下文区分 distro/user，不能只按显示名称、basename 或分支名关联。

Git 查询缓存还必须包含服务端解析的 repoId、成员、比较范围和快照版本。repoId 是受限句柄，绑定执行环境、真实 worktree 路径和 common-dir；renderer 不提交可任意执行的绝对仓库路径。关联工作树可共享 common-dir 协调键，各自 index 和 HEAD 身份仍独立。

切换工作区时保留各自状态，清除当前不可用的行/块写入目标，防止旧请求污染新页。切换两个内容标签不结束 OMP，不重放 prompt，不清空草稿，不终止终端。已有知识库、活跃会话与桌宠行为保持其原有归属。

当前预览以 sessionFiles 和按 session 挂载的 PreviewPane 为主。迁移只用该 Work 当前有效预览初始化一次新的 Work 文件状态；不能把不同主机或不同会话全部打开文件混并。旧“预览”工具状态恢复为「工作区文件 / 浏览」，其余工具状态仍属于原对话。

## 10. 服务契约与实现边界

下表保留原设计中的能力/数据要点，不是逐项 IPC 方法名。当前本机入口为受限的 `work:details`、`work:git`、`workspace:git`；SSH host 通过 `workspace.files.*` 与 capability-gated `workspace.git*` dispatch。实际支持的操作和限制以第 16 节及产品文档为准。

| 固定能力 | 输入与结果要点 |
| --- | --- |
| workspace.files.list / read | Work 身份、服务端路径句柄或受限相对路径、分页/读取范围；返回类型、大小、内容或明确的不支持原因 |
| git.catalog | 当前 Work 的已登记成员、服务端 repoId、执行环境、登记诊断、读写能力 |
| git.status | repoId；返回 HEAD、symbolic ref、操作状态、文件状态、读取时间与 revisionToken |
| git.diff | repoId、文件句柄、unstaged/staged/baseline/commit 范围和版本；返回完整性、分块、可选取块/行 ID 与快照令牌 |
| git.history / refs / worktrees | repoId、固定筛选字段、分页游标；不返回无限历史，不从标题猜引用身份 |
| git.stage / unstage | operationId、repoId、文件/块/行 ID、预期快照；服务端生成并验证 patch，renderer 不提交任意 Git 参数 |
| git.commit | operationId、repoId、标题/描述、预期 HEAD/ref 与 index 快照；返回实际提交 ID、tree/parent 和结果状态 |
| git.fetch / push | operationId、repoId、已验证 remote/ref；返回进度与最终可核对结果；不默认 force |
| git.operation.get | 操作 ID 与身份；返回执行中、已完成、失败或待核对，以及足以核对的结果摘要 |

所有结果都包含足以与当前页面比对的上下文身份。错误使用结构化代码与用户文案，诊断保留有界 stderr 并隐藏凭据。缺少能力时界面给出说明；不通过普通 OMP prompt 模拟用户点击的 Git 按钮。

文件路径显示字符串与操作句柄分开。中文、空格、换行、通配符和非 UTF-8 路径不能在解码后被错误用于写操作；采用 NUL 分隔解析与服务端路径句柄。删除、重命名、文件同时暂存和未暂存、unborn HEAD、detached HEAD、子模块必须有明确状态。

沿用当前输出限额，并在完整性字段中表达截断。当前 Git diff 显示上限约 256 KiB，SSH 单帧约 2 MiB；新契约按文件/块分页或有界分块，不靠放大整条 IPC 消息解决。只有完整、可验证的文本快照才支持部分暂存。

## 11. Git 写入与并发

所有 Git 操作在仓库所属环境执行：本机 Work 使用 WSL Git，SSH Work 使用远端 Git。系统 Git 管理配置、SSH、凭据、hooks 与签名。现有只读 helper 的 stdin 关闭和禁止认证提示策略不能直接当作写操作通道；交互需求必须显式返回或接入受控的认证/签名流程，初期失败时可转现有终端处理。

Lucyna 对同一执行环境/common-dir 的自身写操作排队，组合读取也使用一致的应用内快照。该队列不控制 OMP、终端或外部 Git 客户端；保留 Git 原生锁，不删除或替代它们。

快照令牌至少绑定 HEAD/ref、当前 worktree 的 index 身份/内容以及选定文件内容与 diff 范围。写前校验和 git apply 的预检查都是乐观检查，不能宣称它们消除了检查与执行之间的外部竞争。执行后重新读取真实状态；过期选区失效，提交草稿保留。

**提交是独立的工程验证门槛。** 发布前必须通过临时仓库实验确定：审阅的暂存 tree、实际提交 tree、预期父提交、hooks 对 index 的修改，以及并发外部暂存如何一致且可恢复。可研究冻结 index 的方案，但不能为复用 UI 就绕过正常 hooks/签名，或覆盖外部新增的 index 内容；单次前置 hash 检查不足以作为验证结论。若验证不成立，P2 保持只读/暂存试验范围，不开放正式 GUI 提交。

每个写操作先记录 operationId、请求摘要与预期状态，再执行。重复相同 ID 只查询/返回相同操作，参数变化拒绝；崩溃、超时和断线后无法确定的操作进入待核对状态，不能自动重放 commit/push。持久记录与结果核对能力先于可点击的正式提交按钮交付。

切换分支、合并、移动或删除 worktree 还要检查 Work 登记和活动会话的 executionRoot。当前 WorkMember 有 registeredBranch/baseSha 等约束，任意 git switch 会造成登记漂移。优先接入经验证的 Work 生命周期事务；当前没有合适接口时，用“在对话中处理”生成明确草稿并由用户发送，不能静默修改 work.json/SESSION.md 或自动停止会话。

## 12. SSH 扩展

当前 host 已通过 hello/capabilities 明示 `workspace.files.list/read`、`workspace.git.read` 和 `workspace.git`。Windows 主进程按 `hostId + root` 路由文件与 Git 请求；远端 daemon 复用同一 Git 服务和 SQLite 操作记录，不复用 OMP 控制 epoch 作为 Git 仓库独占权。旧 host 不具备这些能力时继续提供既有会话能力，并提示在 SSH 设置中更新。

设置中的「更新主机组件」部署并校验 frozen host。更新前检查远端 OMP session SQLite 和 Git operation SQLite，发现活动会话或 Git 操作就拒绝并保持旧服务；安装或健康检查失败会尝试恢复旧 unit 与服务。这个守卫只覆盖 host 持有的 session/Git 操作，不冻结外部终端或其他客户端的 Git。

远端文件服务将相对路径解析到当前 Work 根并拒绝越界符号链接；UTF-8 文本与支持的图片预览上限为 1 MiB。Git 凭据、配置、hooks 和签名工具留在执行 host。需要交互认证或签名时，用户要在该执行主机的终端中处理。daemon 先持久化 operation ID，桥接断开后通过操作记录核对，不自动重放写入。远端终端、附件落盘、aarch64 与跨物理 SSH 环境仍不在本次已验收范围内。

## 13. 分期与验收

| 阶段 | 交付 | 放行条件 | 当前实现状态 |
| --- | --- | --- | --- |
| P0 文件标签迁移 | 双标签、现有浏览/阅读升级、文件跳转与 Work 级状态；本机 WSL | 对话草稿/终端/滚动/主题切换保持；浏览不启动 OMP；原预览恢复能迁移 | 已实现；读者位置为进程内 Work/host 状态，重启不恢复 |
| P1 Git 只读工作区 | 成员选择、状态、逐文件 diff、历史、分支和 Worktree 查看 | 特殊路径、分页/截断、迟到响应、跨 Work/host 隔离与大仓库性能通过 | 已实现；完整路径/主题/窗口验收矩阵仍在核对 |
| P2 文件暂存与提交 | 文件与服务端生成的块/行 stage/unstage、受保护提交、持久操作记录 | hooks/签名正常执行；提交只含审阅 tree；保留外部暂存；断线可核对 | 已实现；真实 WSL 临时仓库测试通过 |
| P3 精细审查与同步 | 块/行审查、fetch、push、进度与断线核对 | 补丁作用范围准确；过期 diff 拒绝写入；push 后校验远端 ref，不 force | 已实现；没有强制推送或冲突编辑器 |
| P4 分支与 Worktree 生命周期 | 创建/切换/快进合并/成员工作树创建、移动、移除及登记协调 | 活动会话保护、干净树、登记失败恢复；未支持的操作明确不可用 | 已实现；仅当前 Work 的登记成员；merge 为 fast-forward-only；socket 所有的 WSL WorkRunner 租约阻止普通/自动任务启动 |
| P5 SSH 功能对齐 | capability-gated 远端文件、Git 读写和 host 更新/恢复 | 新旧 host 协商、制品升级、路径边界、传输/服务中断和待核对操作通过 | 隔离 loopback/frozen 验收通过，含旧 release 到当前 release 升级与稳定安装身份；跨物理/aarch64 不在认证范围 |

实现状态不代表完整验收矩阵通过；当前验证边界见第 16 节。

必要验收包括：四主题×浅深色的主要状态；1440/960/390 窗口；键盘与系统缩放；空 Work/多仓库/大量文件；中文和特殊路径；重命名/删除/二进制/子模块；部分暂存与外部并发；unborn/detached HEAD；hooks/签名/SSH 失败；每个写入阶段的崩溃与结果核对。验证对实际用户结果负责，不以静态截图证明 Git 执行正确。

## 14. 设计结论与待验证点

已确定并实现：工作区内的双标签和原浏览升级、五个文件视图、单仓库 Git 操作、保留现有视觉系统、通过 `react-diff-view@3.3.2` 展示差异，以及 WSL 与 capability-gated SSH 服务。

仍需完成：完整 UI/特殊路径/故障发行验收矩阵，以及跨物理主机、其他发行版和 aarch64 的兼容认证。旧 frozen host 到新 release 的升级已在隔离 loopback 验收中通过，但这不等于上述认证。独立 finish review 已确认 contract finding 与列出的回归修正均已解决，结论为 ship；它不替代 Git 执行正确性或全平台发行认证。实现限制见第 16 节。

## 15. 核对依据

- 本地产品与视觉：PRODUCT.md、DESIGN.md、src/renderer/App.tsx、src/renderer/components/ToolPanels.tsx、FileBrowser.tsx、WorkDetails.tsx、WorkspaceFiles.tsx、WorkspaceGit.tsx、WorkspaceDiff.tsx。
- 本地 Git 与身份：src/git-service.cjs、src/git_workspace.py、src/workspace_files.py、src/work-details.cjs、src/work-details.py、src/renderer/work-detail-data.ts、src/renderer/work-identity.ts。
- SSH 当前边界：docs/ssh-host-review.md、src/hosts/connection.cjs、src/hosts/ssh-frozen.cjs、tools/lucyna-host/host.py、workspace.py、sessions.py、install.py。
- [GitDesktop ChangesPanel](https://github.com/theBGuy/GitDesktop/blob/e960a829b8e0daf1d7034a1599280d589033b02c/src/features/repository/ChangesPanel.tsx)、[DiffViewer](https://github.com/theBGuy/GitDesktop/blob/e960a829b8e0daf1d7034a1599280d589033b02c/src/features/diff/DiffViewer.tsx)、[CommitBox](https://github.com/theBGuy/GitDesktop/blob/e960a829b8e0daf1d7034a1599280d589033b02c/src/features/commit/CommitBox.tsx)、[workingtree API](https://github.com/theBGuy/GitDesktop/blob/e960a829b8e0daf1d7034a1599280d589033b02c/src/lib/git/api/workingtree.ts)、[许可](https://github.com/theBGuy/GitDesktop/blob/e960a829b8e0daf1d7034a1599280d589033b02c/LICENSE)。
- [Ledger DiffViewer](https://github.com/peterjthomson/ledger/blob/33fde5d6f828639535b5929789aedcf796cec002/app/components/ui/DiffViewer.tsx)、[项目与许可](https://github.com/peterjthomson/ledger/tree/33fde5d6f828639535b5929789aedcf796cec002)。

- [GitBench 架构与功能](https://github.com/tugkanpilka/gitbench/tree/fd7761844c88453007e70ea86fa707fdb7619255)、[FoldGit Windows 执行层说明](https://github.com/dufu1991/foldgit/blob/11df44b0ece41d7c556002cfa926a9f4f7a9dbd1/Platforms/Windows/README.md)。

## 16. 实施进度（2026-11-01）

P0–P5 的本机 WSL 与 capability-gated SSH 实现已落地：

- P0/P1：双内容标签、Work/host 隔离的文件浏览与阅读，以及改动、历史、分支和 Worktree 视图。历史支持消息筛选、分页和过期游标/响应隔离；baseline 比较清除旧单文件筛选。
- P2：整文件及服务端生成的 hunk/line stage/unstage；提交只使用审阅的 frozen index，保留正常 hooks/签名，检查 tree 与 parent，并保留并发期间外部独立暂存的内容。
- P3：有 operation ID、SQLite 操作记录、状态轮询/核对和明确 acknowledge 的写请求；fetch 与 push 对已配置远端执行，push 后核对目标 ref，不提供 force push。
- P4：创建/切换分支、fast-forward-only merge；创建、改名/移动和移除当前 Work 已登记成员的 worktree。生命周期操作要求无活动 Work 会话和干净树；socket 所有的 WSL WorkRunner 生命周期租约阻止普通与自动任务启动，并在 socket EOF 时释放；保留 Git 分支，不操作其他 Work。
- P5：SSH host daemon 提供 capability-gated 文件/Git 读写与升级入口。远端预览最大 1 MiB；upgrade 检查 session/Git 操作 SQLite，繁忙时拒绝，部署失败尝试回滚。

实际限制：没有冲突编辑器、分叉合并或 force push；Worktree 操作仅作用于当前 Work 的受管成员。SSH 终端和附件落盘仍未接入。Git 配置、凭据、hooks 和签名工具留在执行 host；需要交互的认证/签名在该 host 的终端中处理。提交说明与待核对 operation ID 保存在客户端 localStorage；文件列表位置、已开文件和 reader positions 仅在客户端内存中保持，重启不恢复。

已知验证（2026-11-01）：Node 回归 231 项通过、1 项跳过；类型检查、renderer 构建与 gallery 验收通过。真实 WSL Git Python 测试 13 项、文件/恢复/安装器/WorkRunner-wire 测试 5 项通过；WorkRunner 10 项、自动任务 8 项、Work Details 8 项、SSH host 9 项与 SSH session 9 项通过。生产 renderer 对临时 WSL Git 的验收 9 项通过且 OMP 启动数为 0，其中包含签名失败保留草稿及 Worktree 移动/移除后的成员选择。OpenSSH/frozen host workspace 验收 8 项通过，包含旧 frozen release `592319da` 到当前 release `0856d99d` 的升级并保持 installation ID。上述测试使用隔离 WSL loopback 环境，没有重启用户正在使用的客户端或 host。跨物理主机、aarch64 及完整主题/窗口/特殊路径/故障发行验收矩阵仍未认证。独立 finish review 已对 contract 修正和列出的回归批次给出 ship；未宣称全平台发行认证。
