const {test}=require('node:test'),assert=require('node:assert/strict');
const {rankSearchResults,excerptFromSnapshot}=require('../src/knowledge-search.cjs');
const {createKnowledgeService}=require('../src/knowledge-service.cjs');
const documents=[
  {id:'diagnosis',path:'/wiki/diagnosis.md',workspace:'pico',title:'PICO 图传中断排查',type:'knowledge',updatedAt:'2026-10-30T00:00:00Z'},
  {id:'release',path:'/wiki/release.md',workspace:'pico',title:'PICO 客户端发布',type:'knowledge'},
  {id:'semantic',path:'/wiki/semantic.md',workspace:'pico',title:'网络观测记录',type:'knowledge'},
  {id:'foreign',path:'/other/doc.md',workspace:'other',title:'PICO 图传中断',type:'knowledge'},
  {id:'session',path:'/session/log',workspace:'pico',title:'PICO 会话',type:'session'},
];
test('question ranking promotes a missing direct diagnosis, preserves semantic alternatives and respects source scope',()=>{
  const results=documents.slice(1).map((d,i)=>({...d,rankScore:100-i,reasons:['semantic-match']}));
  const ranked=rankSearchResults(results,documents,'PICO 图传中断','pico');
  assert.deepEqual(ranked.map(r=>r.id),['diagnosis','release','semantic']);
  assert.equal(ranked[0].updatedAt,documents[0].updatedAt);
  assert.ok(ranked[0].matchedTerms.includes('pico'));
  assert.ok(ranked[0].matchedTerms.includes('图传中断'));
  assert.equal(ranked[2].keywordScore,0);
});
test('excerpts skip YAML and headings while preserving exact CRLF source line coordinates',()=>{
  const source='\uFEFF---\r\ntitle: PICO 图传中断\r\ntags: [PICO, 图传]\r\n---\r\n# PICO 图传中断\r\n\r\n部署准备。\r\n\r\n图传中断时先检查 PICO 的 EOS 日志。\r\n同时检查控制连接状态。\r\n\r\n其他说明';
  const ref=excerptFromSnapshot(source,'PICO 图传中断');
  assert.equal(ref.lineStart,9);assert.equal(ref.lineEnd,10);assert.equal(ref.bodyMatch,true);
  assert.equal(ref.excerpt,source.split('\n').slice(ref.lineStart-1,ref.lineEnd).join('\n'));
  assert.ok(!ref.excerpt.includes('title:'));
});
test('fallback excerpt is explicitly unmatched; metadata-only documents never fabricate body lines',()=>{
  const fallback=excerptFromSnapshot('---\ntitle: PICO\n---\n# PICO\n\n一般部署说明。','图传中断');
  assert.equal(fallback.bodyMatch,false);assert.equal(fallback.lineStart,6);
  const empty=excerptFromSnapshot('---\ntitle: PICO\n---\n# PICO\n','PICO');
  assert.equal(empty.excerpt,'');assert.equal(empty.lineStart,undefined);
});
test('search evidence resolves indexed paths, matches snapshot version and rejects cross-source or unindexed access',async()=>{
  const calls=[],content='---\ntitle: PICO\n---\n# PICO\n\nPICO 图传中断时检查 EOS。';
  const service=createKnowledgeService(async(url,options={})=>{
    calls.push({url,options});
    if(url.pathname==='/api/workspaces')return Response.json([{alias:'pico',path:'/wiki'},{alias:'other',path:'/other'}]);
    if(url.pathname==='/api/wiki/index')return Response.json(documents);
    if(url.pathname==='/api/wiki/search-semantic')return Response.json(documents.slice(1));
    if(url.pathname==='/api/artifact')return new Response(content);
    throw Error('Unexpected '+url.pathname);
  });
  const result=await service('search',{query:'PICO 图传中断',workspace:'pico'});
  assert.equal(result[0].id,'diagnosis');
  const ref=await service('searchEvidence',{id:'diagnosis',workspace:'pico',query:'PICO 图传中断',path:'/etc/passwd'});
  assert.equal(calls.at(-1).url.searchParams.get('path'),'/wiki/diagnosis.md');
  assert.equal(ref.lineStart,6);assert.equal(ref.excerpt,'PICO 图传中断时检查 EOS。');
  const snapshot=await service('snapshot',{id:'diagnosis'});assert.equal(ref.version,snapshot.version);
  const before=calls.filter(c=>c.url.pathname==='/api/artifact').length;
  for(const args of [{id:'diagnosis',workspace:'other'},{id:'/etc/passwd',workspace:'pico'},{id:'session',workspace:'pico'}])await assert.rejects(service('searchEvidence',{query:'PICO',...args}),/已索引/);
  assert.equal(calls.filter(c=>c.url.pathname==='/api/artifact').length,before);
});
