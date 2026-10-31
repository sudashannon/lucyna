# SSH host 开发与验收记录

更新：2026-10-31。已完成 Linux x86_64 开发切片：SSH 上传 frozen host、无系统 Python 安装，以及由远端服务持有的 OMP 会话和断线接回。正式设置、main/preload IPC、远端普通会话和受管历史现已接通，两个独立 Electron 进程走通创建与恢复。远端工作区暂为指定目录与 SESSION.md；完整 Work/文件/终端/附件文件功能及发行平台矩阵仍未完成。

组件取舍沿用 [开源复用评估](ssh-host-reuse-review.md)：系统 OpenSSH、systemd 用户服务、PyInstaller onedir，以及现有 OMP FrameDecoder。没有引入新的 agent loop 或通用远程执行框架。

## 实现与 review 结论

| 部分 | 已实现 | 仍受限的部分 |
| --- | --- | --- |
| 安装 | 固定版本/哈希构建依赖，桌面预构建制品，POSIX shell 上传校验，私有暂存、manifest 校验、自检、原子发布、身份复用 | 目前只实际构建/验收 x86_64，glibc 下限 2.35；发行许可证清单与第二架构未完成 |
| 运行时 | frozen launcher；恢复外部进程动态库环境；远端无需 Python、pip 或公网 | Linux 基础工具、glibc/libz 等系统库仍需存在，不是静态二进制 |
| 用户服务 | 独立 SSH 健康握手，核对安装 UUID/release，重复连接复用同一 daemon | 不自动修改 linger；persistenceVerified=false，未验证最后登录退出或冷启动 |
| 会话 | 服务持有 OMP stdin/stdout，原生 rpc-ui 协商/分块，SQLite 会话和操作状态，原生 ID/journal 检查 | OMP 必须在远端已有安装；不复制桌面模型凭证 |
| 重连 | 安装身份 + generation + PID/启动身份记录，事件游标回放、问题快照、控制者 epoch、显式 takeover | 桌面自动重连最多五次后提供手动重试；重开保持原 PID/ID、选择和草稿；takeover 仅后端 API，界面不隐式抢占其他客户端 |
| 未确认操作 | 写入 SQLite 后才发送；相同 operationId 不重复执行；查询 succeeded/failed/uncertain | succeeded 只代表原生 RPC 确认，不代表模型任务完成；不保存响应全文用于重发 |
| 正式界面 | SSH 配置、安装状态、取消/错误重试、主机来源、断开/结束、提问、未确认发送核对；hostId + root 隔离草稿/历史 | 仅展示受管历史；远端终端、文件浏览、附件落盘和 Work Runner/Stele 安装未接入 |
| 更新 | 不同 release 先暂存，再返回 update_pending，保留 active | 自动排空、切换和失败回滚尚未开放；重复部署仍会上传归档 |

本次桌面联调修复了 Windows 短暂文件锁导致的 registry 原子替换失败、手动重连后恢复意图未保存、取消启动后迟到创建，以及同一 journal 多个进程代次的历史重复。界面独立复核提出的重复错误提示已修正，复核结论为该项 resolved / ship；截图覆盖 Blue 浅色的桌面和 960px 窄窗，其余主题未重新视觉验收。设计文档核对沿用现有主题与组件，没有改写已有设计文件。

一个实际验收发现已修复：Linux PDEATHSIG 跟随创建进程的线程，从短生命周期 SSH handler 启动 OMP 会使断线误杀 OMP。现在由服务内常驻线程启动 OMP；连接线程退出不影响它，服务进程被 SIGKILL 后 OMP 则退出。服务重启把会话标记 interrupted、未确认操作标记 uncertain，不自动拉起 OMP 或重发 prompt。

回放缓存最多 32 MiB / 16384 个物理帧，复用原生 64 MiB 逻辑帧解码器。游标只在完整逻辑帧后提交；越过缓存边界时返回 resync_required，由适配器读取原生状态/分页历史并重建问题快照。超过缓存的整组分块需要实时消费，不承诺离线完整保留。

新建 journal 位于该 host 的私有 state/journals/<受管会话 ID>。显式 resume 必须提供真实远端路径和 expectedNativeId，同时核对 journal 头的 cwd；不通过标题猜测，也不隐式 fork。远端登录环境仅用于启动远端 OMP，不经 RPC 返回。

## 代码入口

