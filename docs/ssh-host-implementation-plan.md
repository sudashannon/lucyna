# SSH host 开发计划

更新：2026-10-31。状态：M1 Linux x86_64 无 Python 自动安装、M0 SSH registry/受限 IPC、M2 桌面会话、M4 正式设置与断线/重开流程已接通。M3 当前只包含配置目录、SESSION.md、受管历史与来源隔离；文件/终端/附件落盘、完整 Work 管理、自动升级回滚及发布矩阵仍未完成。审查与验证见 [review 记录](ssh-host-review.md)，产品契约见 [自动部署设计](ssh-host-design.md)。下列阶段保留完整目标，不代表其中每项均已实现。

## 交付原则

先完成自动安装垂直链，再接远端普通会话与工作台。mock SSH 不代替 OpenSSH 验收，回环 SSH 不代替跨主机/架构验收。没有目标地址时先完成代码、打包和隔离夹具，不从个人 SSH config 任意选择真实机器部署。

优先复用成熟组件；选型依据与实验见 [开源复用评估](ssh-host-reuse-review.md)。OpenSSH/systemd 保持现有方案。PyInstaller `onedir` 已通过部署适配和干净目标验收，`python-build-standalone` 为备选；不扩写通用 remoting 框架。

## M0：Host 身份与适配边界

目标：消除只靠 runtime/root/文件路径区分来源的假设，保持现有本机行为。

拟新增：

- `src/hosts/registry.cjs`：HostProfile schema、原子配置持久化、profile/安装身份绑定。
- `src/hosts/locator.cjs`：WorkLocator/SessionLocator、路径规则和稳定索引。
- `src/hosts/local.cjs`、`src/hosts/wsl.cjs`：包装现有查询/执行，不迁移当前进程。
- `src/hosts/protocol.cjs`：host v1 schema、capability、operation、事件与错误码。

改造 `src/renderer/types.ts`、`src/renderer/api.ts`、`src/preload.cjs` 与 `src/main.cjs`：受限 IPC 接收 locator，旧参数只映射到明确的 legacy host。会话所有权、renderer Work 缓存、历史、标题与恢复意图增加 host；保留已有草稿 key/附件引用，版本化迁移先备份。

验收：跨主机同 root/journalPath 无碰撞，Linux 大小写区分，旧数据可迁移/回退，Windows/WSL 定向回归通过。

## M1：SSH 与自动安装闭环

目标：SSH 配置可用后自动上传运行 host，远端不必预装 host/Python。

拟新增：

- `src/hosts/ssh-executor.cjs`：Windows/WSL OpenSSH 执行器、固定命令、POSIX 参数编码、取消/超时/有界诊断。
- `src/hosts/ssh-bootstrap.cjs`：探测、平台选择、上传进度和幂等部署状态机。
- `tools/lucyna-host/bootstrap.sh`：无需 Python 的探测与私有暂存入口。
- `tools/lucyna-host/install.py`：目录/manifest 校验、安装锁、unit、升级/回滚。
- `tools/lucyna-host/host.py`、`daemon.py`、`bridge.py`：用户服务、全双工 stdio ↔ Unix socket、hello/ping。
- `tools/build-host-bundle.cjs`：host 摘要、frozen 构建或便携 Python 锁文件、平台/许可证、可复现打包。

已完成 frozen launcher、manifest、无需 Python 的 bootstrap、合法包内符号链接、外部 OMP 动态库环境恢复及哈希锁文件。x86_64/glibc 2.35 构建在无系统 Python/无公网隔离目标通过 SSH 首装、复用、截断/损坏上传后重试；同环境两次构建摘要一致。默认 CLI 使用 frozen 制品，源码模式显式选择。随包目录为 `resources/remote-host/`，开发验收使用 `--bundle` 指向忽略目录中的索引。仍需完成发行打包、第二架构、许可证清单、上传去重和完整升级/回滚，不能将当前平台切片等同完整 M1/M5 发布门槛。

先在临时用户目录测安装器，再用隔离 sshd 验证真实 OpenSSH。覆盖认证/host key、shell 噪声、特殊路径、上传中断、只读/磁盘不足、摘要错误、非受管同名 unit、多桌面并发、远端无 Python/无公网。服务健康必须核对真实 hello 的安装身份与 active release。

## M2：远端会话与断线重连

目标：新建/原地续聊、流式输出、提问、停止；断线后服务继续持有同一 OMP。

已实现：`sessions.py` 内的 SQLite 会话/操作账本、常驻线程进程所有权、native RPC 分块、回放/问题快照、generation/控制者 epoch；`connection.cjs` 与 `remote-session.cjs` 提供长连接及显式 attach/resync。假 OMP 验证丢确认不重复 prompt，真实 OMP 18.13.3 验证强制杀 SSH 后同 PID/原生 ID 接回与快照重建。实际 SIGKILL 测试验证服务重启不自动重放。现通过 hosts/desktop.cjs 在主进程受限 IPC 层路由，保留本机 SessionManager，renderer 共用原生会话投影。正式界面已验证自动重连、手动断开再连、未确认 prompt 核对与重开恢复；未用真实模型验收生成或 TUI 锁冲突。

