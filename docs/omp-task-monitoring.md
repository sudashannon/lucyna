# OMP 子代理与后台任务

会话中的原生 `task` 调用下显示运行中的子代理卡片；尚未载入父调用、没有父调用的后台命令和服务显示在会话任务区。卡片展示真实状态、总历时、当前动作、命令与最近输出，展开后读取子代理记录或后台输出。已结束任务折叠保留。普通 Bash 调用在运行期间展示命令和输出，结束后恢复紧凑工具行。

“停止”只针对所选实例。子代理取消会等待 OMP 的 release/abort 返回；后台命令接收取消后继续显示“正在停止”，直到执行体结束。后台服务按 broker 的实例 ID 停止。仅接到请求、连接断开、任务从快照消失都不等于已经退出。断线时禁止发起停止，重连后重新订阅并读取快照；不重放未确认的取消。

运行总历时单独列出等待用户确认的时长。该统计从本版观察到的问题事件开始，不对旧会话的 500 分钟记录反推执行时间，也不是 CPU 用时。

## 协议与状态

- 每个 `Conversation` 拥有独立 `SessionTasks`。子代理事件不会进入主会话消息 reducer。
- 原生接口：`set_subagent_subscription(progress)`、`get_subagents`、`get_subagent_messages`、`cancel_subagent`。取消携带预期 sessionFile/parentToolCallId，适配运行时在执行前原子核对身份；记录读取也核对预期 sessionFile。
- 本地适配新增 `get_background_tasks`、`get_background_task_output`、`cancel_background_task`。查询限定于本会话的任务树或其拥有的 launch 服务，不调用消费结果、等待交付或确认消息的接口。没有 broker 时只返回空服务集合，不启动 broker。
- 任务列表每 2.5 秒对账；子代理进度由事件立即更新。较早的异步快照不能覆盖已接到的终态。断线或失去记录的任务显示“状态待确认”。
- 输出保留最近 64 KiB 字符，折叠后台命令预览来自原生 4 KiB 尾部；子代理记录按不超过 1 MiB 的 JSONL 页面增量读取。单条超大记录返回明确错误，不无限加载。
- 客户端保留最多 80 条结束摘要；持久化输出每条最多 2 KiB。重启后旧活动摘要先标为未知，再由原生快照校准。原生 JSONL 历史中的 async-result 补充已完成后台任务。
- SSH 观察请求走无写入恢复记录的 `observation-*` 响应；取消仍使用持久 operation ID 和不确定结果处理，避免长时间轮询耗尽操作表。

## 安装适配运行时

`tools/omp-runtime` 包含 OMP v18.15.0 的小型源码补丁和独立 RPC 模块，固定上游提交 `3fedf8d53267e32a6d7521ce725fdcc4a36fdc67`。构建依赖 Bun 1.4.4 和同版 Linux x64 native addons，下载有校验值；不会覆盖系统 OMP。

在 Linux x64/WSL 上运行：

```sh
python3 tools/omp-runtime/install.py
```

默认安装到 `~/.local/share/lucyna/omp/18.15.0-tasks1/omp`。在 Lucyna 的 WSL 程序路径中选择该路径，重新启动客户端后新建或恢复会话。已经启动的原生进程继续使用原来的版本。回退时恢复原来的 WSL OMP 路径即可，历史格式不变。

本机本次安装已保存 `client-settings.json.before-task-monitoring.bak`，并将 WSL 路径切到上述独立运行时。应用数据目录由 `resolveDataRoot` 解析 Windows 虚拟化后的真实位置。

SSH 与 Windows 请求通道已接通，但远端主机必须拥有相同的原生接口，才支持后台命令与服务监控。未升级的 OMP 会显示能力不足提示；旧 launch broker 未声明按实例停止能力时，对其服务禁用单独停止。当前安装脚本只构建 Linux x64。没有强制重启或升级已在运行的 SSH 原生会话。

## 验证

- `node --require ./test/setup.cjs --test test/session-tasks.test.cjs test/session-view.test.cjs test/workbench-store.test.cjs`
- `python3 test/ssh_sessions_test.py`（Linux/WSL）
- `node node_modules/electron/cli.js test/session-tasks-desktop.cjs`
- 原生 OMP `bun --bun run check:ts` 与子代理/后台任务/生成协议共 23 项测试。
- `python3 tools/omp-runtime/smoke.py <omp-path>` 验证编译后二进制的 RPC 能力、无任务快照、越权实例拒绝及随后请求仍能响应；不调用模型。

完整 `bun check` 的 Rust 分支在浅克隆中无法判断变更范围，并因环境未安装 Cargo 失败；本补丁没有 Rust 实现变更，已通过完整 TypeScript 包检查。生成的 Rust SDK 协议声明随 schema 更新，未执行 Cargo 编译。
