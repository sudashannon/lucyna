const {spawn}=require('node:child_process');
const path=require('node:path');
const runtime=require('./runtime-config.cjs');
const READS=new Set(['snapshot','patches','network','operations','operation','acknowledge','disk']);
const LIFECYCLE=new Set(['branch-create','branch-switch','branch-merge','worktree-create','worktree-move','worktree-remove']);
const ACTIONS=new Set([...READS,...LIFECYCLE,'stage','unstage','stage-selection','unstage-selection','commit','fetch','push']);
function validate(root,member,action,options){
  if(typeof root!=='string'||root.length>4096||!root.startsWith('/')||/[\0\r\n]/.test(root))throw Error('无效工作根');
  if(typeof member!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(member))throw Error('无效 Git 成员');
  if(!ACTIONS.has(action))throw Error('不支持的 Git 操作');
  if(!options||typeof options!=='object'||Array.isArray(options)||Buffer.byteLength(JSON.stringify(options))>300000)throw Error('Git 参数超过上限');
  const allowed=new Set(['file','scope','expected','operationId','selection','message','remote','branch','name','lfsMode']);
  if(Object.keys(options).some(k=>!allowed.has(k)))throw Error('不支持的 Git 参数');
  if('lfsMode' in options&&(action!=='worktree-create'||!['normal','review'].includes(options.lfsMode)))throw Error('无效 LFS 检出方式');
  if(action==='disk'&&Object.keys(options).length)throw Error('占用统计不接受额外参数');
  for(const [k,v]of Object.entries(options)){
    if(k==='selection'){if(!Array.isArray(v)||v.length>6000||v.some(x=>typeof x!=='string'||! /^\d+:\d+$/.test(x)))throw Error('无效差异选区');}
    else if(typeof v!=='string'||v.includes('\0')||v.length>(k==='message'?20000:k==='file'?4096:512))throw Error('无效 Git 参数');
  }
  if(!READS.has(action)&&(! /^[A-Za-z0-9_-]{8,100}$/.test(options.operationId||'')||! /^[a-f0-9]{64}$/.test(options.expected||'')))throw Error('请刷新仓库后操作');
}
const wslPath=file=>runtime.fromWslUnc(file)||file.replace(/^([A-Za-z]):/,(_,d)=>'/mnt/'+d.toLowerCase()).replaceAll('\\','/');
function createGitService({listWorks,execute=spawn,lifecycle=(_root,run)=>run(),state,runnerState}){
  return async(root,member,action,options={})=>{
    validate(root,member,action,options);
    if(!(await listWorks()).some(w=>w.root===root&&w.kind!=='invalid'))throw Error('无效工作根');
    const run=()=>new Promise((resolve,reject)=>{
      const disk=action==='disk';
      const command=disk?['timeout','60s','python3',runtime.skillDirectory+'/worktree-session/scripts/worktree-disk.py','members','--json','--',root]
        :['python3',wslPath(path.join(__dirname,'git_workspace.py'))];
      const child=execute('wsl.exe',[...runtime.wslPrefix,'--exec',...command],{stdio:['pipe','pipe','pipe'],windowsHide:true});
      let out='',err='',finished=false;
      const fail=error=>{if(!finished){finished=true;reject(error);}};
      child.on('error',fail);child.stdin.on('error',fail);
      child.stdout.on('data',chunk=>{out+=chunk.toString();if(Buffer.byteLength(out)>2*1024*1024){child.kill();fail(Error('Git 返回内容超过上限；写操作请核对结果'));}});
      child.stderr.on('data',chunk=>{if(err.length<12000)err+=chunk.toString();});
      child.on('close',code=>{if(finished)return;finished=true;
        if(disk&&code){reject(Error(code===124?'占用统计超时，请重试':'占用统计失败，请检查 WSL Work 技能和成员登记'));return;}
        try{const result=JSON.parse(out);if(result.error)reject(Error(result.error));else if(code)reject(Error('Git 服务中断，请核对操作结果'));else resolve(result);}catch{reject(Error(err||'Git 服务中断，请核对操作结果'));}
      });
      // Arguments and commit messages are JSON stdin, never shell source.
      child.stdin.end(disk?undefined:JSON.stringify({root,member,action,options,state,runnerState:LIFECYCLE.has(action)?runnerState:undefined}));
    });
    return LIFECYCLE.has(action)?lifecycle(root,run):run();
  };
}
module.exports={createGitService,validate,READS,LIFECYCLE};
