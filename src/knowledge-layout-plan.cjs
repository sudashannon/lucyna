// Pure planning only: never moves, edits, or indexes user data.
const path=require('node:path');
const categories=Object.freeze({knowledge:'知识',spec:'规范',plan:'计划',proposal:'提案',tasks:'任务',report:'报告',design:'设计',diagram:'图表',artifact:'资料'});
function planLayout({libraries,documents,index}){
 if(!Array.isArray(libraries)||!Array.isArray(documents)||!Array.isArray(index))throw Error('无效的知识库清单');
 const indexByPath=new Map(index.filter(x=>typeof x.path==='string').map(x=>[path.resolve(x.path).toLowerCase(),x]));
 const usedLibraries=new Set(),usedPaths=new Set(),items=[],spaces=[];
 for(const lib of libraries){
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(lib.alias))throw Error('知识库标识不能安全用于目录');
  const folder=lib.alias==='personal'?'个人知识库':lib.alias.replace(/^wsl-/,'');
  if(usedLibraries.has(folder.toLowerCase()))throw Error('知识库目录名称冲突');usedLibraries.add(folder.toLowerCase());
  spaces.push({id:lib.id,name:lib.name,alias:lib.alias,folder});
 }
 const byId=new Map(spaces.map(x=>[x.id,x]));
 for(const doc of [...documents].sort((a,b)=>a.id.localeCompare(b.id))){
  const lib=byId.get(doc.library);if(!lib)throw Error('文档所属知识库不存在');
  const relative=String(doc.relative),parts=relative.split('/');if(parts.some(x=>!x||x==='.'||x==='..'||/[\\\0]/.test(x)))throw Error('存在无效的文档路径');
  const legacy=path.join(doc.libraryPath,...parts),entry=indexByPath.get(path.resolve(legacy).toLowerCase());
  const ext=path.extname(relative).toLowerCase(),isMarkdown=['.md','.markdown'].includes(ext),category=isMarkdown?(categories[entry?.type]||'待分类'):'资料';
  const base=path.posix.basename(relative),extension=path.posix.extname(base),stem=base.slice(0,base.length-extension.length);let file=base;
  let key=()=>[lib.folder,category,file].join('/').toLowerCase();
  if(usedPaths.has(key()))file=stem+'-'+doc.id.slice(0,8)+extension;
  if(usedPaths.has(key()))throw Error('文档目标路径冲突');usedPaths.add(key());
  items.push({id:doc.id,library:lib.id,from:relative,to:[lib.folder,category,file].join('/'),type:entry?.type||null,indexed:!!entry});
 }
 return {version:1,libraries:spaces,items};
}
module.exports={planLayout,categories};