- `src/hosts/ssh-frozen.cjs`、`tools/ssh-host.cjs`：预检、上传、安装、独立握手。默认 frozen 用户服务；`--source` 是保留的开发用系统 Python 路径。
- `tools/build-host-frozen.py`、`tools/lucyna-host/requirements-build.txt`：锁定构建环境和 onedir 制品；`artifacts.py` 校验普通文件、合法包内符号链接和完整内容摘要。
- `tools/lucyna-host/bootstrap.sh`、`install.py`、`host_runtime.py`：无需 Python 的入口、安装事务、source/frozen 启动及外部环境恢复。
- `tools/lucyna-host/host.py`、`sessions.py`：私有 Unix socket 服务、OMP 生命周期、SQLite、回放和控制权；复用 `tools/work-runner/protocol.py` 的通用协议部分。
- `src/hosts/registry.cjs`、`desktop.cjs`：原子持久化 profile/会话、发送前保存 operationId、有限重连、退出 detach；生产 `main.cjs`/`preload.cjs` 使用受信窗口的固定 IPC。
- `src/renderer/components/HostSettings.tsx`、`workbench-store.ts`、`work-identity.ts`：配置与安装、主机隔离、历史恢复和待确认发送；复用 Cindy 与现有原生 OMP 投影。
- `src/hosts/connection.cjs`、`remote-session.cjs`：长连接 SSH bridge，start/attach/request/respond/messages/resync/stop；detach 只断开观察，stop 明确结束远端进程。

## 构建与开发用部署

在目标 Linux 架构上准备构建环境，构建端需要 Python 和构建依赖；目标主机不需要：

```sh
python3 -m venv .runtime/host-build
.runtime/host-build/bin/pip install --require-hashes -r tools/lucyna-host/requirements-build.txt
.runtime/host-build/bin/python tools/build-host-frozen.py --output resources/remote-host
```

当前实测构建环境是 Ubuntu 22.04 x86_64 / Python 3.10.12 / PyInstaller 6.22.3。相同源码和环境独立构建两次，release 与 tar.gz SHA-256 一致；这不等于已锁定跨构建机的系统库。

SSH 配置示例（地址由使用者填写，示例不是测试目标）：

```json
{
  "destination": "my-linux-host",
  "executor": {"kind": "windows-openssh"}
}
```

```sh
node tools/ssh-host.cjs <本地主机配置.json> --bundle=resources/remote-host/index.json
```

默认要求可用的 systemd 用户服务。没有用户服务时，可显式 `--connection` 验证安装/握手；该模式不支持持久 OMP 会话。WSL SSH 使用 executor.kind=wsl-openssh 并填写 distro/user，路径由所选执行器解释。`--prefix=/绝对/隔离路径` 用于独立验收目录。

不指定 `--bundle` 时读取 `resources/remote-host/index.json`。生成包未提交 Git，也尚未接入桌面发行打包；正式界面使用该固定资源位置；开发阶段先构建到此目录，CLI 可显式覆盖索引。

## 2026-10-31 实测

| 验收 | 结果与证据范围 |
| --- | --- |
| Node 默认全套 | 227 项，226 通过、1 跳过、0 失败；含 SSH/制品/旧连接迟到响应回归 |
| Python 安装器/协议 | 9 项通过：安装/复用、并发、损坏包、路径/链接、内容漂移、保留 active、bridge EOF、中文回放的 UTF-8 帧大小 |
| Python 会话 | 9 项通过：远端工作目录与 SESSION.md 链接边界、幂等、分块/问题、控制者/generation、游标过期、原地 resume、连接线程退出、实际 SIGKILL 后中断恢复 |
| 干净无 Python / 无公网目标 | 真实 SSH ForceCommand 进入 bwrap rootfs；没有系统 Python/stdlib，独立网络命名空间、只读根；frozen connection 安装和再次连接成功，截断/损坏上传失败后重试成功 |
| systemd 用户服务 | 独立 loopback sshd，经 Windows Node → WSL OpenSSH；frozen 首装与复用成功，UUID、daemon PID 不变；与上面的无 Python rootfs 分开验收 |
| 假 OMP | 1.2 MiB 原生分块、断线期间事件回放、prompt 已送达但确认丢失、相同 operationId 不再发送、完整快照重建均通过 |
| 正式桌面完整流程 | 生产 main/preload/renderer + 临时 OpenSSH + frozen 用户服务；首次设置安装，OMP 路径错误后编辑重试，消息和界面提问答复，自动与手动重连，丢确认核对，无重复 prompt/消息气泡；第二 Electron 进程接回假/真 OMP 原 PID，草稿/选择保留；结束后从历史原地续聊，原生 ID/journal 不变、历史列表无重复 |
| 本机桌面回归 | 两个工作区三条连接完整退出/重开，手动结束保持空闲，文本/图片/长文本草稿与未读保留，不重放 prompt |
| 真实 OMP 18.13.3 | 隔离 Work/agentDir，无模型调用；强制杀 SSH 传输后 attach，核对同一 PID、同一原生 ID，get_state 与分页历史/resync 成功 |

