# 开发与验证

## 辅助模型

设置 → 辅助模型，填写基础 API 地址（通常含 `/v1`）、协议、模型和可选 API Key，测试连接后保存并启用自动命名。密钥通过 Electron 异步 `safeStorage` 加密，保存在客户端数据目录的 `auxiliary-settings.json`；读取设置不回传密钥，留空保留，勾选清除后保存才移除。系统加密不可用时拒绝保存密钥。模型测试使用当前草稿，不自动保存，产生一次短请求；用户会话文本只在开启自动命名后按限额发送。

自动命名也默认覆盖已打开或重连的无名称历史会话，无需再发送消息；已有 OMP 原生名称保留。只读取现有连接返回的历史，不遍历并启动未打开的归档；正在运行的会话等待空闲。重复载入相同历史不重复生成，配置保存后会重新检查已连接会话，API 并发最多两条。

`npm run test:auxiliary` 使用独立 profile、正式界面和本地模拟 API 验证两种协议、加密、保存/重开/重载/取消、窄屏布局与自动命名同步，不调用付费模型。`npm run test:auxiliary:native` 另需配置的 WSL OMP，创建 `/tmp/lucyna-naming-*` 隔离记录并通过真实 RPC 写入名称，不打开用户原日志或发送 OMP prompt；结果保留在 `.runtime/auxiliary-native-result.json`。默认单元测试覆盖凭证处理、SDK 请求、失败重试和迟到结果隔离。模拟 API 不代表真实提供商的认证、响应兼容性或命名质量已验收。

## Work Runner

`automatic.py` 在同一个服务中持久保存 Work 评测配置、文件版本、触发与客户端活动；独立于 renderer 的计时器检测空闲和文件变化。主进程上报连接/忙碌状态，失联的活动连接不被当作空闲。自动实验使用现有隔离 worker，只生成候选，采纳仍由用户明确触发；普通会话可继续使用。预算不随自动恢复重置，用户暂停不自动恢复。默认空闲 60 秒、冷却 30 分钟、滚动 24 小时每 Work 2 次、自动实验全局串行。新增离线回归 `python3 test/work_automatic_test.py -v` 覆盖去重、重启、活动租约、配额、漂移和恢复。自动调度不能替代用户提供可信的训练/留出检查。

`tools/work-runner/` 核心是 Python 3.10 标准库服务，`src/work-runner.cjs` 是可断开的 WSL stdio 连接，`WorkRuns.tsx` / `WorkRunVisuals.tsx` 提供 Work 内入口、阶段时间线、候选分数和差异。服务 SQLite 采用 WAL/FULL，派发前保存意图；systemd 持有进程，socket 0600。普通后台任务的模型调用沿用 WSL OMP 认证环境。进化实验调用本地辅助 agent；两者均不把模型认证字段存入运行数据库。

OMP 18.13.3 的 `--no-tools` 不排除后加载的 MCP 或自动学习工具。任务 overlay 关闭 autolearn 和 memory backend；服务自带 `policy.mjs` 显式加载并完成握手，每轮启用登记的 Work 工具，执行前阻止其他工具和模型自行替换 goal 预算。恢复 goal 时必须重新启用已登记工具，不能只过滤当时的活动集合。

`capabilities.py` 提供受控搜索、公共 skill 读取、Stele 读取白名单、隔离命令和成员 Git 查看。不是启用原生通用 bash 后靠提示约束；公共 home 不挂载给命令，固定验收文件与 Work 身份文件只读。`evolution.py` 管理快照、worker、采纳日志与回退，`evo_worker.py` 在独立 venv 中实际调用 AntOmniEvo `Optimizer`、`ParetoFrontierEvolutionAlgorithm` 和 `LocalCandidateStore`；`LocalAgentProposer` 通过私有 stdio 调用现有 `AuxiliaryAgent`（AI SDK `ToolLoopAgent`），用目标文件白名单迭代 Work，不创建 OMP session，`WorkSystem` / `WorkEvaluator` 运行冻结检查并映射归一化分数。并发候选数为 1，训练反馈送入 proposer，留出结果只用于评估/选择和用户展示。留出集参与多轮选择，不等于完全未触及的最终泛化测试集。

