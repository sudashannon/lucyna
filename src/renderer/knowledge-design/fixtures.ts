// Synthetic fixtures for the UI proposal. No production knowledge or sessions.
export const documents = [
  {id:'reconnect',title:'视频重连：先确认控制会话是否释放',type:'知识',workspace:'机器人平台',date:'10 月 29 日',path:'knowledge/video-reconnect.md',tags:['视频链路','故障排查'],summary:'画面恢复需要分别检查媒体数据与控制连接。保留现场后，再决定是否重启。',body:'排查重连时，把媒体链路与控制会话分开验证。接收到数据包只说明传输已经恢复，还需要确认终端实际解码并持续显示。',sections:[['先保留现场','记录最后一帧时间、控制连接状态以及服务日志。新连接无法进入时，先确认旧会话是否仍占用处理线程。'],['分别验证两条链路','媒体侧检查帧是否持续产生、接收与解码；控制侧检查旧连接释放、握手和新会话建立。每一步都保留观察结果。'],['恢复后的验收','连续播放并完成一次主动断开与重连。将验证结果和适用条件补充到知识条目，避免把单层恢复当作整体恢复。']]},
  {id:'service',title:'本地服务启动后的完整验收',type:'知识',workspace:'开发环境',date:'10 月 28 日',path:'knowledge/service-startup.md',tags:['WSL','服务维护'],summary:'按依赖、监听端口、入口和业务请求逐层检查启动结果。',body:'启动成功需要由实际业务请求验证。依赖服务可用、端口监听和入口可达，是逐层推进的检查点。',sections:[['检查依赖','确认运行目录、用户身份和依赖 socket 均可用。'],['验证入口','从实际使用的入口发起请求，记录状态码和响应内容。']]},
  {id:'layout',title:'知识阅读器的交互约定',type:'规范',workspace:'Lucyna',date:'10 月 28 日',path:'specs/knowledge-reader.md',tags:['界面','阅读体验'],summary:'保留筛选、列表位置和阅读进度，证据在当前上下文中展开。',body:'阅读器采用列表与正文并排的布局。切换知识与工作台时，应保留查询条件、选中项和阅读位置。',sections:[['证据就在正文旁','引用携带来源和版本，打开后定位到命中的原文。'],['窄屏阅读','列表与详情分步展示，返回时保留列表位置。']]},
  {id:'source',title:'连接生命周期排查记录',type:'报告',workspace:'机器人平台',date:'10 月 27 日',path:'reports/connection-lifecycle.md',tags:['视频链路','验证记录'],summary:'连接、读取和退出阶段的检查清单及证据记录。',body:'本记录整理连接生命周期中的观察点，为重连知识条目提供示例证据。',sections:[['观察结果','连接建立后应有明确的会话边界和退出条件。记录连接编号，方便追踪后续重连。'],['验收条件','旧会话退出后，新连接能够被接受并完成第一帧显示。']]},
  {id:'tokens',title:'Lucyna 的组件与语义颜色',type:'设计',workspace:'Lucyna',date:'10 月 26 日',path:'design/components.md',tags:['界面','Cindy'],summary:'用同一套组件、字号和语义颜色，保持工作台与知识库的一致性。',body:'基于 Cindy 的暖灰画布、石墨色控件与中性面板，优先让内容本身形成层次。',sections:[['组件复用','按钮、输入框和分段选择复用 Cindy，状态与焦点反馈保持一致。']]},
  {id:'handoff',title:'把排查过程整理为可复用知识',type:'计划',workspace:'开发环境',date:'10 月 25 日',path:'plans/knowledge-handoff.md',tags:['知识维护','证据'],summary:'从工作记录中选择结论、补齐来源，经过审核后保存。',body:'记录结论时同时记录适用范围和原始证据。候选内容经过人工核对后，才进入长期知识。',sections:[['整理步骤','选择结论，核对原文版本，编辑适用条件，再提交为知识候选。']]},
];
export type DemoDocument = typeof documents[number];
export const sessions = [
  {title:'定位视频重连的连接占用',workspace:'机器人平台',runtime:'OMP',date:'今天 10:24',state:'已完成',summary:'梳理媒体链路和控制连接的边界，补充可重现的检查顺序。',docs:['reconnect','source']},
  {title:'统一知识阅读器的交互',workspace:'Lucyna',runtime:'OMP',date:'昨天 16:32',state:'有未完成项',summary:'完成主从阅读布局，待核对窄屏和证据定位。',docs:['layout','tokens']},
  {title:'检查 WSL 服务启动依赖',workspace:'开发环境',runtime:'Claude Code',date:'10 月 27 日',state:'已完成',summary:'整理依赖、端口和请求的分层验收路径。',docs:['service','handoff']},
];
export const candidates = [
  {id:'c1',title:'重连验收应同时覆盖视频与控制连接',workspace:'机器人平台',state:'待审核',text:'重连验收需要确认媒体帧持续显示，以及旧控制会话释放后新会话能够建立。单独观察到数据包或连接成功，都不足以完成整体验收。',source:'连接生命周期排查记录',doc:'source',fresh:true},
  {id:'c2',title:'服务健康检查需要从实际入口发起',workspace:'开发环境',state:'待审核',text:'服务启动后的健康检查包含依赖、端口监听、实际入口和业务请求。',source:'本地服务启动后的完整验收',doc:'service',fresh:false},
  {id:'c3',title:'保留列表与阅读位置',workspace:'Lucyna',state:'已采纳',text:'知识库返回列表时保留筛选、选择和滚动位置。',source:'知识阅读器的交互约定',doc:'layout',fresh:true},
];
export const reviews = [
  {id:'r1',title:'核对重连验收的适用条件',workspace:'机器人平台',reason:'来源有更新',detail:'引用的排查记录已更新。请对照当前原文，确认结论的适用范围。',doc:'reconnect'},
  {id:'r2',title:'启动步骤中的来源链接需要更新',workspace:'开发环境',reason:'失效链接',detail:'一处相对链接没有找到目标，需重新选择来源或移除引用。',doc:'service'},
];
export const sources = [
  {title:'连接生命周期排查记录.pdf',kind:'PDF',workspace:'机器人平台',date:'今天',status:'已解析',text:'来源内容在本地提取。选择有价值的段落后，可整理为待审核的知识候选。'},
  {title:'知识库交互参考.md',kind:'Markdown',workspace:'Lucyna',date:'昨天',status:'已解析',text:'文档列表与阅读区保持稳定，证据和关联信息按需展开。'},
  {title:'本地服务维护笔记',kind:'粘贴文本',workspace:'开发环境',date:'10 月 27 日',status:'已解析',text:'把依赖检查与业务请求记录在一起，形成可以再次执行的验收步骤。'},
];
