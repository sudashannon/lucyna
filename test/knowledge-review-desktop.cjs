// Production renderer + disposable Stele profile; never touches the user's
// running knowledge host. Findings and actions use the real lint/review API.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {startKnowledgeHost}=require('../src/knowledge-host.cjs'),{createManagedKnowledge}=require('../src/knowledge-managed.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-knowledge-review-ui-')),
  out=path.resolve('.runtime/knowledge-review-desktop');
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'progress.log'),'');app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
const stage=value=>fs.appendFileSync(path.join(out,'progress.log'),value+'\n');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let win,host,service,missingRevision=false,adviceMode='normal',adviceCalls=0,pendingAdvice=[];
const adviceAgent={async adviseKnowledgeReview(_config,request,signal){
 adviceCalls++;
 if(adviceMode==='defer')await new Promise((resolve,reject)=>{pendingAdvice.push(resolve);signal?.addEventListener('abort',()=>reject(new Error('建议请求已取消')),{once:true});});
 if(adviceMode==='fail'){adviceMode='normal';throw Error('fixture 建议服务临时失败');}
 const rule=request.finding?.issue?.rule||'unknown',title=request.document.title;
 const related=request.context.documents?.find(document=>!document.blocked&&document.id!==request.document.id&&document.content?.trim().length>=8);
 const guidance={
  orphan:`「${title}」适合作为独立记录保留。若实际属于标签治理主题，请在原文中链接到经过核对的同主题文档。`,
  'missing-sections':`「${title}」当前缺少可直接识别的目标、决策和风险要点，建议逐项补充现有事实。`,
 };
 return {summary:guidance[rule]||`先依据「${title}」的原文核对“${rule}”提醒，再决定是否补充说明。`,steps:['对照原文确认这条结构提醒是否影响后续检索或维护。','只补充能够从当前资料中确认的内容，保留适用范围和来源。','保存后重新检查；若提醒不适用，可忽略当前版本。'],suggestedText:rule==='missing-sections'?'目标：待依据原文补充\n决策：待依据当前记录确认\n风险：列出已知影响；无资料时保留待核实说明':'',questions:['文档应关联到哪个已登记的主题条目？','是否存在尚未导入的相关资料？'],references:related?[{id:related.id,quote:related.content.trim().slice(0,Math.min(180,related.content.trim().length))}]:[],limitations:request.context.coverage==='partial'?['关联资料只读取了部分内容，不能据此判断完整范围。']:['建议由你结合完整原文确认后再采纳。']};
}};
const js=code=>win.webContents.executeJavaScript(code);
async function until(code,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await js(`(()=>{try{return Boolean(${code})}catch{return false}})()`))return;await pause(80);}throw Error('Timeout '+code);}
async function click(text){assert.ok(await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&!b.disabled&&(b.getAttribute('aria-label')===${JSON.stringify(text)}||b.innerText.trim()===${JSON.stringify(text)}));b?.click();return !!b})()`),'visible button '+text);await pause(120);}
async function clickDialog(text){assert.ok(await js(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')].find(e=>e.getClientRects().length);const b=[...(d?.querySelectorAll('button')||[])].find(b=>b.getClientRects().length&&!b.disabled&&b.innerText.trim()===${JSON.stringify(text)});b?.click();return !!b})()`),'visible dialog button '+text);await pause(120);}
async function fill(label,value){await js(`(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+"]");if(!e)throw Error('missing '+${JSON.stringify(label)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='INPUT'?HTMLInputElement.prototype:HTMLSelectElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await pause(120);}
async function chooseReview(title){
 await until(`[...document.querySelectorAll('.knowledge-review-row')].some(b=>b.querySelector('strong')?.innerText===${JSON.stringify(title)})`);
 await js(`[...document.querySelectorAll('.knowledge-review-row')].find(b=>b.querySelector('strong')?.innerText===${JSON.stringify(title)}).click()`);
 await until(`document.querySelector('.knowledge-review-detail h2')?.innerText===${JSON.stringify(title)}`);
}
function contrastRatio(foreground,background){
 const luminance=color=>{const values=color.match(/[\d.]+/g)?.slice(0,3).map(Number);if(!values||values.length!==3)throw Error('Cannot measure button color '+color);const [r,g,b]=values.map(value=>{const channel=value/255;return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2;});return 0.2126*r+0.7152*g+0.0722*b;};
 const a=luminance(foreground),b=luminance(background);return Number(((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)).toFixed(2));
}
async function shot(name){await js('document.fonts.ready');await pause(180);assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'horizontal overflow '+name);const detail=await js('(()=>{const element=document.querySelector(".knowledge-review-detail");return element?{scrollWidth:element.scrollWidth,clientWidth:element.clientWidth}:null})()');if(detail)assert.ok(detail.scrollWidth<=detail.clientWidth,`review detail horizontal overflow ${name}: ${detail.scrollWidth}/${detail.clientWidth}`);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
function ruleType(title){return title==='Controlled tag taxonomy rollout'?'orphan':'missing-sections';}

app.whenReady().then(async()=>{
 let deleteConfirmStyle=null;const errors=[],checks=[],timer=setTimeout(()=>app.exit(2),180000);
 try{
  stage('electron-ready');
  host=await startKnowledgeHost({directory:path.join(root,'knowledge'),reviewAdviceOptions:{agent:adviceAgent}});
  stage('knowledge-host-ready');
  for(const task of [host.consolidation,host.maintenance,host.governance])clearInterval(task.timer);
  host.consolidation.config={baseURL:'http://127.0.0.1:9/v1',model:'fixture-advice-model',protocol:'chat-completions',timeoutSeconds:30,apiKey:'fixture'};
  service=createManagedKnowledge({directory:path.join(root,'knowledge')});
  stage('managed-service-ready');
  ipcMain.handle('knowledge-test',async(event,kind,args)=>{
   const value=await service(kind,args);
   if(kind==='reviews'&&missingRevision)return value.map(item=>item.issue.rule==='orphan'?{...item,issue:{...item.issue,inputRevision:''}}:item);
   return value;
  });
  ipcMain.handle('knowledge-test-mode',(_event,mode)=>{if(mode==='missing-revision')missingRevision=true;else if(mode==='restore-revision')missingRevision=false;else if(mode==='fail-advice')adviceMode='fail';else if(mode==='defer-advice')adviceMode='defer';else if(mode==='release-advice'){adviceMode='normal';for(const release of pendingAdvice.splice(0))release();}return true;});
  ipcMain.handle('knowledge-test-save',()=>false);
  win=new BrowserWindow({width:1500,height:980,useContentSize:true,show:false,webPreferences:{preload:path.join(__dirname,'knowledge-review-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});

  // Four substantive rows plus enough ordinary findings to exercise a scrollable queue.
  const library=host.store.list()[0];
  const titles=['Controlled tag taxonomy rollout','基于多会话证据的跨工作区权限边界与迁移策略长期核验说明样例标题',
    'A Controlled Rollout for Cross-Workspace Tag Governance With Versioned Evidence and Explicit Ownership'];
  const documents=[
   {relative:'notes/Controlled tag taxonomy rollout.md',content:'# Controlled tag taxonomy rollout\n\n本次试点只覆盖个人知识库中的标签治理。每次导入都保留版本记录。\n'},
   {relative:'reports/权限边界与迁移策略.md',content:'# '+titles[1]+'\n\n逐项核对来源、归属与保留期限，并记录每次调整的依据。\n'},
   {relative:'reports/cross-workspace-rollout.md',content:'# '+titles[2]+'\n\nThe rollout keeps the original sources, ownership and review date visible.\n'},
   {relative:'设计/完整性检查样例.md',content:'# 完整性检查样例\n\n此记录说明本次验证输入和观察到的变化。\n'}
  ];
  for(let index=0;index<36;index++)documents.push({relative:`notes/一般条目-${String(index+1).padStart(2,'0')}.md`,content:`# 一般条目 ${index+1}\n\n这是用于检验长列表、滚动和筛选的隔离资料。\n`});
  for(const document of documents.filter(d=>d.relative.startsWith('设计/')))document.content+='\n## 使用范围\n\n本页保留资料的原始归属、适用版本和编写背景。阅读时先确认当前工作是否处于相同环境，再决定是否引用；不同来源的记录应分别核对，避免混用尚未统一的术语。\n\n## 整理方式\n\n先整理同一主题下的常用名称与别名，再逐步补充必要的文档链接。每次调整都记录对应的原始资料和修改缘由，历史内容继续保留。对不属于当前主题的资料，可保留独立条目，不强行建立关联。\n\n## 维护记录\n\n后续有新资料加入时，先比较上下文和版本，再更新当前说明。对仍有分歧的描述保留出处和待讨论事项，避免未经核对就将它们合并为统一结论。\n';
  documents[0].content='# Controlled tag taxonomy rollout\n\nThis document describes the controlled vocabulary used to classify technical references. Tags identify a subject, a document role, or a product family. A tag should have one clear meaning throughout the collection.\n\n## Vocabulary and aliases\n\nChoose a canonical name for each concept and record older spellings as aliases. Avoid creating separate tags for capitalization, punctuation, or abbreviations. Keep product names intact when they distinguish genuinely different families.\n\n## Applying the vocabulary\n\nInspect a small sample before changing the rest of the collection. Keep the original classification available during the transition. If a document crosses several subjects, assign the relevant concepts individually instead of creating a compound label for every combination.\n';
  const ids=new Map();for(const document of documents){const saved=await host.store.write({library:library.id,...document,expected:'new'});ids.set(document.relative,saved.id);}stage('forty-documents-written');
  const spaces=await host.nativeJSON('/api/workspaces');
  if(!spaces.some(space=>space.alias===library.alias))await host.nativeJSON('/api/workspaces',{method:'POST',bytes:JSON.stringify({alias:library.alias,path:library.path,type:'docs'}),headers:{'content-type':'application/json'}});
  stage('workspace-registered');
  await host.nativeJSON('/api/wiki/rebuild',{method:'POST'});
  stage('wiki-index-rebuilt');
  const catalog=await service('catalog',{refresh:true}),
    focusDocument=catalog.documents.find(document=>document.title===titles[0]),
    sectionDocument=catalog.documents.find(document=>document.title==='完整性检查样例'),
    relatedDocument=catalog.documents.find(document=>document.title===titles[2]);
  assert.ok(focusDocument,'focus document is in real catalog');assert.ok(sectionDocument,'type-check document is in real catalog');assert.ok(relatedDocument,'related evidence document is in real catalog');
  host.reviewAdvice.search=async query=>query.includes('orphan')?[{id:relatedDocument.id,path:relatedDocument.path}]:[];
  const findings=await service('reviews');
  const focus=findings.find(item=>item.issue.componentId===focusDocument.id&&item.issue.rule==='orphan');
  const sections=findings.find(item=>item.issue.componentId===sectionDocument.id&&item.issue.rule==='missing-sections');
  assert.ok(focus?.issue.inputRevision,'real lint orphan finding with revision');assert.ok(sections?.issue.inputRevision,'real lint missing-sections finding with revision');
  assert.ok(findings.length>=40,'large real-lint result set');checks.push('real Stele lint populates 40+ isolated review findings, including orphan and missing sections');

  await win.loadFile(path.resolve('dist/renderer/index.html'));
  stage('renderer-loaded');
  await click('打开知识库');await click('知识维护');await click('待核实');
  stage('review-page-opened');
  await until('document.querySelectorAll(".knowledge-review-row").length>0');
  await fill('核实问题类型','orphan');
  await chooseReview(titles[0]);
  await until('document.querySelector(".knowledge-review-preview")?.innerText.includes("controlled vocabulary")');
  const detail=await js('document.querySelector(".knowledge-review-detail").innerText');
  assert.ok(!/孤立文档|orphan\b/i.test(detail),'technical rule key is not the main explanation');
  assert.ok(detail.includes('文档之间的链接'),'plain-language explanation names the review issue');
  assert.equal(await js('[...document.querySelectorAll(".knowledge-review-detail h2")].filter(e=>e.innerText==="Controlled tag taxonomy rollout").length'),1,'title shown once');
  checks.push('search selection shows one title, clear issue explanation and current document preview');
  await shot('review-blue-1500');stage('screenshot-1500');win.setContentSize(2048,980);await pause(180);await shot('review-blue-2048');stage('screenshot-2048');win.setContentSize(1500,980);

  // Advice is read from cache on selection. Model use starts only after the user asks.
  await until('document.querySelector(".knowledge-review-advice")');
  await until('document.querySelector(".knowledge-review-advice button[aria-label=生成处理建议]:not([disabled])")');
  assert.equal(adviceCalls,0,'selecting a review does not automatically call the model');
  await click('生成处理建议');
  await until('document.querySelector(".knowledge-review-advice")?.innerText.includes("适合作为独立记录保留")');
  const focusAdvice=await service('reviewAdvice',{id:focus.id,workspace:focus.workspace,revision:focus.issue.inputRevision});
  assert.equal(adviceCalls,1,'one explicit generation makes one model call');
  assert.ok(focusAdvice&&focusAdvice.cached,'generated advice is served back from version-bound cache');
  assert.equal(focusAdvice.inputRevision,focus.issue.inputRevision);
  assert.ok(focusAdvice.steps.length>=2&&focusAdvice.summary.includes('标签治理'),'advice is specific to the orphan document and offers concrete steps');
  assert.equal(focusAdvice.references.length,1,'the fixture search locates one real, indexed related document');
  const reference=focusAdvice.references[0];
  assert.ok(reference.id===relatedDocument.id&&reference.title===relatedDocument.title&&reference.quote.length>=8,'supporting reference has the real indexed identity and exact original quote');
  assert.ok(await js(`document.querySelector('.knowledge-review-advice').innerText.includes(${JSON.stringify(reference.title)})`),'validated supporting document is visible in the advice');
  await js(`(()=>{const button=[...document.querySelectorAll('.knowledge-review-advice-evidence button')].find(item=>item.innerText.trim()===${JSON.stringify(reference.title)});button?.click();return !!button})()`);
  await until('document.querySelector(".knowledge-reader")');
  await click('知识维护');await click('待核实');await fill('核实问题类型','orphan');await chooseReview(titles[0]);
  await until('document.querySelector(".knowledge-review-advice")?.innerText.includes("适合作为独立记录保留")');
  checks.push('validated related-document citation opens the indexed original');
  await shot('review-blue-advice');
  checks.push('agent advice is opt-in, specific to the finding, tied to the current input revision, and cached');

  await fill('筛选待核实文档','A Controlled Rollout');
  await until('document.querySelectorAll(".knowledge-review-row").length===1');
  assert.ok(await js('document.querySelector(".knowledge-review-row strong").innerText.includes("A Controlled Rollout")'));
  await fill('筛选待核实文档','');
  await fill('核实问题类型','missing-sections');await fill('筛选待核实文档','完整性检查样例');
  await until('document.querySelectorAll(".knowledge-review-row").length===1');
  assert.ok(await js('document.querySelector(".knowledge-review-row strong").innerText.includes("完整性检查样例")'));
  checks.push('search and rule filter find the long English title and missing-sections example');

  // A completion for another row must not paint over the selected document, and is reusable later.
  await fill('核实问题类型','missing-sections');await fill('筛选待核实文档','完整性检查样例');await chooseReview('完整性检查样例');
  await until('document.querySelector(".knowledge-review-advice button[aria-label=生成处理建议]:not([disabled])")');
  await win.webContents.executeJavaScript('window.desktop.setKnowledgeTestMode("defer-advice")');
  await click('生成处理建议');await until('document.querySelector(".knowledge-review-advice")?.innerText.includes("正在生成处理意见")');
  const adviceCallsBeforeDeferred=adviceCalls;assert.ok(adviceCallsBeforeDeferred>=2);
  await fill('核实问题类型','all');await fill('筛选待核实文档','');await chooseReview(titles[2]);
  assert.ok(await js('document.querySelector(".knowledge-review-detail h2").innerText.includes("A Controlled Rollout")'));
  assert.equal(await js('document.querySelector(".knowledge-review-advice")?.innerText.includes("缺少可直接识别的目标、决策和风险要点")'),false,'a slow response for the prior document is never shown for this row');
  await win.webContents.executeJavaScript('window.desktop.setKnowledgeTestMode("release-advice")');
  let deferredCache=null;for(let untilCache=Date.now()+20000;Date.now()<untilCache&&!deferredCache;){await pause(120);deferredCache=await service('reviewAdvice',{id:sections.id,workspace:sections.workspace,revision:sections.issue.inputRevision});}
  assert.ok(deferredCache&&deferredCache.cached,'the completed background response is stored while another document is open');
  assert.equal(adviceCalls,adviceCallsBeforeDeferred,'switching away did not duplicate generation');
  await fill('核实问题类型','missing-sections');await fill('筛选待核实文档','完整性检查样例');await chooseReview('完整性检查样例');
  await until('document.querySelector(".knowledge-review-advice")?.innerText.includes("缺少可直接识别的目标、决策和风险要点")');
  assert.equal(adviceCalls,adviceCallsBeforeDeferred,'returning to the review uses cached advice');
  await shot('review-blue-advice-missing-sections');
  checks.push('switching reviews during generation keeps advice scoped to its original revision and reuses the resulting cache');

  // Fail once and recover by explicit retry.
  await fill('核实问题类型','all');await fill('筛选待核实文档','');await chooseReview(titles[2]);
  await until('document.querySelector(".knowledge-review-advice button[aria-label=生成处理建议]:not([disabled])")');
  await win.webContents.executeJavaScript('window.desktop.setKnowledgeTestMode("fail-advice")');
  await click('生成处理建议');await until('document.querySelector(".knowledge-review-advice-error")');
  assert.ok(await js('document.querySelector(".knowledge-review-advice-error").innerText.includes("fixture")'),'the failure is visible and localized to the advice section');
  await click('重试');await until('document.querySelector(".knowledge-review-advice")?.innerText.includes("A Controlled Rollout")');
  assert.equal(adviceCalls,adviceCallsBeforeDeferred+2,'failure and retry create two explicit requests');
  checks.push('agent failure is visible, retry succeeds, and no partial output is mistaken for a completed suggestion');

  // Exercise responsive navigation and real accessible control visibility at shipped widths.
  await fill('核实问题类型','all');await fill('筛选待核实文档','');await chooseReview(titles[1]);await shot('review-blue-all');
  for(const [width,name] of [[960,'960'],[375,'375']]){win.setContentSize(width,844);await pause(200);assert.ok(await js('document.querySelector(".knowledge-review-detail h2").getClientRects().length'));await shot('review-'+name);}
  win.setContentSize(1500,980);
  for(const scheme of ['classic','blue','folio','pixel'])for(const theme of ['light','dark']){
   await fill('视觉主题',scheme);await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await pause(180);await shot(`review-${scheme}-${theme}`);
  }
  checks.push('1500, 960 and 375 px layouts remain readable across all eight theme variants');

  await chooseReview(titles[0]);await click('查看原文');await until('document.querySelector(".knowledge-reader .markdown-engine")?.innerText.includes("controlled vocabulary")');checks.push('open original navigates to the real indexed document');

  await click('知识维护');await click('待核实');await fill('核实问题类型','orphan');await chooseReview(titles[0]);await click('忽略此版本');
  await until('document.querySelector(".knowledge-operation-message")?.innerText.includes("已忽略此版本")');
  assert.equal((await service('reviews')).find(item=>item.id===focus.id)?.dismissed,true);
  assert.equal(await js('document.querySelectorAll(".knowledge-review-row").length'),findings.filter(r=>r.issue.rule==='orphan').length-1);
  await js('[...document.querySelectorAll(".knowledge-reviews input[type=checkbox]")].find(e=>e.parentElement.innerText.includes("包含已忽略")).click()');
  await until('document.querySelectorAll(".knowledge-review-row").length=== '+findings.filter(r=>r.issue.rule==='orphan').length);
  assert.ok(await js('document.querySelector(".knowledge-review-row[aria-current=true]")?.innerText.includes("已忽略")'));
  checks.push('real revision-bound dismiss persists and can be shown with 包含已忽略');

  await chooseReview(titles[2]);await click('转为待办');await until('document.querySelector(".knowledge-operation-message")?.innerText.includes("已转为待办")');
  assert.ok((await service('todos',{workspace:library.alias})).items.length>0);checks.push('todo action creates a real revision-linked review task');

  await win.webContents.executeJavaScript('window.desktop.setKnowledgeTestMode("missing-revision")');
  await until('document.querySelector("button[aria-label=刷新待核实列表]:not([disabled])")');
  await click('刷新待核实列表');await until('document.querySelector(".knowledge-operation-error")?.innerText.includes("检查版本")');
  await chooseReview(titles[0]);
  assert.ok(await js('document.querySelector(".knowledge-operation-error")?.innerText.includes("检查版本")'));
  assert.equal(await js('[...document.querySelectorAll(".knowledge-review-detail button")].some(b=>["忽略此版本","转为待办"].includes(b.innerText.trim())&&!b.disabled)'),false);
  assert.equal(await js('[...document.querySelectorAll(".knowledge-review-advice button")].some(b=>/生成处理建议|重新生成建议/.test(b.innerText.trim())&&!b.disabled)'),false,'advice cannot be generated for an unversioned finding');
  assert.equal(await js('[...document.querySelectorAll(".knowledge-review-detail button")].some(b=>b.innerText.trim()==="删除文档"&&b.disabled)'),true,'delete is disabled when the finding has no input revision');
  await until('document.querySelector(".knowledge-review-preview .markdown-engine")?.innerText.includes("controlled vocabulary")');
  checks.push('missing inputRevision explains why version-bound actions are unavailable');

  // Deletion uses isolated managed documents and runs after every legacy review assertion.
  // Cancel must leave both the catalog entry and its managed projection untouched.
  await win.webContents.executeJavaScript('window.desktop.setKnowledgeTestMode("restore-revision")');
  await click('刷新待核实列表');
  await fill('核实问题类型','all');await fill('筛选待核实文档','');await chooseReview(titles[0]);
  const focusBeforeDelete=host.store.doc(focusDocument.id),focusPath=host.store.describe(focusBeforeDelete).path,
    focusRevisionPath=host.store.revisionPath(focusBeforeDelete.id,focusBeforeDelete.revision);
  assert.ok(fs.existsSync(focusPath),'cancel fixture has a real managed document projection');
  assert.ok(fs.existsSync(focusRevisionPath),'cancel fixture has a retained revision before the decision');
  await click('删除文档');
  await until('document.querySelector("[role=dialog] h2")?.innerText==="删除这篇文档？"');
  await until('[...document.querySelectorAll("[role=dialog] button")].some(b=>b.innerText.trim()==="确认删除"&&!b.disabled)');
  const readDeleteButtonStyle='(()=>{const b=[...document.querySelectorAll("[role=dialog] button")].find(x=>x.innerText.trim()==="确认删除"),s=getComputedStyle(b),face=getComputedStyle(b,"::before");return {foreground:s.color,faceBackground:face.backgroundColor,faceBorder:face.borderColor,tone:b.getAttribute("data-tone")||b.className}})()';
  const pixelDarkStyle=await js(readDeleteButtonStyle);
  pixelDarkStyle.contrast=contrastRatio(pixelDarkStyle.foreground,pixelDarkStyle.faceBackground);
  assert.ok(pixelDarkStyle.contrast>=4.5,`Pixel dark delete confirmation contrast ${pixelDarkStyle.contrast}:1 is below 4.5:1`);
  await shot('review-delete-confirm');
  await fill('视觉主题','blue');await js('document.documentElement.dataset.theme="light"');
  const blueLightStyle=await js(readDeleteButtonStyle);blueLightStyle.contrast=contrastRatio(blueLightStyle.foreground,blueLightStyle.faceBackground);
  assert.ok(blueLightStyle.contrast>=4.5,`Blue light delete confirmation contrast ${blueLightStyle.contrast}:1 is below 4.5:1`);
  deleteConfirmStyle={pixelDark:pixelDarkStyle,blueLight:blueLightStyle};
  stage('delete-confirm-style '+JSON.stringify(deleteConfirmStyle));
  await shot('review-delete-confirm-blue-light');
  await fill('视觉主题','pixel');await js('document.documentElement.dataset.theme="dark"');
  for(const [width,name] of [[960,'960'],[375,'375']]){win.setContentSize(width,844);await pause(200);await shot('review-delete-confirm-'+name);}
  win.setContentSize(1500,980);await pause(180);
  await clickDialog('取消');
  await until('!document.querySelector("[role=dialog]")');
  assert.ok((await service('catalog',{refresh:true})).documents.some(document=>document.id===focusDocument.id),'cancel keeps the document in the catalog');
  assert.ok(fs.existsSync(focusPath),'cancel leaves the managed document at its original path');
  assert.ok((await service('reviews')).some(item=>item.issue.componentId===focusDocument.id),'cancel leaves this document\'s review findings intact');
  checks.push('canceling document deletion leaves the managed file, catalog, and review findings intact');

  // Change a separate disposable managed document after opening confirmation. The old
  // revision must be rejected and the dialog must remain available to explain the error.
  await chooseReview('完整性检查样例');
  const staleFinding=(await service('reviews')).find(item=>item.issue.componentId===sectionDocument.id&&item.issue.rule==='missing-sections');
  assert.ok(staleFinding?.issue.inputRevision,'stale-version fixture has a versioned review finding');
  await click('删除文档');
  await until('document.querySelector("[role=dialog] h2")?.innerText==="删除这篇文档？"');
  const staleDocument=host.store.doc(sectionDocument.id),stalePath=host.store.describe(staleDocument).path,
    staleBytes=fs.readFileSync(stalePath,'utf8');
  await until('[...document.querySelectorAll("[role=dialog] button")].some(b=>b.innerText.trim()==="确认删除"&&!b.disabled)');
  await host.store.write({library:library.id,relative:'设计/完整性检查样例.md',content:staleBytes+'\n<!-- fixture version changed after confirmation opened -->\n',expected:staleDocument.revision});
  await clickDialog('确认删除');
  await until('document.querySelector("[role=dialog] .knowledge-operation-error")?.innerText.length>0');
  assert.ok(await js('(()=>{const text=document.querySelector("[role=dialog]")?.innerText||"";return /变化|版本|更新|重新核对|重新检查/.test(text)})()'),'expired input revision is explained inside the still-open confirmation dialog');
  assert.ok(await js('!!document.querySelector("[role=dialog]")'),'a rejected stale delete keeps the confirmation dialog open');
  assert.ok((await service('catalog',{refresh:true})).documents.some(document=>document.id===sectionDocument.id),'stale-version rejection preserves the catalog record');
  assert.ok(fs.existsSync(stalePath),'stale-version rejection preserves the managed projection');
  await clickDialog('取消');await until('!document.querySelector("[role=dialog]")');
  checks.push('confirming with an expired revision keeps the dialog open and preserves the changed document');

  // A successful delete removes only the selected managed document. Native reindexing
  // clears its review records; revision history and a related document remain available.
  await chooseReview(titles[0]);
  const deletingDocument=host.store.doc(focusDocument.id),deletingPath=host.store.describe(deletingDocument).path,
    retainedRevision=deletingDocument.revision,retainedRevisionPath=host.store.revisionPath(deletingDocument.id,retainedRevision);
  assert.ok(fs.existsSync(deletingPath)&&fs.existsSync(retainedRevisionPath),'success fixture has both a managed projection and a revision');
  assert.ok((await service('reviews')).some(item=>item.issue.componentId===focusDocument.id),'success fixture starts with at least one review for the selected document');
  await click('删除文档');await until('document.querySelector("[role=dialog] h2")?.innerText==="删除这篇文档？"');
  await until('[...document.querySelectorAll("[role=dialog] button")].some(b=>b.innerText.trim()==="确认删除"&&!b.disabled)');
  await clickDialog('确认删除');
  await until('!document.querySelector("[role=dialog]")&&![...document.querySelectorAll(".knowledge-review-row strong")].some(e=>e.innerText==="Controlled tag taxonomy rollout")');
  const catalogAfterDelete=await service('catalog',{refresh:true}),reviewsAfterDelete=await service('reviews');
  const relatedPath=host.store.describe(host.store.doc(relatedDocument.id)).path,
    survivingSectionPath=host.store.describe(host.store.doc(sectionDocument.id)).path,
    tombstone=host.store.tombstone(deletingDocument.id);
  assert.equal(catalogAfterDelete.documents.some(document=>document.id===focusDocument.id),false,'successful delete removes the document from the active catalog');
  assert.equal(reviewsAfterDelete.some(item=>item.issue.componentId===focusDocument.id),false,'successful delete and native rebuild clear every review finding for that document');
  assert.equal(fs.existsSync(deletingPath),false,'successful delete removes the managed file from its original projection path');
  assert.ok(fs.existsSync(retainedRevisionPath),'successful delete retains the original version history');
  assert.ok(tombstone,'successful delete creates an internal recovery record');
  assert.ok(fs.existsSync(path.join(host.store.root,...tombstone.trash_relative.split('/'))),'the deleted managed projection is retained in internal trash');
  assert.ok(catalogAfterDelete.documents.some(document=>document.id===relatedDocument.id),'the related evidence document remains in the catalog');
  assert.ok(fs.existsSync(relatedPath),'the related evidence document file remains untouched');
  assert.ok(catalogAfterDelete.documents.some(document=>document.id===sectionDocument.id),'the separate stale-version fixture remains in the catalog');
  assert.ok(fs.existsSync(survivingSectionPath),'the separate stale-version fixture file remains untouched');
  checks.push('confirmed deletion removes the document and its review findings, preserves its revision, and leaves related documents intact');

  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,findings:findings.length,isolated:true,deleteConfirmStyle},null,2));
 }catch(error){console.error(error.stack);const body=win?.webContents.getURL().startsWith('file:')?await Promise.race([js('document.body.innerText').catch(()=>''),pause(1000).then(()=>'')]):'';if(win?.webContents.getURL())fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.stack,errors,body},null,2));app.exitCode=1;
 }finally{clearTimeout(timer);win?.destroy();await host?.stop();app.exit(app.exitCode||0);}
});
