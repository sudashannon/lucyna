# 开发与验证

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
