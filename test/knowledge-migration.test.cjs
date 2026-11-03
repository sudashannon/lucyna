const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {migrate}=require('../tools/migrate-wsl-knowledge.cjs'),{KnowledgeLibrary,hash}=require('../src/knowledge-library.cjs');
test('legacy migration copies registered Markdown closure, rewrites cross-library links, preserves metadata and is idempotent',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-migration-')),store=new KnowledgeLibrary(directory);t.after(()=>store.close());
 const source=new Map(Object.entries({
  '/legacy/a/docs/one.md':'# one\n[two](/legacy/b/two.md)\n![plot](/legacy/b/plot.png)\n[linked](linked.md)\n```md\n[secret](../.env)\n```',
  '/legacy/a/docs/linked.md':'# linked\n![figure](nested/figure.png)',
  '/legacy/a/docs/nested/figure.png':'fixture-figure','/legacy/b/two.md':'# two','/legacy/b/plot.png':'fixture-image',
  '/legacy/a/.comet.yaml':'status: done','/legacy/a/private.md':'password: FixtureSecret!987',
 }));const original=new Map(source),requests=[];
 const spaces=[{alias:'a',path:'/legacy/a/openspec',type:'openspec'},{alias:'b',path:'/legacy/b',type:'docs'}];
 const index=[{workspace:'a',path:'/legacy/a/docs/one.md',type:'knowledge'},{workspace:'b',path:'/legacy/b/two.md',type:'report'},{workspace:'a',path:'/legacy/a/.comet.yaml',type:'change'},{workspace:'a',path:'/legacy/a/private.md',type:'knowledge'},{workspace:'b',path:'/legacy/b/session.jsonl',type:'session'}];
 const fetchSource=async(url,limit,method)=>{requests.push(String(url));const u=new URL(url);if(u.pathname==='/api/workspaces')return {bytes:Buffer.from(JSON.stringify(spaces))};if(u.pathname==='/api/wiki/index')return {bytes:Buffer.from(JSON.stringify(index))};if(u.pathname==='/api/recovery/export')return {bytes:Buffer.from('fixture archive')};const file=u.searchParams.get('path'),value=source.get(file);if(value===undefined)throw Error('not found');return {bytes:method==='HEAD'?undefined:Buffer.from(value),etag:hash(value)};};
 const runtime={ensure:async()=>{},call:async(route,options)=>{
  if(route==='/api/library/libraries')return options?store.create(options.body.name,options.body.alias):store.list();
  if(route==='/api/wiki/index')return store.db.prepare('SELECT * FROM documents').all().filter(d=>/\.md$/i.test(d.relative)).map(d=>store.describe(d));
  if(route==='/api/library/batch'){const items=[];for(const item of options.body.items){const bytes=Buffer.from(item.base64,'base64'),old=store.db.prepare('SELECT * FROM documents WHERE library=? AND relative=?').get(item.library,item.relative);if(old?.hash===hash(bytes))items.push({...store.describe(old),status:'skipped'});else items.push({...await store.write({...item,bytes}),status:'imported'});}return {items};}
  throw Error(route);
 }};
 const preview=await migrate({directory,fetchSource,runtime});assert.equal(preview.copied,0);assert.ok(fs.existsSync(preview.reportPath));assert.equal(store.list().length,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM documents').get().n,0);
 const result=await migrate({directory,apply:true,fetchSource,runtime});
 assert.equal(result.failed,0);assert.equal(result.excluded.length,2);assert.equal(result.hashMismatches.length,0);assert.equal(result.notIndexed.length,0);assert.equal(result.destinationVerified,7);
 const one=store.read(result.mapping['/legacy/a/docs/one.md'].id);assert.match(one.content,/\.\.\/\.\.\/\.\.\//);assert.match(one.content,/_legacy-assets/);assert.equal(one.provenance.originalHash,hash(source.get('/legacy/a/docs/one.md')));
 assert.ok(result.mapping['/legacy/a/docs/nested/figure.png']);assert.equal(requests.some(url=>url.includes('%2F.env')),false);assert.deepEqual(source,original);
 const retry=await migrate({directory,apply:true,fetchSource,runtime});assert.equal(retry.copied,0);assert.equal(retry.unchanged,7);assert.equal(store.list().filter(l=>l.alias.startsWith('wsl-')).length,2);
 fs.writeFileSync(one.path,'outside edit, preserve for review');
 const checked=await migrate({directory,apply:true,fetchSource:async(url,limit,method)=>{const result=await fetchSource(url,limit,method);if(method==='HEAD'&&new URL(url).searchParams.get('path')==='/legacy/a/docs/one.md')return {...result,etag:'changed-source-version'};return result;},runtime});
 assert.ok(checked.sourceChanged.includes('/legacy/a/docs/one.md'));assert.ok(checked.hashMismatches.includes('/legacy/a/docs/one.md'));assert.equal(fs.readFileSync(one.path,'utf8'),'outside edit, preserve for review');
});
