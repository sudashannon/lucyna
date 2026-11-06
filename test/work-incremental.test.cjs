const test=require('node:test'),assert=require('node:assert/strict');
const {sourceKey,sourceHash,findRelatedSources}=require('../src/work-incremental.cjs');
const row=(id,text,extra={})=>({sessionId:'s1',messageId:id,role:'user',text,...extra});

test('source fingerprints track content and role without treating presentation metadata as edits',()=>{
  const original=row('m1','先确认 Python 版本。');
  assert.equal(sourceHash(original),sourceHash({...original,title:'renamed',at:100}));
  assert.notEqual(sourceHash(original),sourceHash({...original,text:'先确认编译器版本。'}));
  assert.notEqual(sourceHash(original),sourceHash({...original,role:'assistant'}));
  assert.notEqual(sourceKey(original),sourceKey({...original,sessionId:'s2'}));
});

test('on-demand retrieval finds older Chinese and English evidence and excludes changed messages',()=>{
  const sources=[row('old','此前确认构建失败由 Python 3.12 环境差异引起。',{at:1}),row('new','本次构建失败，需要继续排查。',{at:9}),row('other','录制视频并导出文件。',{at:10})];
  const found=findRelatedSources(sources,{queries:['构建失败 Python'],excludeKeys:new Set([sourceKey(sources[1])])});
  assert.deepEqual(found.map(item=>item.messageId),['old']);
  assert.deepEqual(findRelatedSources(sources,{queries:['SELinux avb certificate']}),[]);
});

test('retrieval is bounded, deduplicated, immutable and never turns an empty query into a full scan result',()=>{
  const sources=[row('m1','Python build '.repeat(1000)),row('m2','Python decision'),row('m1','Python duplicate')];
  const found=findRelatedSources(sources,{queries:['Python'],maxMessages:1,maxChars:800});
  assert.equal(found.length,1);assert.equal(found[0].text.length,800);assert.equal(found[0].truncated,true);
  assert.equal(sources[0].text.length,13000);assert.notEqual(found[0],sources[0]);
  assert.equal(findRelatedSources(sources,{queries:['Python'],maxChars:24000}).length,2);
  for(const queries of [[],[''],['x'.repeat(241)],['the work session']])assert.deepEqual(findRelatedSources(sources,{queries}),[]);
});
