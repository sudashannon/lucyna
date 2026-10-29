const path=require('node:path'),fs=require('node:fs/promises'),{randomUUID}=require('node:crypto');
const {publishRenderer}=require('./publish-renderer.cjs');
async function main(){
 const root=path.resolve(__dirname,'..'),staged=path.join(root,'.runtime','renderer-build-'+randomUUID());
 const {build}=await import('vite');
 await build({configFile:path.join(root,'vite.config.ts'),build:{outDir:staged,emptyOutDir:true}});
 await fs.mkdir(path.join(staged,'third-party'),{recursive:true});
 await fs.copyFile(path.join(root,'src/assets/fonts/LICENSE.txt'),path.join(staged,'third-party/SourceHanSans-LICENSE.txt'));
 const result=await publishRenderer(staged,path.join(root,'dist/renderer'));
 console.log(`Renderer published: ${result.added} new files, ${result.retained} unchanged. Existing window assets retained.`);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
