const fs=require('node:fs/promises'),{randomUUID}=require('node:crypto');
// Windows readers and antivirus scanners may briefly hold the connection file.
// Retry only the atomic rename; never relaunch a second host for that condition.
async function publishConnection(file,record,{rename=fs.rename,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const temporary=file+'.'+randomUUID()+'.tmp';
 try{await fs.writeFile(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'});
  for(let attempt=0;;attempt++)try{await rename(temporary,file);return;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=7)throw error;await pause(Math.min(25*2**attempt,200));}
 }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
module.exports={publishConnection};
