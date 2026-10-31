# SSH host 开源复用评估

日期：2026-10-30。范围：在继续扩展 host 前，检查现成组件能否承担 SSH 自动部署、进程托管、原生 OMP RPC 和重连。结论是复用成熟基础组件，保留一个只负责 Lucyna/OMP 语义的薄 host；本次检查的框架中，没有找到可直接替换整条链、同时满足这些约束的成熟方案。

## 采用方向

| 层次 | 选择 | Lucyna 仍需负责 |
| --- | --- | --- |
| SSH 连接、配置、密钥、跳板机 | 系统 OpenSSH，继续使用现有执行器 | 配置界面、状态、取消、有限诊断 |
| Linux 服务生命周期 | systemd 用户服务 | 自己的 unit、健康握手、更新协调；不能把 service active 当作最后登录退出后的保活证据 |
| 无 Python 主机的运行时 | 优先验证 PyInstaller `onedir` 预构建包；`python-build-standalone` 保留为备选 | 平台制品、摘要、发布、私有安装目录；不在目标机编译或 pip install |
| OMP 引擎与消息协议 | 原生 OMP `rpc-ui` 和现有 FrameDecoder / Python protocol 代码 | 会话身份、断开/结束区分、恢复游标、控制权、未确认操作 |
| 数据与 Work | 现有 Work 查询、journal 和附件逻辑 | host-aware locator 和远端路径边界，不引入文件同步 |

2026-10-31 更新：PyInstaller onedir 已接入部署器，x86_64 无系统 Python/无公网 SSH 安装与 OMP 断线接回已通过实测，记录见 [开发验收](ssh-host-review.md)。下面保留 10-30 的选型依据与早期可行性实验；完整发布矩阵仍未完成。

## 候选与取舍

### OpenSSH 与 ssh2