拟新增：

- `tools/lucyna-host/sessions.py`、`storage.py`：进程身份、SQLite、操作状态、事件缓冲和控制 lease。
- `tools/lucyna-host/omp.py`：OMP v2、分块、请求关联、问题/快照；提取 `tools/work-runner/protocol.py` 的通用部分，不复制受限任务策略。
- `src/hosts/ssh.cjs`、`remote-session.cjs`：bridge 多路复用、连接恢复、现有 request/messages/respond 接口。

改造 backend 的进程/RPC 耦合、SessionManager 的 child/close 假设、退出清理和 renderer 重连状态。SSH child 退出不等于远端 OMP 退出。

先用假 OMP 覆盖多会话、分块、断线、丢响应、幂等/uncertain、旧问题/lease、游标过期、SIGKILL 与进程组回收。再使用隔离 Work/agentDir 测真实 OMP 状态与历史操作；模型验收只创建明确标记的新测试会话。原地 resume 必须核对 journal/原生 ID，运行中 TUI 只验证锁冲突。

## M3：远端工作台

目标：远端入口不落到本机 WSL，建立最小日常工作流。

- Work/详情：提取 `src/work-inventory.py`、`src/work-details.py` 的机器配置依赖，远端显式传参。
- 历史：远端列表、真实路径/cwd/agentDir 检查，区分受管会话与原生历史。
- `tools/lucyna-host/files.py`：根约束列表/预览/远端选择器，所有内容有界。
- 附件：分块、哈希、原子发布；准备和发送绑定同 session/generation。
- `tools/lucyna-host/terminal.py`：独立 PTY、尺寸与数据流，适配 xterm。
- 能力：Stele/Work Runner 缺失如实显示，不转发到桌面 localhost。

首版开放历史只读与原地续聊；SSH 历史删除/回收、跨主机复制/迁移暂不开放，不能把本地文件事务直接套到网络。现有本机功能保留。

验收跨主机同路径、链接越界、附件/长文本、断线草稿、UTF-8/resize、Work 根变更、原地写回，确认写入均在正确主机/目录。

## M4：正式界面整合

目标：通过正式界面走完 SSH 配置 → 自动部署 → 进入 Work → 退出/重开接回。

已新增 `src/renderer/components/HostSettings.tsx` 和主机连接状态模型，接入「运行与模型」组。界面实现前读取仓库设计 skill 与 Cindy/Hallmark 规范，复用现有组件和窄屏行为。

实现主机列表、SSH 执行器、Work/OMP 配置、安装进度、保活/待更新、来源标识、离线状态，以及「断开连接」/「结束远端进程」的区分。保存不重复确认部署。

renderer 不得提交任意 SSH 参数、shell 片段、下载地址或任意网络请求；只提交受限配置/操作。诊断不记录私钥内容、口令、模型密钥或环境变量。

使用独立 profile 与真实构建验收新增/编辑/取消/重试/重开、长名称/窄屏、离线/OMP 缺失/Work 无效、待更新、多主机会话与草稿。协议夹具与真实 SSH 桌面验收分开记录。

当前桌面验收使用生产 main/preload/renderer，临时 loopback sshd、独立 userData/agentDir；覆盖缺少 OMP 后编辑重试、同路径不同主机、完整消息/提问、SSH 强断、手动断开再连、丢确认与两个独立 Electron 进程恢复。安装器无 Python rootfs 验收单独进行，不能将两者说成同一测试环境。

## M5：发行与集成门槛

1. 锁定并验证两种 Linux 架构运行时、glibc 下限、许可证、包体积；标明原生/仿真目标。
2. 无公网/无 Python 的干净目标自动安装；按固定制品策略复用完整安装，不重复上传未变化的包。frozen 路线同时验证 Work helper 不依赖系统 Python。
3. 真实跨主机断网、桌面退出/强退/睡眠、最后 SSH 登录退出，核对进程启动身份与 journal 不重复。
4. 活跃/空闲 OMP 或终端存在时只暂存更新；零进程升级、候选失败回滚和并发连接无竞态。
5. 默认 Node、Python host、TypeScript、renderer build 和相关桌面回归；隔离 profile 完整真实 SSH 用户流程通过。
6. 更新架构、入门、功能、开发文档；没有证据的 WSL 冷启动/第二架构不列为已验证。

交付记录包含源码 revision、桌面构建、host release、协议/schema、运行时锁文件、目标和结果。证据放在忽略的 `.runtime/ssh-host-*`，不复制个人 SSH 配置或凭证。

## 第一个切片

从 M0 → M1 开始，先交付「SSH 配置 → 自动上传安装 → hello/ping → 再次连接复用」，不接管用户真实会话。M2–M4 完成后再宣称日常远程 OMP 可用，M5 完成后再宣称发布平台的自动部署与保活已验收。
