# 内置知识引擎与内部知识库

2026-11-01。已实现第一条正式链路：内置 Windows Stele → 内部知识库 → 指定文件夹扫描与复制导入 → 正式阅读/编辑 → 原生 MCP 读写 → 宿主和引擎重启后保留数据。

## 使用

进入「知识库 → 知识库管理」，可以新建内部库、选择本地或可访问的 WSL 文件夹、扫描预览并复制导入。文档和附件进入 Lucyna 的真实 userData 下 `knowledge/`，原目录不修改；原目录移动后，内部副本仍可读取。新建文档和原有 Markdown 编辑器写入同一个版本服务。

正文使用 Markdown 文件，SQLite 保存稳定文档身份、修订、导入清单和幂等操作。当前支持 `.md`、`.markdown`（含大写扩展名）建索引；图片、文本、PDF 和 OpenXML 可以作为附件复制。文件夹导入本身不抽取 PDF/Office 正文；单文件资料捕获仍是独立流程。相对目录和本地图片一起保留。

扫描默认排除 Git、运行缓存、凭据文件和目录链接。单次最多 5,000 个支持文件、512 MiB；Markdown 正文不超过 2 MiB，其他单文件不超过 32 MiB。超限、路径不兼容和不支持格式会列出原因。预览后来源变化、或内部已有不同内容时，导入逐项失败并保留现有版本；当前版本没有三方合并、自动跟随外部目录或导入暂停按钮。

「存储位置和 MCP 连接」提供实际可用的 stdio 配置。命令是运行包内的原生 Stele 可执行文件，使用 `--lucyna-mcp --knowledge-data <profile> --write`；去掉 `--write` 为只读。无需另装 Node/Bun，也不会将服务令牌复制到客户端配置。客户端可在没有 UI 窗口时启动和复用后台知识服务。

MCP 保留原生 Stele 工具，并增加 `library_list`、`library_documents`、`library_read`、`library_write`、`library_history`。编辑使用读取返回的 revision/ETag；同一个 operationId 可安全核对重试，不允许以旧版本覆盖新内容。WSL 客户端使用映射后的 `/mnt/<drive>/...exe` 路径和 `C:/...` profile 参数；已在真实 WSL 和 Work/Stele Python 桥接中验证。

Windows OMP 启用既有 `installWorkIntegration` 时，下一次准备其 Lucyna-owned profile 会把已知的 Work/Stele 桥接接到内部服务，保留其他 MCP 项。任意原有 WSL/SSH profile 和后台 Runner 的独立知识配置不会在此阶段被全局重写；需要使用对应 MCP 连接配置。WSL systemd 后台环境的完整自动接管属于后续工作。

## 运行包与数据

Stele 后端源码固定在 `third_party/stele/`，原始来源摘要见 `UPSTREAM.json`。这是有效源码快照，包含原项目的本地知识扩展，未复制个人知识、模型配置或原网页。向量使用 `third_party/ternlight-base/` 的 Node/WASM 包，保留原 MIT 许可证，不调用外部 Bun，不在启动时下载模型。

开发者构建运行包：

```powershell
python tools/build-knowledge-engine.py --go <go可执行文件>
```

也可在具备 Go 的 WSL checkout 内执行：

```sh
python3 tools/build-knowledge-engine.py --go /path/to/go
```

构建默认生成 Windows amd64 制品。运行文件名包含源码摘要，避免覆盖运行中的 exe。发布资源只包含 `resources/knowledge-engine/manifest.json` 指向的二进制及相应应用/向量资源，不应把开发目录中积累的旧 exe 全部打包。Go 与 Python 仅为构建依赖，运行时使用应用自带 Electron、SQLite、Windows Stele 与 WASM。

前台通过固定 IPC 操作访问后台宿主；宿主通过私有回环 HTTP 与原生 Stele 通信。两层入口均校验连接身份。向量计算在独立 worker thread 中完成，索引分批处理。宿主校验二进制和向量资源摘要，复用同一用户/profile 的服务。当前服务在没有活动请求或 MCP 心跳后空闲 15 分钟退出；没有增加开机自启任务或系统服务。

数据与版本位于 `<userData>/knowledge/`，后台 Chromium profile 位于其 `runtime/` 子目录，不打开前台草稿数据库。正文、候选采纳和捕获的新 Markdown 经过受控写入；独立恢复包导入、原生删除/死链修复及镜像同步尚未接入版本事务，在受管模式下拒绝这些写操作。其他后续功能以设计稿为准，不宣称 Stele 全功能已覆盖。

数据库和文件投影使用持久操作日志恢复。当前内部数据目录应由 Lucyna 管理；外部编辑投影文件后，后续保存会拒绝覆盖并提示核对。历史版本保留在 revisions；当前通过 MCP/API 查询历史，完整版本比较/恢复 UI 尚未加入。

