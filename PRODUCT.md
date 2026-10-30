# Lucyna

<!-- impeccable:product-schema 1 -->

本记录根据现有 `README.md`、`docs/features.md` 和本轮用户指令整理。它记录已存在的产品事实与确认范围；没有新增受众访谈或商业定位。

## Platform

web

Electron 承载的 Web renderer，当前主要运行环境为 Windows 11 + WSL2。浏览器开发模式用于界面预览，桌面功能通过 Electron 接入。

## Users

现有功能服务于在 Windows 上使用原生 OMP、Work 工作区和 Stele 知识库的工作场景。更细的目标用户画像、组织角色和商业受众尚未单独确认。

## Product Purpose

Lucyna 为原生 OMP 提供桌面工作台，用可视化界面管理工作区、并行会话、终端、文件阅读和知识引用。用户可以继续已有任务，保留会话上下文与草稿，并在工作中查阅来源资料。

## Positioning

模型、agent loop、技能、工具调用和 session 由原生 OMP 执行；Lucyna 负责桌面上的管理、阅读、输入与状态呈现。Work 承载当前工作上下文，Stele 提供长期知识能力。

## Operating Context

- Windows 桌面客户端可使用 WSL 或 Windows OMP 运行时。
- 工作台在工作区、会话、工具、终端和知识阅读之间切换。
- 普通会话由客户端持有；Work 后台任务与进化实验由独立服务持有。
- 知识功能依赖已存在的 Stele 服务。
- 会话切换需要保留独立草稿、阅读位置、任务状态和终端上下文。

## Capabilities and Constraints

现有能力包括原生会话与消息队列、历史续聊和导入副本、文件与 Markdown 阅读、知识检索和来源引用、工作区诊断、可收起终端、会话状态监视以及客户端设置。完整功能与依赖以 `docs/features.md` 为准。

知识引用进入草稿，由用户发送。候选、待核实、来源版本和运行状态需要清楚区分。设置保存后的生效范围必须与已有连接行为一致。

本轮用户要求使用 Impeccable 优化已有 Lucyna UI，并明确确认“有问题就都优化”。已确认范围是修复评审发现的问题，保持现有产品身份、业务能力与状态保留行为。

## Brand Commitments

产品名称为 Lucyna，界面采用中文任务用语。银发角色与黑猫是既有品牌资产；界面沿用项目现有 Cindy 组件体系。具体视觉规则由 `design.md` 与 renderer 实现定义。

## Evidence on Hand

- `README.md`：产品说明、运行环境和原生 OMP 的职责。
- `docs/features.md`：已实现功能、依赖和当前边界。
- `src/renderer/`：当前界面和交互实现。
- `test/`：隔离桌面回归与合成 fixture。
- `.impeccable/critique/`：本轮独立设计评审和程序检测记录。

演示截图使用合成资料，不代表真实模型执行结果。正式后端连接、读屏器与物理触控的验证范围由各次验收记录单独说明。

## Product Principles

1. 保留原生 OMP 的执行与会话职责。
2. 工作切换保留草稿、进度与阅读上下文。
3. 阅读来源、整理草稿与发送执行分别表达。
4. 区分连接状态、运行状态和文档登记状态。
5. 给可恢复错误提供明确反馈与重试入口。

## Accessibility & Inclusion

本轮界面验收覆盖可访问名称、可见键盘焦点、主导航与内容的关联、抽屉焦点管理以及普通文字的 4.5:1 对比度要求。整项产品的读屏器、真实系统缩放与物理触控覆盖情况仍需各自的实测证据。
