# 开发与验证

## Work Runner

`tools/work-runner/` 核心是 Python 3.10 标准库服务，`src/work-runner.cjs` 是可断开的 WSL stdio 连接，`WorkRuns.tsx` / `WorkRunVisuals.tsx` 提供 Work 内入口、阶段时间线、候选分数和差异。服务 SQLite 采用 WAL/FULL，派发前保存意图；systemd 持有进程，socket 0600。模型调用沿用 WSL 认证环境，不把环境或模型认证字段存入运行数据库。

OMP 18.13.3 的 `--no-tools` 不排除后加载的 MCP 或自动学习工具。任务 overlay 关闭 autolearn 和 memory backend；服务自带 `policy.mjs` 显式加载并完成握手，每轮启用登记的 Work 工具，执行前阻止其他工具和模型自行替换 goal 预算。恢复 goal 时必须重新启用已登记工具，不能只过滤当时的活动集合。

`capabilities.py` 提供受控搜索、公共 skill 读取、Stele 读取白名单、隔离命令和成员 Git 查看。不是启用原生通用 bash 后靠提示约束；公共 home 不挂载给命令，固定验收文件与 Work 身份文件只读。`evolution.py` 管理快照、worker、采纳日志与回退，`evo_worker.py` 在独立 venv 中实际调用 AntOmniEvo `Optimizer`、`ParetoFrontierEvolutionAlgorithm` 和 `LocalCandidateStore`；`OmpProposer` 用原生 RPC/goal 和目标文件白名单生成变更，`WorkSystem` / `WorkEvaluator` 运行冻结检查并映射归一化分数。并发候选数为 1，训练反馈送入 proposer，留出结果只用于评估/选择和用户展示。留出集参与多轮选择，不等于完全未触及的最终泛化测试集。

离线回归：`node --require ./test/setup.cjs --test test/work-runner.test.cjs`；WSL 中运行 `python3 test/work_runner_test.py -v` 和 `python3 test/work_evolution_test.py -v`。Python 测试需要 bwrap，使用临时文件和假 RPC，不访问真实 Work、不调用模型。真实模型、Ant 优化器、Electron 采纳/回退及服务 SIGKILL 验收使用独立临时 Work、服务单元和客户端 profile，不进入默认测试。

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
| `python -m unittest discover -s test -p work_inventory_test.py` | 临时 Git 仓库中的工作区诊断测试 |
| `npm run test:pet:animation` | 动画状态、帧尺寸与设置回归 |
| `npm run test:pet:layout` | 桌宠布局回归 |
| `npm run screenshots` | 用生产 renderer 与合成数据重建 `docs/screenshots/` |
| `npm run pet:preview` | 交互查看像素动画素材 |
| `npm run icons:build` | 从保留的设计稿重新生成应用图标 |
| `npm run dev` | 浏览器 UI 开发预览，不连接真实 OMP/WSL |

桌面测试需要可运行 Electron 的 Windows 会话。默认测试使用独立临时 profile，不接触运行中的用户客户端；截图脚本不加载生产 preload，也不调用模型或 WSL。

测试报告应区分 **逻辑单测**、**合成协议驱动的真实 UI** 和 **真实模型/WSL 实测**。后者需要明确选择独立测试 work 与 profile，确认模型费用和写入范围，不能拿截图 fixture 当作成功证据。

历史本机验收日志、旧截图和迁移脚本保持在本地忽略目录，不作为项目依赖。`runtime.local.json` 变化需要重启测试进程；不要为了加载 UI 变更而中断正在运行的真实会话。

## 知识库验收流程

`npm run preview:knowledge` 用独立临时 profile 打开正式渲染器，读取当前本地 Stele 的真实图谱；该预览的主进程拒绝写入、模型生成和恢复操作，不连接 OMP。日常完整功能使用 `npm start`。

`npm run test:knowledge:native` 对预留端口 `19015` 的隔离 Stele 执行真实 API 和桌面操作验收。先在 WSL 的仓库目录执行 `python3 tools/knowledge-fixture.py`；可用 `LUCYNA_STELE_BINARY` 指定已有 Stele 二进制。夹具生成独立 HOME/数据目录和 Markdown 文档，关闭会话索引与公开分享，本地 `19017` 协议夹具提供模型响应。它验证文档强版本冲突、证据定位、图谱、资料捕获/采纳、复核转待办、报告、设置和恢复包，不测量真实模型质量或消耗真实模型额度。结果、截图和恢复包保留在忽略目录 `.runtime/knowledge-native/`。

知识接口的默认离线测试见 `test/knowledge-reader.test.cjs` 与 `test/knowledge-service.test.cjs`。新增或修改 API 操作应保持固定路由映射、范围/版本检查和明确的失败状态。