[OpenSSH](https://www.openssh.org/manual.html) 已提供 SSH 配置、agent、SFTP 和转发。继续调用系统 SSH 可以沿用用户已配置的连接，这与「SSH 配好即用」一致。[Zed 的远程开发](https://zed.dev/docs/remote-development)和 [Mutagen 的 SSH transport](https://mutagen.io/documentation/transports/ssh/)也采用本地 OpenSSH 启动远端组件。

[ssh2](https://github.com/mscdex/ssh2/blob/master/README.md) 是长期维护的 MIT Node 库，提供 exec、SFTP、PTY、转发和 agent，适合需要在 Node 内直接管理 SSH channel 的产品。但它的连接 API 以显式参数为主；改用它需要额外处理 OpenSSH config、known_hosts 和跳板机行为。当前执行器已满足需求，增加 ssh2 不会顺带解决远端 OMP 所有权、安装或重连恢复。暂不新增此依赖；将来若需要独立 SFTP 通道，再做有明确收益的验证。

### Distant：功能最接近，但不作为默认底座

[Distant](https://github.com/chipsenkbeil/distant/blob/v0.20.0/README.md) 提供远端文件与进程 API、JSON 接口、SSH 启动 server，采用 MIT/Apache-2.0 双许可。它能省掉一部分通用文件、PTY 和进程协议代码。

本次 GitHub `releases/latest` 返回 [v0.20.0，发布于 2023-07-15](https://github.com/chipsenkbeil/distant/releases/tag/v0.20.0)；最新主分支仍明确标注 Alpha，且与发布版的 SSH 后端/模块已有差异。因此不能将主分支功能当作现成稳定制品。

发布版 [SSH launch](https://github.com/chipsenkbeil/distant/blob/v0.20.0/distant-ssh2/src/lib.rs) 会执行远端 distant 二进制，不构成缺失时自动上传安装的完整方案。[进程协议](https://github.com/chipsenkbeil/distant/blob/v0.20.0/distant-protocol/src/request.rs)提供 spawn/kill/stdin/resize，但没有 Lucyna 所需的命名 OMP 会话接管、操作确认和 journal 约束。网络库有重连代码，这不能直接证明桌面进程重启后可重新接管旧 OMP；[输出实现](https://github.com/chipsenkbeil/distant/blob/v0.20.0/distant-local/src/api/state/process/instance.rs)仍绑定启动时的 reply。

判断：可以做替代 transport 的实验，但默认采用会同时增加 Rust sidecar、另一套协议与发布维护工作，尚无足够收益。

### Herdr / Collie：适合终端会话，不能直接替换原生 RPC

[Herdr v0.9.5](https://github.com/herdrdev/herdr/releases/tag/v0.9.5) 有跨平台二进制、后台进程、SSH 安装/attach、detach/reattach 和 socket API；当前上游是 `herdrdev/herdr`，采用 Apache-2.0。它有实际可复用的会话托管能力，值得在远端终端功能中保留适配空间。

但其 [socket API](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx) 的主要表面是 pane、按键、屏幕、agent 状态。它的 [OMP 集成](https://github.com/herdrdev/herdr/blob/v0.9.5/src/integration/assets/omp/herdr-agent-state.ts)上报状态与 session 引用，并未提供完整的 OMP `rpc-ui` 代理。[远端文档](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/persistence-remote.mdx)还说明非交互缺少兼容二进制时不会自行修改主机，因此不能直接拿 `herdr --remote` 当作 Lucyna 的无人值守安装 API。

[Collie](https://github.com/AltanS/collie) 是 MIT 的完整移动 Web 产品，其 [Herdr adapter](https://github.com/AltanS/collie/blob/06551ea82fc42125a6b4b960b61fb77665e16db8/bridge/mux/herdr/adapter.ts)主要调用读取屏幕、输入文本和发送按键。把它作为 Lucyna 主通道，会改变当前结构化消息、工具卡片、问题回答与模型控制的实现方式；引入整套 Web 服务也超出需要。

判断：后续可作为可选「已有终端」接入；不作为普通 OMP 会话的必需依赖，也不操作用户已有 Herdr/Collie 服务。

### Zed、Mutagen、Tern 与 OMP Collab

| 候选 | 可借鉴/复用 | 本次决定 |
| --- | --- | --- |
| Zed Remote | SSH 后自动部署、无公网时本地上传、版本协调 | 借鉴架构。其 [remote](https://github.com/zed-industries/zed/blob/main/crates/remote/Cargo.toml) / [remote_server](https://github.com/zed-industries/zed/blob/main/crates/remote_server/Cargo.toml) 是 GPL-3.0-or-later，并依赖大量 Zed 内部 crate，不是独立远程执行 SDK |
| Mutagen | 自动上传 agent、OpenSSH stdio 通信、断线恢复 | 用作安装链设计参考，暂不引入同步/转发产品。其 [LICENSE](https://github.com/mutagen-io/mutagen/blob/master/LICENSE) 明确 v0.17 起官方构建默认含 SSPL 代码；不能笼统称全部官方二进制为 MIT |
| 本机 Stencil Tern | daemon、远端会话、QUIC | [官方页面](https://stencil.so/tern)标注 closed beta；本次未找到可采用的开源远端 SDK/许可。不要混同 GitHub 上另一款 `your-moon/tern` SSH 客户端 |
| OMP Collab | 已有结构化直播、访客 prompt/interrupt、浏览器 client | [18.13.3 文档](https://github.com/can1357/oh-my-pi/blob/v18.13.3/docs/collab.md)中 model/compact/resume 等仍为 host-only，生产 relay 未发布供自托管。适合单独的协作入口，不替代 SSH Work 与完整 RPC |

## PyInstaller 实验

[PyInstaller](https://pyinstaller.org/en/stable/operating-mode.html)能把解释器和模块打包为自包含目录/程序，目标用户无需安装 Python；构建应分别针对目标平台进行。使用其标准打包工具，无需维护自己的解释器裁剪器。其 [license exception](https://pyinstaller.org/en/stable/license.html)允许分发打包应用，应用依赖的许可仍需分别记录。

本次在 WSL Ubuntu 22.04 / x86_64 / glibc 2.35 中，以独立临时 venv 安装固定 `PyInstaller==6.22.3`，打包现有 `host.py` 和实验 manifest 为 `onedir`。未修改系统 Python、现有 host 服务或用户 OMP 会话。

- 目录文件大小合计 15,674,240 字节，约 14.95 MiB，包含 `libpython3.10.so.1.0`。
- 运行时令 `PATH` 为空、`PYTHONHOME/PYTHONPATH` 指向不存在目录：self-test 和 stdio hello 成功。
- 打包 daemon + bridge 两次连接返回同一 PID，bridge 退出后仍可再次握手。
- `ompSessionsSupported=false`，没有调用模型或打开用户 journal。
- 临时构建/依赖/daemon 已清理。实验脚本、日志和结果保存在忽略目录 `.runtime/ssh-host-reuse/`。

这是打包可行性证据，不是「干净无 Python 主机」或 SSH 安装验收：系统动态库仍然存在，仅测了一个架构，也未接入安装器。15.67 MB 是本次目录统计，不是正式压缩下载包大小。

正式采用前必须解决：

1. 将安装器中 `sys.executable -I host.py` 的假设改成明确的 runtime launcher；frozen executable 不是通用 Python 解释器。Work/详情 helper 也须纳入 host 内部模块/子命令，否则未来仍会要求系统 Python。
2. 从桌面上传预构建包，bootstrap 不能继续依赖远端 Python。支持离线校验、暂存、原子发布和已有版本复用。
3. 确定 manifest 在 frozen 包内的位置与 release 摘要规则；不能让打包 manifest 与安装器给出的 release 不一致。
4. 按 [官方注意事项](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html)保留包内合法符号链接，校验解包目标，拒绝越界链接；不能直接放宽现有安装器的路径保护。
5. 启动外部 OMP/工具前为子进程恢复 `LD_LIBRARY_PATH_ORIG` 或清除打包器注入路径，避免污染原生工具动态库。保持 host 自身运行环境。
6. 验证最低 glibc、Linux aarch64、无 Python/无公网目标、真实 SSH 和真实 OMP；锁定构建依赖与许可证清单。

优先 `onedir`，避免每次启动 bridge 都进行 onefile 解压；预构建包可随桌面分发。若 frozen 路线的子进程兼容成本不合适，沿用 [uv 所使用的 python-build-standalone](https://docs.astral.sh/uv/concepts/python-versions/#cpython-distributions)精确制品，在 Lucyna 私有目录运行；不自编译 CPython，也不要求远端联网运行 uv。

## 对开发顺序的影响

保留已实现的 OpenSSH、安装事务和 hello 切片。M1 下一步优先完成成熟打包工具的发行适配及干净目标验收，再推进 M2 的 OMP 会话所有权。新增自写代码限于产品特有的安装身份、原生 RPC 会话和恢复语义；不扩展成通用远程 IDE/同步框架。