制品 release：`592319da36a45e384e250d56ba9c63c487dcdeed0726ec8ee928a0bb57838728`；归档 7,865,658 字节；SHA-256：`d2569cf1c51ec13aab5a128c5f95381a7d8456d525acfaecb69feb456a3097b1`。索引记录 Python、PyInstaller 和构建依赖版本。

早期后端证据在忽略的 `.runtime/ssh-host-frozen/`；本次正式桌面证据为 `.runtime/ssh-desktop/result.json` 与对应时间戳目录内的 create/restore 结果和截图，无 Python 回归为 `.runtime/ssh-ui-sealed.json`，全套测试为 `.runtime/ssh-ui-unit.log`。界面截图副本位于 `.impeccable/review/ssh/`。验收已清理临时 sshd、测试 unit、密钥及目录；没有重启日常 Lucyna/OMP 会话。

复现（Python 命令在 Linux/WSL 执行；Node 路径由环境提供）：

```sh
node --require ./test/setup.cjs --test test/*.test.cjs
python3 test/ssh_host_test.py -v
python3 test/ssh_sessions_test.py -v
python3 test/ssh_host_native.py --node <Windows-node.exe的WSL路径> --bundle resources/remote-host/index.json --sealed --report .runtime/ssh-host-frozen/sealed.json
python3 test/ssh_host_native.py --node <Windows-node.exe的WSL路径> --bundle resources/remote-host/index.json --sessions --omp <远端OMP绝对路径> --report .runtime/ssh-host-frozen/sessions.json
python3 test/ssh_host_native.py --node <Windows-node.exe的WSL路径> --bundle resources/remote-host/index.json --desktop --omp <远端OMP绝对路径> --report .runtime/ssh-desktop/result.json
```

native 验收需要 sshd/ssh-keygen，sealed 还需要 bwrap 和可用的非特权命名空间；用户服务验收需要 systemd --user。测试临时 SSH 授权目录位于用户 home，保持 StrictModes。

上述隔离夹具中的消息/提问使用确定性假 OMP；真实模型补充实测见下一节。仍未验证跨实体主机、aarch64、真实网络黑洞/睡眠、最后登录退出、冷启动及真实 TUI 同 journal 锁冲突。Work helper 无 Python 运行以及远端文件/附件/终端仍是后续阶段。

## 现有 WSL SSH 入口与真实模型补测

2026-10-31 按用户要求使用现有 SSH 服务实测。路径为 Windows 原生 OpenSSH → `10.0.28.197:2222` 的现有 Windows portproxy → Ubuntu-22.04 系统 sshd。服务端 x86_64/glibc 2.35，OMP 18.13.3。没有新建 sshd 或修改端口转发；目标 ED25519 主机公钥与已信任的 WSL 本地入口核对，独立测试 SSH 配置保持 StrictHostKeyChecking=yes。

生产 main/preload/renderer 配合独立 userData、远端目录与 host 用户服务，走通设置保存、自动上传安装、OMP 路径错误后编辑重试、消息与提问、手动断开再连、丢确认核对、两个 Electron 进程退出/重开及已结束历史原地续聊。`test/ssh-host-desktop.cjs` 现在也接受 Windows OpenSSH 和显式 `realPrompt`/`realAgentDir`，默认隔离验收仍不调用模型。

真实模型使用远端既有 `/home/shanl/.omp/agent` 配置中的 `mondo/deepseek-flash`，仅提交一条“不使用工具，只回复 LUCYNA_SSH_LIVE_OK”的测试消息。确认原生状态仍在生成时强制关闭此会话的 SSH 传输，自动接回后模型正常完成，返回 `LUCYNA_SSH_LIVE_OK`。PID `2130045`、原生会话 ID `01a192a9-ac75-72ff-b377-986660b3b461` 保持一致；客户端完整退出再启动后仍接回该进程，journal 仅有一条用户消息，无任务重放。

结果与截图：`.runtime/ssh-wsl-live/1793461934667/result.json`、`create-result.json`、`restore-result.json`、`real-model.png`、`real-reconnecting.png`。测试结束后停止并移除了两个独立测试 unit，保留验收 journal 和截图；原有 17 个 `omp` 进程全部仍在，未重启日常 Lucyna/OMP 或 WSL。首次测试隔离目录过长被 Unix socket 长度校验拒绝，缩短测试 prefix 后通过；生产安装路径未因此更改。
