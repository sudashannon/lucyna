const {test}=require('node:test'),assert=require('node:assert/strict');
const {rewriteLinks}=require('../src/knowledge-layout-links.cjs');
test('rewrites local document and image targets without touching code blocks or remote links',async()=>{
 const body='[doc](../notes/a.md#part) ![img](../images/x.png) [remote](https://example.com/a)\n\n```md\n[x](../notes/a.md)\n```';
 const result=await rewriteLinks(body,{old:'lib/docs/a.md',next:'lib/知识/a.md'},new Map([['lib/notes/a.md','lib/报告/b.md'],['lib/images/x.png','lib/资料/x.png']]));
 assert.equal(result.rewritten,2);assert.ok(result.content.includes('../%E6%8A%A5%E5%91%8A/b.md#part'));assert.ok(result.content.includes('```md\n[x](../notes/a.md)'));assert.ok(result.content.includes('https://example.com/a'));assert.deepEqual(result.unresolved,[]);
});
test('unknown links remain in place and are reported',async()=>{const x=await rewriteLinks('[old](missing.md)',{old:'a/x.md',next:'a/知识/x.md'},new Map());assert.equal(x.content,'[old](missing.md)');assert.deepEqual(x.unresolved,['missing.md']);});
