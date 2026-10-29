const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
async function files(directory){const result=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Build output must not contain symbolic links');if(entry.isDirectory())result.push(...await files(file));else if(entry.isFile())result.push(file);}return result;}
async function atomicWrite(file,bytes){
 await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
 try{await fs.writeFile(temp,bytes,{flag:'wx'});for(let attempt=0;;attempt++){try{await fs.rename(temp,file);break;}catch(e){if(attempt>=3||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,50*2**attempt));}}}
 finally{await fs.unlink(temp).catch(()=>{});}
}
async function publishRenderer(staged,destination){
 const source=path.resolve(staged),target=path.resolve(destination);if(source===target)throw Error('Build must be staged outside the live renderer');
 const html=await fs.readFile(path.join(source,'index.html'));
 if(!html.includes(Buffer.from('</html>')))throw Error('Incomplete renderer entry point');
 const entries=await files(source);let added=0,retained=0;
 for(const file of entries){
  const relative=path.relative(source,file);if(relative==='index.html')continue;
  const dest=path.join(target,relative),content=await fs.readFile(file);let existing;
  try{existing=await fs.readFile(dest);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing?.equals(content)){retained++;continue;}
  // Hashed files referenced by an open window are immutable. An unexpected
  // collision must fail before switching HTML, never silently alter old code.
  if(existing&&relative.startsWith('assets'+path.sep))throw Error('Conflicting renderer asset: '+relative);
  await atomicWrite(dest,content);added++;
 }
 // Only new launches use the new entry. All older chunks remain available to
 // existing windows, including lazy images, Markdown plugins and fonts.
 await atomicWrite(path.join(target,'index.html'),html);
 return {added,retained};
}
module.exports={publishRenderer};
