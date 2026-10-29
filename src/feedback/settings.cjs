const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const defaults=()=>({version:1,mode:'focus',style:'soft',volume:20,completed:true,attention:true,error:true,reducedMotion:false});
function validate(patch,current=defaults()){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('无效的声音与动效设置');
 const next={...current};
 for(const [key,value]of Object.entries(patch)){
  if(!Object.prototype.hasOwnProperty.call(next,key))throw Error('未知的声音与动效设置');
  if(key==='version'&&value!==1||key==='mode'&&!['silent','focus','companion'].includes(value)||key==='style'&&!['soft','pixel'].includes(value))throw Error('声音模式或风格无效');
  if(key==='volume'&&(!Number.isInteger(value)||value<0||value>100))throw Error('音量须为 0–100');
  if(['completed','attention','error','reducedMotion'].includes(key)&&typeof value!=='boolean')throw Error('无效的声音与动效开关');
  next[key]=value;
 }
 return next;
}
class FeedbackPreferences{
 constructor(directory){this.file=path.join(directory,'feedback-settings.json');this.value=defaults();this.pending=Promise.resolve();this.warning='';}
 async load(legacyReducedMotion=false){try{this.value=validate(JSON.parse(await fs.readFile(this.file,'utf8')));}catch(e){if(e.code!=='ENOENT'){this.warning='声音设置无法读取，已暂时静音；原文件保留。';this.value.mode='silent';}else this.value.reducedMotion=!!legacyReducedMotion;}return this.value;}
 save(patch){const job=this.pending.then(async()=>{
  const next=validate(patch,this.value),temp=this.file+'.'+randomUUID()+'.tmp';await fs.mkdir(path.dirname(this.file),{recursive:true});
  try{await fs.copyFile(this.file,this.file+'.bak');}catch(e){if(e.code!=='ENOENT')throw e;}
  try{await fs.writeFile(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx'});await fs.rename(temp,this.file);}finally{await fs.unlink(temp).catch(()=>{});}
  this.value=next;this.warning='';return {...next};
 });this.pending=job.catch(()=>{});return job;}
}
module.exports={defaults,validate,FeedbackPreferences};
