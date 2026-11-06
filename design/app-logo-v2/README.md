# Lucyna 猫猫应用图标

2026-11-05：根据用户要求，应用图标只保留黑猫，移除人的银色刘海、发缕和发色点缀。

主图使用自然猫额头、青色眼睛、粉色耳内与鼻尖，透明外缘带浅色轮廓，以适配深浅背景。16–24px 使用独立简化稿，放大眼部识别，省略鼻口和眼内高光；32px 以上保留完整表情。

两张主稿由内置 image_gen 生成，图像和透明通道原样保存。完整生成和调整提示词记录在 `prompts.json`。`tools/build-app-icons.cjs` 仅缩放、转换 PNG 和封装 ICO，不重绘主稿。

- `logo-master.png`：主图原稿。
- `logo-small-master.png`：小尺寸原稿。
- `icon-{size}.png`：16、20、24、32、40、48、64、128、256px 导出。
- `preview.html`、`logo-preview.png`：深浅背景及实际使用尺寸预览。
- `verification.json`：ICO 原生解码结果。

构建输出为 `src/assets/app-icon.ico`、`src/assets/app-icon.png` 和 `src/assets/tray-icon.png`。既有共享引用会同步更新侧栏、窗口、任务栏、网页 favicon 和托盘。原对话头像、欢迎插画及桌宠角色素材沿用现有资产。

已检查九档 ICO 的帧尺寸、透明边角、PNG 一致性和 Electron 原生解码，并查看深浅背景下的尺寸预览；renderer 构建通过。窗口和托盘使用新图标需要下次启动 Lucyna，本次没有重启客户端。Windows 已固定快捷方式可能受系统图标缓存影响。

旧设计保留在 `design/app-logo-v1`。需要回退时，将构建脚本的主稿目录切回 v1 并重新生成图标。
