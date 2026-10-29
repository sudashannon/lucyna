# 快速开始

## 运行环境

当前目标平台是 **Windows 11 + WSL2**，开发验证使用 Ubuntu 22.04。需要 Windows Node.js 22.12+（建议 Node.js 24）、npm、Git，以及 WSL 内 Python 3.10+、Git 和可运行的 [OMP](https://github.com/can1357/oh-my-pi)。协议适配以 OMP 18.13.1 为基线；其他版本需要自行验证。Windows OMP 模式也需要 WSL，因为工作根、文件与终端仍由 WSL 承载。

先在 WSL 终端独立验证 OMP 的模型认证和一次普通对话。客户端不会随仓库分发认证信息、Work 技能或 Stele 服务。

## 安装

在 Windows PowerShell 中执行：

```powershell
git clone https://github.com/sudashannon/lucyna.git
cd lucyna
npm ci
Copy-Item runtime.example.json runtime.local.json
```

编辑 `runtime.local.json`，把 `user`、Linux 目录和 OMP 可执行文件路径替换为自己的真实值。`wsl.exe -l -v` 可查看发行版名称；在 WSL 中执行 `command -v omp` 查看 OMP 路径。该文件被 Git 忽略。

| 字段 | 含义 |
| --- | --- |
| `distro`, `user` | WSL 发行版和 Linux 用户 |
| `home`, `workRoot` | Linux 用户目录、包含各个 work 的父目录 |
| `wslExecutable` | WSL 内原生 OMP 的绝对路径 |
| `wslAgentDir` | 现有 OMP 配置目录，示例为 `~/.omp/agent` |
| `skillDirectory` | 现有技能目录，示例为 `~/.agents/skills` |
| `defaultRuntime` | 首次启动的默认运行时：`wsl` 或 `windows`；已保存的设置优先 |
| `installWorkIntegration` | 默认 `false`。开启时安装客户端管理的 Work/Stele MCP 配置及技能/命令适配；需先具备下文的依赖 |
| `windowsProviderHook` | 默认 `false`；仅供不随仓库分发的私有迁移适配使用，普通安装保持关闭 |

也可用环境变量 `LUCYNA_CONFIG` 指定替代配置文件。正常使用建议保持仓库根目录的 `runtime.local.json`，以便 Windows 与 WSL 脚本读取同一份配置。若指定替代文件，确保它在两侧都可访问。

```powershell
npm start
```

`npm start` 会先构建 UI。也可运行 `./Start-Workbench.ps1`。当前提供源码运行方式，尚未提供安装包、自动更新或代码签名发行版。

## 建立第一个 work

工作列表发现 `workRoot` 下带有 `SESSION.md` 或 `work.json` 的目录。普通 Git 仓库不会自动作为 work 导入。最小无 Git 示例见 [`examples/demo-work`](../examples/demo-work/)；可在 WSL 中复制到配置的 `workRoot` 下。

```text
~/work/
  demo-work/
    SESSION.md
    work.json
    notes/
```

多仓库 work 由已有 Work 技能维护 `work.json` 与 `repos/`。客户端检查登记、分支和目录，不自动切分支，也不擅自修订登记。分支偏差是黄色提示，历史、文件与终端仍可访问。

## 选择 OMP 运行时

左下角 **设置 → 运行环境** 可切换 WSL / Windows OMP、修改可执行文件和模型，并运行环境检查。

- **WSL OMP**：直接读取指定的原生 OMP 配置与技能；新会话由 OMP 根据 work cwd 选择原生 session 存储，客户端不把新会话迁到 Windows 历史库。
- **Windows OMP**：使用客户端独立的 agent 目录。按设置页面显示的数据目录，在原生 OMP 中配置该 profile 的模型和认证；不会自动合并个人 WSL 认证。
- 已运行的会话保留原来的运行时；新启动的会话使用新设置。

## Work + Stele（可选）

核心会话、文件和终端不要求 Stele 在线。知识库与记忆功能需要已有 Stele 服务。当前集成协议与默认地址为 **WSL loopback `http://127.0.0.1:18989/mcp`**，这不是通用的任意 MCP 服务配置页。

自动安装适配前，确认 `skillDirectory/worktree-session/scripts/worktree-work.py` 和原生 OMP 的 `commands/work-{start,continue,review,end}.md` 已存在，且 Stele 服务已配置。将 `installWorkIntegration` 设为 `true` 后，启动会添加受管理的桥接配置；安装/恢复逻辑会校验内容，避免覆盖手工修改。该功能不安装或启动 Stele，也不附带 Work 技能本体。

Work 保存当前任务、SESSION 与共享笔记；L3 长期知识交给 Stele，读取和受控写入通过 MCP 提供给 agent。知识库界面通过主进程的固定操作接口接入 Stele，包含检索、图谱、来源资料、候选/复核、待办、报告、问答和恢复。文档编辑使用强 ETag，候选和复核提交服务端当前版本；冲突时保留编辑并提示重新核对。模型生成在明确点击后执行，使用 Stele 已配置的模型。恢复先预览范围和冲突、暂存归档，Stele 下次启动时应用。

## 数据与回退

### Work 后台任务与进化实验

在右侧「工作 → 后台任务」填写目标、验收标准、模型与预算，点击「开始执行」。同一 Work 开始后台任务前需要结束普通会话连接。首次启动会安装并启用 WSL 用户服务 `lucyna-work-runner.service`；不改变全局 OMP 配置。WSL 需要 Python 3.10+、systemd 用户服务、bubblewrap，以及已配置的 OMP 和 Work helper。

支持当前 Work 的 UTF-8 文件读写、搜索、L0/L1/L2 局部记录，以及已有 skill 与 Stele L3 的只读使用。技能通过 `list_work_skills` / `read_work_skill` 按需读取，公共知识通过明确的读取白名单访问；不会加载任意 MCP 写入工具或修改公共 skill。Git 成员可查看 status、diff 摘要和 log。

`run_work_command` 使用 `/usr/bin/` 程序和参数数组，可在无网络、无用户主目录的隔离环境内构建/测试，当前 Work 可写；SESSION、成员登记、已有日志与冻结文件只读。固定验收使用相同隔离机制，但整个 Work 只读；临时输出写 `/tmp`。私有配置被遮蔽，符号/硬链接及未挂载的运行时不受支持。Git 写入、任意联网和设备操作继续使用普通会话。未配置自动检查的普通任务由用户验收。

「新建进化实验」使用 AntOmniEvo：选择 1–10 个已有的 Work 局部文件、1–5 轮上限，分别指定训练与留出命令及不重叠的冻结文件。评分器最后一行输出 `{"score":0.75}` 或 `{"passed":3,"total":4}`。全部评分依赖预先提供的检查，程序需实际读取待优化的脚本/流程文件；不会仅凭修改笔记就自动产生能力分数。

首次实验下载固定提交的 AntOmniEvo 并安装于 `~/.local/share/lucyna/ant-omnievo/` 的独立 venv。候选从 Work 快照产生，模型仅能修改选定文件，不能读取列入留出配置的文件；训练运行也遮蔽这些文件。检查输出和候选 diff 可在「放大查看任务与实验」中比较。留出得分达到 100% 且严格优于基线，才出现可采纳候选；点击采纳前会核对 Work 漂移。已采纳文件可回退，外部修改导致哈希不符时拒绝覆盖。评分器由用户负责可信性，当前沙箱不证明任意恶意候选无法对评分器投机。

关闭 Lucyna 后后台任务继续；重新打开同一 Work 可查看状态和回答问题。原生 goal 完成后仍要经过检查。进程/服务中断后保留改动与 journal，进入待核查状态；检查 Work 后点击「恢复执行」。取消任务保留已有改动，不自动回滚代码或结束整个 Work。Token 预算不保证正在进行的请求硬截断。

运行数据位于 WSL 的 `~/.local/state/lucyna/work-runner/`，独立版本位于 `~/.local/share/lucyna/work-runner/`。后台 journal 在该运行目录中，从后台任务入口管理，不混入普通会话历史。若需要停用，在对应 WSL 用户下运行 `systemctl --user disable --now lucyna-work-runner.service`；这会停止受管执行，数据库、journal 和 Work 文件保留。更换服务版本前应先完成或取消已有任务。

用户服务启用不代表 Windows/WSL 冷启动已经验收；需要按本机 WSL 启动机制单独验证。AntOmniEvo 已接入局部文件实验；RSI-Anything 尚未接入，当前能力不等同于已证明长期自进化效果。实验进程中断后保留基线和候选，需显式恢复；未完成候选不会直接写入 Work，缺失最终用量的调用按预留上限计入预算。

### 客户端数据

内部 package 名仍为 `omp-cindy`，以保持旧安装的数据目录兼容。Electron `userData` 存放客户端设置、历史副本及窗口状态；准确位置以设置页为准。原生 WSL profile 和 session 属于 OMP。导入历史使用副本，不覆盖来源。

更新前备份 `runtime.local.json` 和设置页中的数据目录。关闭程序前先确认运行任务；升级不会自动迁移或删除原有 OMP 环境。保留旧 checkout 可回退代码，`npm run start:legacy` 可启动保留的早期界面用于排障。