离线回归：`node --require ./test/setup.cjs --test test/work-runner.test.cjs`；WSL 中运行 `python3 test/work_runner_test.py -v` 和 `python3 test/work_evolution_test.py -v`。Python 测试需要 bwrap，使用临时文件和假 RPC，不访问真实 Work、不调用付费模型。`work_local_agent_test.py` 另用真实 AntOmniEvo 和本地 HTTP 模拟模型验证完整本地 agent 工具循环，缺少可选 Ant 环境时跳过该项。真实模型、Ant 优化器、Electron 采纳/回退及服务 SIGKILL 验收使用独立临时 Work、服务单元和客户端 profile，不进入默认测试。

本地 agent 的模型接口与密钥复用「辅助模型」配置，与自动命名开关独立。Work 每步（模型调用及工具执行）使用独立的 120 秒超时，整个实验另受总时长限制；会话标题保留辅助模型设置中的短请求超时。主进程解密后经私有管道同步给服务，凭据仅保留在内存；正常关闭客户端后可以继续运行，服务重启后等待客户端重新同步。实验可覆盖同一接口中的模型名称。WSL 需 Node.js 22+（支持现有 NVM 安装）；agent 直接复用客户端的 SDK 模块，限 12 步、每步最多 16384 输出 Token（计入原实验总预算），逐步核算总预算，未知用量或中断按预留上限记账。确认写入且训练检查通过后立即交回 AntOmniEvo，不再请求模型生成总结；独立留出检查仍由框架执行。只提供 Work 文件列举、读取、受限写入和训练检查，留出文件不可读取，公共 L3/skill 不进入工具集。暂停/取消会结束整个 worker 进程组。

不宣称普通原生会话热迁移、外部副作用自动重放、多仓 Git 写入或长期进化收益。维护协议时检查 v2 分块、问题代次、同 Work 准入、冻结输入、候选快照漂移、采纳中断与故障后的旧进程身份。源快照最多 100 MiB/10000 文件，忽略 node_modules、.agent-tmp、__pycache__ 和私有路径；实验依赖应放在可复制输入中。候选库保留用于审计，不自动清理。

```text
src/                 Electron 主进程、预加载、会话与文件服务
  renderer/          React UI、阅读器、知识库、Cindy 组件
  pet/               独立桌宠窗口、动画、通知
  assets/            应用 PNG / ICO / 托盘图标
tools/               Work/Stele 桥接、图标和 sprite 准备工具
test/                单元测试、合成数据 Electron 回归、截图脚本
examples/demo-work/  最小无 Git work 示例
design/              Logo 与像素动画源素材、预览和生成记录
docs/                公共文档与演示截图
```

