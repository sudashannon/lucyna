const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {publishRenderer}=require('../tools/publish-renderer.cjs');
test('publishing a new renderer keeps images/chunks already referenced by open windows',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-publish-'));try{
  const staged=path.join(dir,'staged'),target=path.join(dir,'live');await fs.mkdir(path.join(staged,'assets'),{recursive:true});await fs.mkdir(path.join(target,'assets'),{recursive:true});
  await fs.writeFile(path.join(target,'index.html'),'<html>old</html>');await fs.writeFile(path.join(target,'assets','old-cat.png'),'old cat');await fs.writeFile(path.join(target,'assets','old-lazy.js'),'old chunk');await fs.writeFile(path.join(target,'assets','shared.png'),'shared');
  await fs.writeFile(path.join(staged,'index.html'),'<html>new</html>');await fs.writeFile(path.join(staged,'assets','new.js'),'new chunk');await fs.writeFile(path.join(staged,'assets','shared.png'),'shared');
  const before=await fs.stat(path.join(target,'assets','shared.png'));const result=await publishRenderer(staged,target);assert.equal(result.added,1);assert.equal(result.retained,1);assert.equal((await fs.stat(path.join(target,'assets','shared.png'))).mtimeMs,before.mtimeMs);
  assert.equal(await fs.readFile(path.join(target,'assets','old-cat.png'),'utf8'),'old cat');assert.equal(await fs.readFile(path.join(target,'assets','old-lazy.js'),'utf8'),'old chunk');assert.equal(await fs.readFile(path.join(target,'index.html'),'utf8'),'<html>new</html>');
  await fs.writeFile(path.join(staged,'assets','shared.png'),'collision');await fs.writeFile(path.join(staged,'index.html'),'<html>unsafe</html>');await assert.rejects(publishRenderer(staged,target),/Conflicting/);assert.equal(await fs.readFile(path.join(target,'index.html'),'utf8'),'<html>new</html>');assert.equal(await fs.readFile(path.join(target,'assets','shared.png'),'utf8'),'shared');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
