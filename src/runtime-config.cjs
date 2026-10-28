// Machine configuration is deliberately separate from source and OMP credentials.
const fs=require('node:fs'),path=require('node:path');
function validateRuntime(input={}){
 const distro=input.distro||'Ubuntu-22.04',user=input.user||'user';
 if(!/^[A-Za-z0-9._-]+$/.test(distro)||! /^[a-z_][a-z0-9_-]*\$?$/i.test(user))throw Error('Invalid WSL distribution or user');
 const absolute=(value,label)=>{if(typeof value!=='string'||!value.startsWith('/')||/[\0\r\n\\]/.test(value)||value.split('/').some(x=>x==='..'||x==='.'))throw Error('Invalid Linux path: '+label);return value.replace(/\/$/,'');};
 const home=absolute(input.home||'/home/'+user,'home'),workRoot=absolute(input.workRoot||home+'/work','workRoot');
 const wslAgentDir=absolute(input.wslAgentDir||home+'/.omp/agent','wslAgentDir');
 return Object.freeze({distro,user,home,workRoot,wslAgentDir,wslExecutable:absolute(input.wslExecutable||'/home/linuxbrew/.linuxbrew/bin/omp','wslExecutable'),skillDirectory:absolute(input.skillDirectory||home+'/.agents/skills','skillDirectory'),defaultRuntime:input.defaultRuntime==='windows'?'windows':'wsl',windowsProviderHook:input.windowsProviderHook===true,installWorkIntegration:input.installWorkIntegration===true});
}
const file=process.env.LUCYNA_CONFIG||path.resolve(__dirname,'../runtime.local.json');
let raw={};try{raw=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Cannot read runtime configuration: '+file);}
const runtime=validateRuntime(raw);
function fromWslUnc(value){if(typeof value!=='string')return null;const match=/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/i.exec(value.replaceAll('/','\\'));return match&&match[1].toLowerCase()===runtime.distro.toLowerCase()?'/'+match[2].replaceAll('\\','/'):null;}
module.exports={...runtime,wslPrefix:['-d',runtime.distro,'-u',runtime.user],fromWslUnc,validateRuntime};