| 命令 | 用途 |
| --- | --- |
| `npm test` | 离线 Node 单元测试，使用固定的测试 runtime |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build` | 构建 React renderer |
| `npm run test:renderer` | Electron 中的真实 UI + 合成后端回归，不调用模型 |
| `npm run test:chrome` | Windows 合并顶栏、中文菜单、主题、快捷键与窄窗口回归 |
| `npm run test:taskbar` | Windows 任务栏图标、原生快捷方式属性和启动路径验证；加 `-- --preview` 可观察任务栏 |
| `npm run test:drafts` | 真实 IndexedDB 读取失败、输入保留、安全重试及大文本/图片重载验证 |
| `npm run test:attachments` | 文本附件粘贴/预览/移除、持久草稿、跨会话保存失败、默认文件引用、显式全文及窄屏验证 |
| `npm run test:attachments:native -- --work=/绝对/work/路径` | 可选真实 Windows/WSL OMP 模型读取 `local://`，原会话恢复和 Windows 短路径缓存恢复；仅创建隔离验收会话 |
| `npm run test:single-instance` | 重复启动唤起已有窗口，不另开 profile 数据库或丢失输入 |
| `npm run test:sessions:restore` | 两个独立 Electron 进程共用隔离 profile，验证退出重开后多 work / session 原路径恢复、手动断开、已完成未读及正文/图片/长文本草稿；使用合成 RPC，不调用模型 |
| `npm run test:experience` | 空会话、删除文件范围预览与取消、会话和 Work 备忘的真实移动/恢复、慢连接、长历史时间轴、并行监控、停止后的草稿归属与窄窗口回归 |
| `npm run test:usability` | 独立 profile 与合成服务：文档加载/空白/失败/竞态、证据检索来源与版本、连接冲突预检、宽表单固定操作区、工作区筛选、设置导航与窄屏布局 |
| `npm run test:work:ui` | 工作详情、搜索、来源跳转、阅读位置、大 diff、窄窗口/深色与读取失败保留旧数据的离线 UI 回归 |
| `npm run test:history:native -- --work=/绝对/work/路径` | 可选真实 OMP 验收：原地续聊、显式复制、原件/副本切换与跨运行时复制 |
| `python -m unittest discover -s test -p work_inventory_test.py` | 临时 Git 仓库中的工作区诊断测试 |
| `python -m unittest discover -s test -p work_details_test.py` | Linux 临时 Git 仓库中的工作详情、分离差异、资产索引、路径边界与旧版 Git 兼容测试 |
| `npm run test:pet:animation` | 动画状态、帧尺寸与设置回归 |
| `npm run test:pet:layout` | 桌宠布局回归 |
| `npm run test:pet:recovery` | 桌宠画布丢失、隐藏/唤醒、跨屏重置与渲染进程崩溃恢复；隔离 profile，不启动 OMP |
| `npm run test:pet:playback` | 透明窗口误报遮挡、系统/客户端减少动态、独立始终播放、拖动结束与固定窗口轮廓；附加 `-- --visible` 可显示隔离桌宠 |
| `npm run screenshots` | 用生产 renderer 与合成数据重建 `docs/screenshots/` |
| `npm run pet:preview` | 交互查看像素动画素材 |
| `npm run icons:build` | 从保留的设计稿重新生成应用图标 |
| `npm run dev` | 浏览器 UI 开发预览，不连接真实 OMP/WSL |

桌宠不见时，设置 → 桌面伙伴 → “重新显示并重置位置”会立即重建两个桌宠窗口，并移到工作台所在显示器右下角；不重建主窗口、OMP 连接或通知模型。锁屏/休眠后恢复时，同样重建已启用且未被用户隐藏的桌宠窗口，保留位置、会话和待办；同一轮唤醒的重复事件合并，恢复排队期间重新锁屏或隐藏则跳过重建。隐藏后显示和画布上下文恢复会强制重绘当前帧；上下文丢失期间使用静态角色。渲染进程异常最多自动重建两次/分钟，避免崩溃循环。客户端数据目录的 `desktop-pet-window.json` 保留最近 30 条窗口生命周期记录（位置、可见性、隐藏/锁屏状态、退出原因），不记录会话内容。回归测试模拟画布清空、上下文与锁屏/唤醒事件，实际终止隔离渲染进程，并通过正式设置页验证立即恢复与未保存选项保留；不代表所有显卡或远程桌面的合成行为都已覆盖。

桌宠动画支持跟随系统与客户端动态效果、始终播放（仅桌宠）、关闭三档；旧设置保持跟随模式，显式始终播放不修改系统或客户端的减少动态偏好，隐藏和锁屏仍暂停。悬停状态标签可以区分系统/客户端减少动态、拖动暂停、静态动作结束。播放只服从原生隐藏/锁屏状态，不因 Chromium 对透明窗口的遮挡判断停止。Windows 使用全部姿势的合并轮廓，换帧不再反复修改原生窗口；原生拖动退出时立即恢复动画，位置保存独立完成。

桌面测试需要可运行 Electron 的 Windows 会话。默认测试使用独立临时 profile，不接触运行中的用户客户端；截图脚本不加载生产 preload，也不调用模型或 WSL。

工作详情验收使用 `test/desktop-log.cjs` 将日志先写到本次 `.runtime/` 目录的 `desktop.log`，再输出到终端。调用方关闭 stdout/stderr 管道时仅处理 `EPIPE`，测试继续保存结果并正常退出；其他异常保持可见，不使用全局异常吞噬。新增 Electron 验收入口应复用此日志工具。

