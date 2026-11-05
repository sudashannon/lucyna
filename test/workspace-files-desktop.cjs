// Production renderer + isolated synthetic preload. Never connects real services.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {installDesktopLog}=require('./desktop-log.cjs');
const {file:logFile}=installDesktopLog();
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-workspace-files-')));
const out=path.resolve(__dirname,'../.impeccable/review/git-workspace');
let window;const js=code=>window.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){const end=Date.now()+18000;while(Date.now()<end){if(await js('Boolean('+code+')'))return;await pause(60);}throw Error('Timeout '+code);}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const mode=name=>js(`Array.from(document.querySelectorAll('.workspace-files:not([hidden]) .wf-views button')).find(b=>b.textContent.startsWith(${JSON.stringify(name)})).click()`);
async function assertWorkRowsAligned() {
  const rows=await js(`Array.from(document.querySelectorAll('.work-row'),row=>({
    icon:row.querySelector('svg').getBoundingClientRect().left,
    name:row.querySelector('span').getBoundingClientRect().left,
    hasDisclosure:!!row.parentElement.querySelector('.work-session-disclosure'),
  }))`);
  assert.ok(rows.some(row=>row.hasDisclosure)&&rows.some(row=>!row.hasDisclosure),'fixture has both Work row types');
  for(const row of rows){
    assert.ok(Math.abs(row.icon-rows[0].icon)<0.5,'Work folder icons share one column');
    assert.ok(Math.abs(row.name-rows[0].name)<0.5,'Work names share one column');
  }
}
async function assertConversationAligned(selectors) {
  const geometry=await js(`(()=>{
    const rect=selector=>{const node=document.querySelector(selector);if(!node?.getClientRects().length)return null;
      const {left,right,width}=node.getBoundingClientRect();return {left,right,width};};
    return {composer:rect('.composer'),workspace:rect('.workspace-conversation'),
      timeline:rect('.conversation-timeline'),items:${JSON.stringify(selectors)}.map(rect)};
  })()`);
  const {composer,workspace,timeline,items}=geometry;
  assert.ok(composer?.width>0&&workspace?.width>0,JSON.stringify(geometry));
  items.forEach((item,index)=>{
    assert.ok(item?.width>0,selectors[index]+' is visible');
    for(const edge of ['left','right'])assert.ok(Math.abs(item[edge]-composer[edge])<1,
      `${selectors[index]} ${edge} ${item[edge]} must match composer ${composer[edge]}`);
  });
  assert.ok(Math.abs(composer.left-workspace.left-((timeline?.left??workspace.right)-composer.right))<1,
    'conversation column is centered before the visible timeline');
}
async function captureConversation(name) {
  await js('document.fonts.ready');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(out,name+'.png'),(await window.webContents.capturePage()).toPNG());
}
async function shot(name){await until('document.querySelector("#workspace-tab-files").getAttribute("aria-selected")==="true"&&document.querySelector(".workspace-files:not([hidden])")?.getClientRects().length');await js('document.fonts.ready');await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'page overflow');fs.writeFileSync(path.join(out,name+'.png'),(await window.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>app.exit(2),160000),errors=[],checks=[];
 try{
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,running:true,data:'synthetic offline fixture'}));
  window=new BrowserWindow({width:1440,height:960,useContentSize:true,show:false,webPreferences:{preload:path.join(__dirname,'workspace-files-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  window.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  await window.loadFile(path.resolve(__dirname,'../dist/renderer/index.html'));await until('document.querySelectorAll(".work-row").length===3');
  assert.deepEqual(await js('Array.from(document.querySelectorAll(".work-host-heading"),el=>el.textContent)'),['本机','SSH · demo-server']);
  await click('.work-row');await until('document.querySelector("#message-input")');
  await until('document.querySelector(".workbench-top .workbench-branch")?.textContent.includes("codex/workspace-files")');
  assert.ok(await js('document.querySelector(".work-directory > .companion-sessions")?.getClientRects().length&& !document.querySelector(".application-navigation")'));
  assert.ok(await js('Array.from(document.querySelectorAll(".workbench-top button")).every(button=>button.getBoundingClientRect().right<=innerWidth)'));
  assert.ok(await js('document.querySelector(".workbench-tool-rail").getBoundingClientRect().left>=document.querySelector("#tools-panel").getBoundingClientRect().right-1'));
  await until('document.querySelector("#tool-panel-overview .workbench-overview")?.textContent.includes("在对话旁审查本轮改动")');
  await click('.workbench-overview > button');
  await until('!document.querySelector("#tool-panel-work").hidden');
  await click('#tab-overview');
  await until('!document.querySelector("#tool-panel-overview").hidden');
  const workMenu=label=>js(`document.querySelector(${JSON.stringify('button[aria-label="'+label+' 的更多操作"]')})
    .dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerType:'mouse',bubbles:true}))`);
  const placeWork=async (label,action)=>{
    await workMenu(label);
    const item=`Array.from(document.querySelectorAll('.work-row-menu-popup [role=menuitem]')).find(button=>button.textContent===${JSON.stringify(action)})`;
    await until(item);
    await js(`(${item}).click()`);
    await until('!document.querySelector(".work-row-menu-popup")');
  };
  await placeWork('other-work','暂放 Work');
  await until('document.querySelector(".parked-works summary")?.textContent.includes("1")');
  assert.equal(await js('document.querySelector(".parked-works").open'),false);
  await click('.parked-works summary');
  await until('document.querySelector(".parked-works").open');
  await placeWork('other-work','置顶 Work');
  await until('!document.querySelector(".parked-works")');
  assert.ok(await js('document.querySelector(".work-list .work-row").textContent.includes("other-work")'));
  await placeWork('remote-lucyna','置顶 Work');
  const pinnedNames=()=>js('Array.from(document.querySelectorAll(".work-list .work-row:has(.work-row-pin)"),row=>row.querySelector("span").firstChild.textContent)');
  assert.deepEqual(await pinnedNames(),['remote-lucyna','other-work']);
  assert.ok(await js('document.querySelector(".work-list .work-row").textContent.includes("demo-server · SSH")'));
  assert.ok(await js('document.querySelector(".work-row[aria-current=page]").textContent.includes("lucyna")'));
  await captureConversation('work-pins');
  await window.reload();
  await until('document.querySelectorAll(".work-list .work-row").length===3');
  assert.deepEqual(await pinnedNames(),['remote-lucyna','other-work']);
  await placeWork('remote-lucyna','取消置顶');
  await placeWork('other-work','暂放 Work');
  assert.deepEqual(await pinnedNames(),[]);
  await until('document.querySelector(".parked-works summary")');
  await click('.parked-works summary');
  await until('document.querySelector(".parked-works").open');
  await placeWork('other-work','移回工作列表');
  await until('!document.querySelector(".parked-works")');
  assert.ok(await js('document.querySelector(".work-list .work-row").textContent.includes("lucyna")'));
  checks.push('Compact sidebar, persistent Work pin order and SSH identity, and moving between pins and parking');
  await assertWorkRowsAligned();
  await click('.work-session-disclosure[aria-expanded="true"]');
  await assertWorkRowsAligned();
  assert.ok(await js('document.querySelector(".work-row[aria-current=page]").textContent.includes("lucyna")'));
  await click('.work-session-disclosure[aria-expanded="false"]');
  window.setContentSize(1820,960);
  await until('Math.abs(innerWidth-1820)<=2 && document.querySelector(".connection-progress")');
  await js('window.workspaceFixture.showStoppedTasks()');
  await until('document.querySelector(".session-tasks summary")?.textContent.includes("3") && document.querySelector("#run-status")?.dataset.outcome==="aborted"');
  assert.equal(await js('!!document.querySelector(".conversation-timeline")'),false,'task-only restore has no timeline');
  assert.ok(await js('document.querySelector(".workspace-conversation").clientWidth>=960'),'task-only restore exceeds outline breakpoint');
  await assertConversationAligned(['.connection-progress','.message-column','.session-tasks','#run-status']);
  await captureConversation('conversation-restoring-aligned');
  await js('window.workspaceFixture.restoreHistory()');
  await until('document.querySelector(".timeline-outline")?.getBoundingClientRect().width>190 && !document.querySelector(".connection-progress")');
  await assertConversationAligned(['.message-column','.session-tasks','#run-status']);
  await captureConversation('conversation-outline-aligned');
  for(const theme of ['classic','folio','pixel','blue']){
    await js(`(()=>{const select=document.querySelector('select[aria-label="视觉主题"]');
      select.value=${JSON.stringify(theme)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(`document.documentElement.dataset.visualTheme===${JSON.stringify(theme)}`);
    await assertConversationAligned(['.message-column','.session-tasks','#run-status']);
  }
  window.webContents.setZoomFactor(1.25);
  await until('document.querySelector(".conversation-timeline")?.getBoundingClientRect().width===36');
  await assertConversationAligned(['.message-column','.session-tasks','#run-status']);
  window.webContents.setZoomFactor(1);
  window.setContentSize(390,844);
  await until('Math.abs(innerWidth-390)<=2');
  await assertConversationAligned(['.message-column','.session-tasks','#run-status']);
  assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
  await captureConversation('conversation-compact-aligned');
  window.setContentSize(1440,960);
  await until('Math.abs(innerWidth-1440)<=2');
  await js('document.querySelectorAll(".work-row")[1].click()');
  await until('document.querySelector(".welcome")?.textContent.includes("other-work")');
  await assertConversationAligned(['.welcome','.recent-sessions']);
  await js('document.querySelectorAll(".work-row")[2].click()');
  await until('document.querySelector(".remote-connection")');
  await assertConversationAligned(['.welcome','.recent-sessions','.remote-connection']);
  const terminalButton='.workspace-header button[aria-label="WSL 终端"]';
  assert.ok(await js(`document.querySelector(${JSON.stringify(terminalButton)}).disabled`));
  await click('.work-row');
  await until('document.querySelector(".message-column")');
  checks.push('Conversation column aligns while restoring tasks, with wide outline and compact rail, at 125% zoom, and in empty/SSH views');
  const navStarts=()=>js(`Array.from(document.querySelectorAll('.workspace-content-tabs button,.workspace-tool-button'),button=>button.getBoundingClientRect().left)`);
  const workspaceChanges='.workspace-header button[aria-label="查看工作区改动"]';
  assert.ok(await js(`Boolean(document.querySelector('.workbench-global-tools select[aria-label="视觉主题"]') && document.querySelector('.workbench-global-tools button[aria-label="在默认浏览器打开网页"]'))`));
  assert.equal(await js('document.querySelector("#workspace-tab-sessions").textContent'),'活跃会话');
  assert.equal(await js('document.querySelector("#workspace-tab-sessions").title'),'1 个已连接会话，含空闲连接');
  for(let n=0;n<7;n++)await js(`document.querySelector('.sidebar-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  for(const width of [1440,1300]){
    window.setContentSize(width,960);
    await until('Math.abs(innerWidth-'+width+')<=2');
    const before=await navStarts();
    for(const tab of ['files','sessions','chat']){
      await click('#workspace-tab-'+tab);
      await until(`document.querySelector('#workspace-tab-${tab}').getAttribute('aria-selected')==='true'`);
      assert.deepEqual(await navStarts(),before,'tabs and Work tools remain anchored at '+width+'px');
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('.workspace-header button:not([role=tab])'),b=>b.getAttribute('aria-label')).filter(label=>label&&label!=='展开工具面板')`),
        ['WSL 终端','查看工作区改动'],'the same Work tools are present in each view');
      if(width===1440)await captureConversation('workbench-navigation-'+tab);
    }
  }
  await js(`document.querySelector('.sidebar-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  window.setContentSize(1440,960);
  await until('Math.abs(innerWidth-1440)<=2');
  await click('#workspace-tab-files');
  await click(terminalButton);
  await until('document.querySelector(".terminal-panel:not([hidden]) .terminal-header [role=status]")?.textContent==="WSL 终端"');
  await click('#workspace-tab-sessions');
  await until('document.querySelector(".terminal-panel").hidden');
  await click(terminalButton);
  await until('!document.querySelector(".terminal-panel").hidden');
  const terminals=await js('window.workspaceFixture.stats().calls.filter(call=>call.kind==="terminal")');
  assert.deepEqual(terminals,[{kind:'terminal',root:'/home/demo/work/lucyna'}]);
  await click('.terminal-header button[aria-label="收起终端"]');
  await until('document.querySelector(".terminal-panel").hidden');
  checks.push('Three destinations stay anchored with a resized sidebar and keep the same Work tools');
  await js(`(()=>{const e=document.querySelector('#message-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'保留我的对话草稿');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('.companion-sessions');
  await until('document.querySelector("#workspace-tab-sessions").getAttribute("aria-selected")==="true"');
  const companionHasNoFill=`(()=>{
    const companion=document.querySelector('.companion-sessions');
    return companion?.getAttribute('aria-pressed')==='true'&&getComputedStyle(companion).backgroundColor==='rgba(0, 0, 0, 0)';
  })()`;
  assert.ok(await js(companionHasNoFill),'the companion keeps a transparent surface while its view is active');
  await captureConversation('companion-active');
  window.setContentSize(390,844);
  await until('Math.abs(innerWidth-390)<=2 && document.querySelector(".application-navigation .companion-sessions")');
  assert.ok(await js(companionHasNoFill),'the compact rail keeps the companion transparent');
  window.setContentSize(1440,960);
  await until('Math.abs(innerWidth-1440)<=2');
  await click('#workspace-tab-chat');
  await until('document.querySelectorAll(".message.user .turn-review-action").length===1');
  await click('.turn-review-action');
  await until('document.querySelector(".turn-changes .wf-diff")?.textContent.includes("prior_round")');
  assert.ok(await js('document.querySelector(".turn-changes h2").textContent==="本轮改动" && document.querySelector(".transcript").getClientRects().length'));
  await assertConversationAligned(['.message-column','.session-tasks','#run-status']);
  await js('window.workspaceFixture.publishLatestReview()');
  await until('document.querySelectorAll(".turn-review-action").length===2');
  await js('Array.from(document.querySelectorAll(".turn-review-action")).at(-1).click()');
  await until('document.querySelector(".turn-changes .wf-diff")?.textContent.includes("later_round")');
  assert.equal(await js('Array.from(document.querySelectorAll(".turn-review-action")).at(-1).getAttribute("aria-expanded")'),'true');
  assert.ok(await js('!document.querySelector(".turn-changes .wf-diff").textContent.includes("prior_round")'));
  await js('window.workspaceFixture.completeRound()');
  await until('document.querySelector("#run-status .run-review-action")');
  await click('#tab-overview');
  await until('!document.querySelector("#tool-panel-overview").hidden');
  await until('document.querySelector(".workbench-progress-document table")?.textContent.includes("本地分支")');
  assert.ok(await js('document.querySelector(".workbench-progress-document code")?.textContent.startsWith("feature/")'));
  assert.ok(await js(`(()=>{
    const preview=document.querySelector('.workbench-progress-document'),table=preview.querySelector('table'),panel=document.querySelector('#tools-panel');
    return preview.getBoundingClientRect().right<=panel.getBoundingClientRect().right
      && table.closest('[data-streamdown="table-wrapper"]')?.getBoundingClientRect().width<=preview.clientWidth
      && !Array.from(document.querySelectorAll('.timeline-entry')).some(entry=>entry.textContent.includes('| --- |'));
  })()`),'Markdown table renders within the inspector and navigation omits table syntax');
  await captureConversation('compact-workbench-overview');
  checks.push('Work overview preserves Markdown tables and inline code in its own scroll region');
  await click('.run-review-action');
  await until('document.querySelector(".turn-changes .wf-diff")?.textContent.includes("later_round")');
  await captureConversation('compact-workbench-review');
  await js('document.fonts.ready');await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(out,'conversation-turn-review.png'),(await window.webContents.capturePage()).toPNG());
  await click('.turn-changes .text-action');
  await until('document.querySelector("#tool-panel-changes .wf-diff")?.textContent.includes("app_staged")');
  checks.push('Restored prompts use the saved turn, live completion updates the list, and current Git remains separate');
  await click('#workspace-tab-sessions');
  await click(workspaceChanges);
  await until('document.querySelector("#workspace-tab-chat").getAttribute("aria-selected")==="true"');
  await until('document.querySelector("#tool-panel-changes .wf-diff")?.textContent.includes("app_staged")');
  assert.ok(await js('!document.querySelector("#tools-panel").hasAttribute("aria-modal") && document.querySelector("#message-input").getClientRects().length'));
  await js('document.fonts.ready');await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(out,'conversation-review-desktop.png'),(await window.webContents.capturePage()).toPNG());
  await js(`(()=>{const picker=document.querySelector('[aria-label="选择改动文件"]');picker.selectedIndex=1;picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until('document.querySelector("#tool-panel-changes .wf-diff")?.textContent.includes("app_unstaged")');
  await js(`Array.from(document.querySelectorAll('#tool-panel-changes button')).find(b=>b.textContent.includes('加入对话草稿')).click()`);
  assert.ok(await js('document.querySelector("#message-input").value.includes("app_unstaged") && document.querySelector("#message-input").value.includes("保留我的对话草稿")'));
  window.setContentSize(1100,960);
  await until('Math.abs(innerWidth-1100)<=2 && !document.querySelector("#tools-panel").getClientRects().length');
  await click('#workspace-tab-files');
  await click(workspaceChanges);
  await until('document.querySelector("#tools-panel").getAttribute("aria-modal")==="true"');
  await js(`Array.from(document.querySelectorAll('#tool-panel-changes button')).find(b=>b.textContent.includes('加入对话草稿')).click()`);
  await until('document.activeElement?.id==="message-input" && !document.querySelector("#tools-panel").getClientRects().length');
  await click('.turn-review-action');
  await until('document.querySelector("#tools-panel").getAttribute("aria-modal")==="true" && document.querySelector(".turn-changes .wf-diff")?.textContent.includes("prior_round")');
  await click('.turn-changes .changes-actions button');
  await until('document.activeElement?.id==="message-input" && document.querySelector("#message-input").value.includes("prior_round")');
  window.setContentSize(1440,960);
  await until('Math.abs(innerWidth-1440)<=2');
  await js(`(()=>{const e=document.querySelector('#message-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'保留我的对话草稿');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  checks.push('Companion opens active sessions; conversation review reads and quotes Git in wide and narrow layouts');
  await click('#workspace-tab-files');await until('document.querySelector(".workspace-files:not([hidden]) .file-list-row")');
  assert.equal(await js('document.querySelector("#tools-panel").getClientRects().length'),0);
  await click('.workspace-files:not([hidden]) button[aria-label="预览文件 SESSION.md"]');await until('document.querySelector(".workspace-files:not([hidden]) .reader-body")');
  await js(`(()=>{const e=document.querySelector('.workspace-files:not([hidden]) .reader-body');e.scrollTop=180;e.dispatchEvent(new Event('scroll',{bubbles:true}));})()`);
  await shot('browse-desktop');checks.push('Full-width file tab and real shared reader');
  await mode('改动');await until('document.querySelectorAll(".workspace-files:not([hidden]) .wf-file-row").length===3');
  await click('.workspace-files:not([hidden]) .wf-file-row');await until('document.querySelector(".wf-diff")?.textContent.includes("app_staged")');
  assert.ok(await js('document.querySelector(".wf-views [aria-selected=true]").textContent.includes("2")'),'distinct path count');
  await js(`Array.from(document.querySelectorAll('.wf-change-group')).find(g=>g.querySelector('h3')?.textContent.includes('未暂存')).querySelector('button').click()`);await until('document.querySelector(".wf-diff")?.textContent.includes("app_unstaged")');
  await shot('changes-desktop');checks.push('Reusable diff, separate staged/unstaged scopes and unique path count');
  await js(`Array.from(document.querySelectorAll('.wf-list>.wf-scope button,.wf-list .wf-scope button')).find(b=>b.textContent==='登记基线').click()`);await until('document.querySelector(".wf-diff")?.textContent.includes("app_baseline")');
  assert.equal(await js('window.workspaceFixture.stats().calls.filter(c=>c.action==="diff").at(-1).options.file'),'');checks.push('Baseline comparison clears a previous file filter');
  await js(`Array.from(document.querySelectorAll('.wf-list .wf-scope button')).find(b=>b.textContent==='未暂存').click()`);
  await mode('历史');await until('document.querySelector(".wf-commit-row")');await click('.wf-commit-row');await until('document.querySelector(".wf-diff")?.textContent.includes("const commit")');await shot('history-desktop');
  await mode('分支');await until('document.querySelector(".wf-commit-row")');await click('.wf-commit-row');await until('document.querySelector(".wf-diff")?.textContent.includes("const compare")');
  await mode('Worktree');await until('document.querySelectorAll(".wf-worktrees article").length===2');await shot('worktrees-desktop');checks.push('History, branch comparison and worktree listing');
  await mode('浏览');await until('document.querySelector(".workspace-files:not([hidden]) .reader-body")?.scrollTop>100');
  await click('#workspace-tab-chat');await until('document.querySelector("#message-input").getClientRects().length');assert.equal(await js('document.querySelector("#message-input").value'),'保留我的对话草稿');
  await click('#workspace-tab-files');checks.push('Reader position and conversation draft survive tab switches');
  await js(`Array.from(document.querySelectorAll('.workspace-files:not([hidden]) .wf-reader-heading button')).find(b=>b.textContent.includes('在对话中讨论')).click()`);await until('document.querySelector("#workspace-tab-chat").getAttribute("aria-selected")==="true"');
  assert.ok(await js('document.querySelector("#message-input").value.includes("文件/范围：SESSION.md")'));assert.ok(await js('document.querySelector("#message-input").value.includes("保留我的对话草稿")'));await click('#workspace-tab-files');checks.push('File discussion appends a bounded excerpt to the existing draft without sending');
  await js('document.querySelectorAll(".work-row")[2].click()');await until('document.querySelector(".workspace-header").textContent.includes("remote-lucyna")');await click('#workspace-tab-files');await until('document.querySelector(".workspace-files:not([hidden]) .wf-notice")?.textContent.includes("此主机版本尚不支持")');
  assert.equal(await js('document.querySelector(".workspace-files:not([hidden]) .reader-body")'),null);checks.push('Same-root SSH Work cannot inherit local files');
  await js('document.querySelectorAll(".work-row")[0].click()');await until('document.querySelector(".workspace-files:not([hidden]) .file-list-row")');await mode('改动');await until('document.querySelector(".wf-file-row")');await click('.wf-file-row');await until('document.querySelector(".wf-diff")');
  for(const theme of ['blue','classic','folio','pixel'])for(const appearance of ['light','dark']){
    await js(`(()=>{const e=document.querySelector('select[aria-label="视觉主题"]');e.value=${JSON.stringify(theme)};e.dispatchEvent(new Event('change',{bubbles:true}));if(document.documentElement.dataset.theme!==${JSON.stringify(appearance)})document.querySelector('button[aria-label="'+(document.documentElement.dataset.theme==='dark'?'切换浅色外观':'切换深色外观')+'"]').click();})()`);
    await until(`document.documentElement.dataset.visualTheme===${JSON.stringify(theme)}&&document.documentElement.dataset.theme===${JSON.stringify(appearance)}`);await assertWorkRowsAligned();await shot(theme+'-'+appearance);
  }
  checks.push('Four visual themes in light and dark');
  for(const [width,height] of [[960,900],[390,844]]){
    window.setContentSize(width,height);await until('Math.abs(innerWidth-'+width+')<=2');await shot('width-'+width);
    if(width===960)await assertWorkRowsAligned();
    await click('.workspace-files:not([hidden]) .wf-mobile-controls button');await until('document.querySelector(".workspace-files:not([hidden]) .wf-list").getClientRects().length');
    await click('.workspace-files:not([hidden]) .wf-file-row');await until('document.querySelector(".workspace-files:not([hidden]) .wf-reader").getClientRects().length');
  }
  checks.push('960px and 390px list/content navigation');
  await mode('Worktree');await until('document.querySelectorAll(".workspace-files:not([hidden]) .wf-worktrees article").length===2');assert.equal(await js('document.querySelector(".workspace-files:not([hidden]) .wf-mobile-controls")'),null);await shot('worktrees-390');checks.push('Narrow Worktree view has no inapplicable file-list control');
  const stats=await js('window.workspaceFixture.stats()');assert.equal(stats.starts,0,'browsing must not start OMP');assert.ok(!stats.calls.some(c=>/stage|commit|push|fetch/.test(c.action||'')&&c.action!=='commit'),'no mutation APIs');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,errors,data:'synthetic offline fixture',starts:stats.starts},null,2));console.log(JSON.stringify({passed:true,checks}));
 }catch(e){
  app.exitCode=1;
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:e.stack,checks,errors,logFile},null,2));
  console.error(e.stack);
  console.error(errors);
  if(window)console.error(await js('document.body.innerText.slice(-2500)').catch(()=>''));
 }
 finally{clearTimeout(timer);app.exit(app.exitCode||0);}
});
