const {execFile}=require('node:child_process');
const path=require('node:path');
const runtime=require('./runtime-config.cjs');
const script=path.join(__dirname,'work-details.py');
const linuxPath=file=>runtime.fromWslUnc(file)||file.replace(/^([A-Za-z]):/,(_,drive)=>'/mnt/'+drive.toLowerCase()).replaceAll('\\','/');
const decode=value=>Buffer.isBuffer(value)?value.toString(value.subarray(0,256).includes(0)?'utf16le':'utf8'):String(value||'');
function createWorkDetails({listWorks,execute=execFile}){
  const pending=new Map();
  return async(root,member,action='details',options={})=>{
    if(typeof root!=='string'||root.length>4096||!root.startsWith('/')||/[\0\r\n]/.test(root))throw Error('无效工作根');
    if(!['details','changes','diff','commits','branches','worktrees','mr','path'].includes(action))throw Error('不支持的 Git 查看操作');
    if(action!=='details'&&(typeof member!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(member)||member.length>200))throw Error('无效成员名称');
    if(options==null||typeof options!=='object')throw Error('无效查看参数');
    if(options.scope&&!['staged','unstaged','baseline'].includes(options.scope))throw Error('无效比较方式');
    if(options.file!=null&&(typeof options.file!=='string'||options.file.length>4096||/[\0\r\n]/.test(options.file)))throw Error('无效文件路径');
    const key=JSON.stringify([root,member,action,options.scope,options.file]);
    if(pending.has(key))return pending.get(key);
    const task=(async()=>{
      // Invalid members remain inspectable so one bad registration does not hide the rest.
      if(!(await listWorks()).some(w=>w.root===root))throw Error('工作根不在当前工作区列表中');
      const args=[...runtime.wslPrefix,'--exec','python3',linuxPath(script),root,'--action',action];
      if(member)args.push('--member',member);
      if(options.scope)args.push('--scope',options.scope);
      if(options.file)args.push('--file',options.file);
      return new Promise((resolve,reject)=>execute('wsl.exe',args,{windowsHide:true,timeout:90000,maxBuffer:8*1024*1024,encoding:'buffer'},(error,stdout,stderr)=>{
        if(error)return reject(Error(error.killed?'WSL 读取超时，请稍后重试。已有任务与草稿保持不变。':decode(stderr).trim()||decode(stdout).trim()||'读取工作详情失败，请重试'));
        try{resolve(JSON.parse(decode(stdout)));}catch{reject(Error('工作详情返回内容不完整，请重试'));}
      }));
    })();
    pending.set(key,task);try{return await task;}finally{pending.delete(key);}
  };
}
module.exports={createWorkDetails};