测试报告应区分 **逻辑单测**、**合成协议驱动的真实 UI** 和 **真实模型/WSL 实测**。后者需要明确选择独立测试 work 与 profile，确认模型费用和写入范围，不能拿截图 fixture 当作成功证据。

`test:history:native` 不属于默认离线测试，需要先构建 renderer、配置 WSL 和 Windows OMP，并指定已发现的有效 work。它使用独立客户端 profile，通过真实模型创建带有“Lucyna 原地续聊验收”标记的新 journal，再实际操作生产历史界面；会消耗少量模型额度。它不打开用户已有 journal，也不写 work 文件；测试日志与副本留在忽略目录 `.runtime/history-native-*/`，原生测试 journal 留在该 work 对应的 WSL OMP 历史目录。

历史本机验收日志、旧截图和迁移脚本保持在本地忽略目录，不作为项目依赖。`runtime.local.json` 变化需要重启测试进程；不要为了加载 UI 变更而中断正在运行的真实会话。

历史删除先由主进程验证 journal 所属配置目录、原始 cwd 和会话 ID，再返回文件清单与确认令牌。实际删除重新检查关联与文件指纹；客户端连接和原生 WSL OMP 的会话锁均阻止删除。Linux 锁兼容使用系统 `libxxhash`，额外检查旧进程的写入描述符；Windows 使用禁止写入但允许重命名的文件句柄。无法检查时保留文件并报错。会话、同名附件目录与重写备份移到 agent 根下 `.lucyna-trash`（不在 sessions 内）；明确匹配的 `SESSION-<id>.md` 移到 Work 根下 `.lucyna-trash`，共享文档与 Stele 不动。短 ID 冲突且没有完整 ID 声明、旧副本共享 ID 或历史源不完整时，备忘保留并在确认框说明。

`history-trash.json` 在移动前刷盘保存事务清单；中断后回收站仍可恢复，旧版仅隐藏记录也兼容。移动与恢复使用不覆盖目标的原生重命名；部分失败先回退，无法完整回退时保留清单和所有文件。恢复冲突不覆盖，不能用通用 `rename` 的默认覆盖语义替代。删除后的已打开标签保留阅读内容和草稿归属，恢复前不再自动连接。

工作详情通过 `work:details` / `work:git` 按需调用 WSL `work-details.py`，不会在每次流式消息时扫描仓库。主进程限制已发现的 work 与只读操作；成员操作再次验证 `work.json`、实际路径与 Git common-dir。Git 禁用可选锁、外部 diff 和 textconv，显示未暂存/已暂存/登记 baseSha 到 HEAD 三种不同范围；输出有界，大 diff 在独立滚动区域展示。Ubuntu 22.04 的旧版 `worktree list --porcelain` 与新版 NUL 输出都支持。分支列表保留当前分支，并分别限制本地/远端缓存引用；不自动 fetch。

工作记录保留来源与时间，不把文档中的授权当作客户端新授权。L1 读取 notes 实际文件，L2 读取根目录 SESSION 日志，scripts 只列顶层内容，临时证据仅列 L0 文档引用；未登记到 L0 的笔记与日志仍可见。日志 ID 唯一匹配现有 OMP 历史时才提供续聊。Stele 使用现有查询接口；Work 技能按钮填入草稿，仍由用户发送。MR 查询以实际 Git 远端识别项目（支持非 origin 远端），歧义数字 MR 不猜测目标；显示流水线 SHA 与本地/MR HEAD 差异。上述查询不改工作登记、源文件、Git 引用或用户会话。

Windows 主窗口使用一条自绘菜单顶栏，右侧保留系统原生窗口按钮。菜单仍调用 Electron 原生编辑与窗口功能，标题栏空白区域支持拖动及双击最大化。设置环境变量 `OMP_CINDY_NATIVE_TITLEBAR=1` 后启动，可恢复系统标题栏与默认菜单；不改变用户数据。`start:legacy` 也保留原生标题栏。加载这类主进程修改需要重新启动客户端，应在运行任务结束后进行。