## 验收

- `node --require ./test/setup.cjs --test test/*.test.cjs` 包含文档版本冲突、幂等重试、投影中断恢复、来源预览变化、再导入冲突和路径/链接边界。
- `npm run test:knowledge:managed` 使用实际 Windows Stele、实际 WASM、Electron 后台宿主、SQLite、原生 stdio MCP 及真实 WSL 桥接。验证移走原目录、内部图像、UI artifact 写入、MCP 并发冲突和去重、持久向量、无 UI 的 MCP 启动及全服务重启。
- `npm run test:knowledge:managed-ui` 使用正式生产渲染器、隔离 profile 与真实内部知识引擎，覆盖目录扫描/导入、相对链接、编辑保存、新建文档、四主题深浅模式和 375px 窄窗。原生目录选择结果由测试固定到合成文件夹，不读取真实知识。

测试不会迁移现有 WSL Stele 数据、调用收费模型或更改已有服务。首次使用正式客户端要完整重新打开以加载新的 main/preload；已有会话应先由用户按工作安排处理。

## 旧 WSL 知识库迁移

`node tools/migrate-wsl-knowledge.cjs` 默认只预览并在私有迁移目录生成计划报告，不启动内部引擎或复制正文；加 `--apply` 才复制到实际应用数据目录。它读取旧 Stele 已登记的来源及索引，不递归搬运项目仓库、模型、固件或全部 WSL 主目录。每个旧来源对应独立的 `wsl-<alias>` 内部库。

迁移保留目录结构，沿 Markdown 语法树解析文档和图片引用，并在注册来源范围、5,000 文件和 512 MiB 预算内补充关联资料；代码块中的示例链接不执行。跨库图片复制到引用方的附件目录。会话 JSONL 不转为知识；工作流 YAML 仅作为元数据附件归档；疑似凭据文件或正文排除并在私有报告中说明。对不支持、越界或缺失的引用保留原链接并记录问题，不自动猜测替代目标。

内部文档记录原路径、原始和迁入内容的 SHA-256、来源 ETag 与迁移时间。迁移会逐项核对目标文件摘要和 Markdown 索引，并核对能提供 ETag 的源版本。重复运行跳过相同内容，拒绝覆盖内部不同版本。详细映射、排除项、引用问题及原 Stele 的状态恢复包位于 `<userData>/knowledge/migrations/<id>/`，不进入 Git 或知识检索。旧状态包仅作备份，旧候选、审查、会话及其身份不会被冒充为当前内部引擎状态；迁入内容也未被自动重新核实。

当前正文证据检索仍会逐文档校验来源并读取快照；千篇规模的 Windows 内部库检索延迟仍需优化。文档复制、摘要校验和可读性验收通过，不等于大库检索性能已达标。

## Work 资产分类

在「工作详情 → 资产」中按项目保存，资料仍归属所选 Work。当前入口支持已登记的本机 WSL Work；SSH Work 的资料采集尚未接入。

| 资产 | 管理方式 | 是否自动进入共享知识检索 |
| --- | --- | --- |
| 工作笔记 | 保存当前 UTF-8 文本快照，最多 2 MiB | 否；结论需另行审核、脱敏和提炼 |
| 会话日志 | 归档当前过程记录，与结论区分 | 否 |
| 脚本 | 登记位置、大小、修改时间和可计算的 SHA-256，不执行 | 否 |
| 图片、PDF 证据 ≤10 MiB | 保存 Work 内附件副本；图片可预览，PDF 当前显示来源元数据 | 否 |
| 大文件、原始日志/数据、固件、目录 | 仅登记来源引用，不递归复制目录 | 否 |
| 凭据、密钥、敏感配置、含疑似凭据的正文 | 拒绝入库，提示先脱敏 | 否 |

SQLite 中 `work_materials` 与不可变 `work_material_versions` 保存归属及版本，快照位于独立 `work-materials/` 目录，未注册为 Stele 全局来源。保存后即使原文件删除，快照仍可读；引用记录保留出处而不保证源文件继续存在。MCP 增加只读 `work_material_list(root, query)` 和 `work_material_read(root, id)`，读取要求资料归属于指定 Work，不提供跨 Work 全量列表。

本轮未批量把所有 Work 的笔记、日志当作共享事实，也未自动升级全局记忆或技能。用户需要在资产面板选择保存项。正式复用结论仍应带上来源版本、核实范围和限制，作为新知识文档单独整理。

`test/work-knowledge.test.cjs`、`test/knowledge-migration.test.cjs` 和 `test/work-knowledge-desktop.cjs` 覆盖分类、敏感内容拒绝、归属检查、删除源文件后读取、全局检索隔离、跨库复制与重试、实际资产入口及四主题深浅模式。详细迁移结果属于本机用户数据，不写进公共文档。