Windows 任务栏单独设置窗口的 AppUserModelID、Lucyna 图标和重新启动信息。图标复制到应用数据目录，保证 Explorer 能直接读取，也兼容未来的 ASAR 打包；源码启动使用绝对项目路径，避免从任务栏启动时打开 Electron 默认页面。此设置不修改系统图标缓存或用户固定的任务栏项目；独立 EXE 的文件图标仍需由打包工具设置。

`electron tools/create-shortcut.cjs <绝对路径.lnk> <已有数据目录>` 可创建绑定现有 profile 的 Windows 快捷方式。启动参数使用 `--user-data-dir`，任务栏重开时也保留该物理路径，避免从 Codex 与资源管理器启动时因 AppData 虚拟化出现不同配置和草稿。`LUCYNA_USERDATA` / `OMP_CINDY_USERDATA` 环境变量仍优先；相对路径不接受。工具在独立临时 profile 中运行，不连接用户会话。

同一物理 profile 只允许一个客户端进程。重复点击快捷方式会显示已有窗口，包括因桌宠而隐藏的主窗口，不再并发打开 Chromium 草稿数据库。草稿读取失败时禁止写入，避免旧草稿被空值覆盖；每 5 秒及重新聚焦时重试，也可手动重试。恢复后合并期间新输入的内容，保留其他会话草稿，提示随实际恢复自动消失。故障期间的当前输入只在窗口内保留，关闭前应复制。

打开的会话记录保存连接恢复意图、未读标记和已结束轮次的耗时/结果状态。完整退出结束普通 OMP 进程；重开优先恢复上次选中会话，再以最多两条并发启动接回其余原始 journal，不发送 prompt 或重放中断工具。手动“结束连接”清除恢复意图，回收站内会话不重连；单条失败进入待处理，其余继续。工作区暂不可用时保留会话与草稿，刷新工作区后重试。仅重载渲染器时接回现存进程，不创建第二个 writer。旧版缺少连接意图的已打开历史标签会在升级后恢复一次，此后按明确的连接/断开状态保存。

`npm run test:experience -- --preview` 在回归通过后保留独立的演示窗口，使用临时 profile 和合成协议事件，不启动 OMP。窗口持续显示“演示数据”横幅；知识库使用明确标记的示例文档，不连接真实 Stele。截图输出到忽略目录 `.runtime/experience/`。此窗口用于检查菜单、收起侧栏、时间轴、会话监控和知识库交互，不能作为真实模型或服务成功的证据。日常使用请通过 `npm start` 打开正式客户端。

完成提醒只提取 OMP `message_end` 中的可见最终文本和本轮工具统计，不增加模型请求。提醒分两行显示工作区短名称与会话标题，长标题最多两行。优先采用 OMP 会话名称，缺少名称时提取首条用户消息的短摘要；历史恢复及后台会话也直接从原生事件补齐，不依赖当前选中页面。默认隐私模式不向桌宠窗口传递回答摘录和完整工作区路径，仍保留用于识别任务的名称。时间轴仅在消息或工具结束等事件上重建；跳到很早的记录先渲染附近 80 条，再按需展开，避免把全部历史同时放进 DOM。

时间轴按对话区的实际宽度切换布局：达到 960px 时保留 240px 常驻目录，正文和输入框对齐；空间不足时只显示细轨道，悬停或键盘聚焦查看摘要，方向键选择节点、Enter 跳转。阅读位置只测量已挂载的历史片段，按 80ms 合并滚动和尺寸更新，不扫描整个会话。目录每页最多 30 项，轨道密度随高度调整。搜索、跳转和点击正文都不会关闭目录。

## 字体、品牌图片与安全构建

`npm run build` 和 `npm start` 的预构建现在先写入 `.runtime/renderer-build-*`，成功后保留旧哈希资源、原子发布新资源，最后切换 HTML 入口。正在运行的窗口仍能加载旧的图片、字体和懒加载模块。不要在客户端运行时手动清空 `dist/renderer`；需要精简发布包时在独立目录构建。

UI、文档与桌宠使用随包附带的思源黑体 SC 可变字体，来源与许可见 `src/assets/fonts/`。代码与终端保持等宽排版，中文回退到思源黑体。`npm run test:typography` 在隔离 Electron 窗口中粘贴后选择“全文发送”并发送 342,000 字符，注入品牌图片资源失败，检查矢量兜底、完整发送、中文实际字体及深浅色窄屏。`--expect-broken` 仅用于旧构建缺陷复现；不启动真实模型、不修改系统剪贴板。`test/renderer-publish.test.cjs` 验证旧窗口资源不被删除、相同文件不被重写和失败时入口不切换。

## 声音与动效回归

`npm run test:feedback` 使用隔离 profile 加载正式 preload、设置页面和隐藏音频窗口，验证两种风格试听/保存/取消、20 会话合并、前台静音、锁屏去重以及系统减少动态偏好。测试使用原生事件回放，不启动真实模型；系统输出在自动化期间静音，验证本地音频解码和播放，不代替主观听感验收。截图和结果位于 `.runtime/feedback-desktop-*`。策略与文件测试位于 `test/feedback.test.cjs`，桌宠像素变化另由 `npm run test:pet:animation` 验证。

六个音频文件由 `python tools/build-feedback-sounds.py` 确定性生成（48 kHz、16-bit、单声道 PCM），没有外部录音或第三方音乐。`src/feedback/` 将设置持久化、通知策略与音频输出分开；音频窗口不加载会话文本或网络内容。偏好保存在客户端数据目录 `feedback-settings.json`，保存时保留 `.bak`。声音不加入 OMP agent loop，也不额外请求模型。

## 知识库验收流程

`npm run preview:knowledge` 用独立临时 profile 打开正式渲染器，读取当前本地 Stele 的真实图谱；该预览的主进程拒绝写入、模型生成和恢复操作，不连接 OMP。日常完整功能使用 `npm start`。

`npm run test:knowledge:native` 对预留端口 `19015` 的隔离 Stele 执行真实 API 和桌面操作验收。先在 WSL 的仓库目录执行 `python3 tools/knowledge-fixture.py`；可用 `LUCYNA_STELE_BINARY` 指定已有 Stele 二进制。夹具生成独立 HOME/数据目录和 Markdown 文档，关闭会话索引与公开分享，本地 `19017` 协议夹具提供模型响应。它验证文档强版本冲突、证据定位、图谱、资料捕获/采纳、复核转待办、报告、设置和恢复包，不测量真实模型质量或消耗真实模型额度。结果、截图和恢复包保留在忽略目录 `.runtime/knowledge-native/`。

知识接口的默认离线测试见 `test/knowledge-reader.test.cjs` 与 `test/knowledge-service.test.cjs`。新增或修改 API 操作应保持固定路由映射、范围/版本检查和明确的失败状态。

### 文本附件

默认将达到 100 行或超过 8,000 字符的单次粘贴保存为附件草稿，任务正文独立保留。只有发送时才连接当前会话并写文件；每份附件可改为全文发送。附件原文存于 IndexedDB，提交成功后移除，失败不丢失。正文与文本附件合计最多 4 MiB、最多 8 份；预览按 16,000 字符分段，避免大文本撑开界面。

实现遵循 [OMP 18.13.3 local 协议](https://github.com/can1357/oh-my-pi/blob/v18.13.3/packages/coding-agent/src/internal-urls/local-protocol.ts) 的目录规则，使用原生 `read`，不增加工具或 agent loop。RPC 当前没有写粘贴文件命令，因此主进程从所选连接的 `get_state` 获取真实 journal，按内容哈希写入同名附件目录下的 `local/`。WSL 使用 Linux 原子写入助手，避免 Windows UNC 不支持硬链接；不会创建 Windows 会话副本。Windows 原生目录达到 180 字符时使用其 `omp-local/<session-id>` 短路径，同时在 journal 旁保留持久副本，重连时恢复缓存。

停止后恢复的原生排队消息包含原 `local://` 引用，继续发送仍可读取同一会话文件。删除历史时持久附件目录沿用已有回收逻辑。提交前通过内容哈希校验和独占发布防止覆盖同名文件；异常保留草稿，不自动降级成全文发送。
