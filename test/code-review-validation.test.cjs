const test=require('node:test'),assert=require('node:assert/strict');
const {freezeSnapshot,validateFindings,validateSource}=require('../src/code-review.cjs');
const patch='diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -2,2 +2,2 @@\n-return false;\n+return true;\n export {};\n';
const raw=files=>({files,warnings:[],partial:false,capturedAt:42});
const file=(more={})=>({member:'app',path:'a.js',scope:'staged',patch,...more});

test('snapshot separates same paths by repository and index/worktree, and digest ignores capture time',()=>{
  const input=raw([file(),file({scope:'unstaged'}),file({member:'tools'})]);
  const one=freezeSnapshot(input,'/work'),two=freezeSnapshot({...input,capturedAt:99},'/work');
  assert.equal(new Set(one.files.map(f=>f.id)).size,3);assert.equal(one.id,two.id);
  assert.throws(()=>freezeSnapshot(raw([file(),file()]),'/work'),/重复/);
  assert.throws(()=>freezeSnapshot(raw([file({path:'../outside'})]),'/work'),/路径/);
  assert.throws(()=>validateSource({kind:'workspace',root:'/work',member:'app',scope:'all',hostId:'remote'}),/本机/);
});

test('excluded or oversized patch content never enters a saved snapshot or model input',()=>{
  const secret='ghp_'+'a'.repeat(40);
  const snapshot=freezeSnapshot(raw([file({path:'.env',patch:patch+secret}),file({path:'big.js',patch:patch+'x'.repeat(65536)}),file()]),'/work');
  assert.equal(snapshot.partial,true);assert.equal(snapshot.files.filter(f=>f.omitted).length,2);
  assert.ok(!JSON.stringify(snapshot).includes(secret));assert.equal(snapshot.files[2].patch,patch);
  for(const literal of ['password = "abc123!"','API_KEY="sample-api-123456789"','access_token = "token_123456789"']){
    const checked=freezeSnapshot(raw([file({path:'src/auth.ts',patch:patch+'+'+literal+'\n'})]),'/work');
    assert.equal(checked.files[0].omitted,true);assert.ok(!JSON.stringify(checked).includes(literal));
  }
});

test('unverifiable evidence fails atomically; invalid new-side lines become file-level with explanation',()=>{
  const snapshot=freezeSnapshot(raw([file()]),'/work');
  const finding={fileId:snapshot.files[0].id,severity:'high',title:'条件失效',body:'更改后条件始终为真。',evidence:'return true;',lineStart:2,lineEnd:2};
  const valid=validateFindings([finding,finding],snapshot);assert.equal(valid.findings.length,1);assert.equal(valid.findings[0].lineStart,2);
  for(const bad of [{fileId:'other'},{evidence:'invented code'},{severity:'critical'}])assert.throws(()=>validateFindings([finding,{...finding,...bad}],snapshot));
  const misplaced=validateFindings([{...finding,lineStart:100}],snapshot);
  assert.equal(misplaced.findings[0].lineStart,undefined);assert.equal(misplaced.warnings.length,1);
  assert.throws(()=>validateFindings(undefined,snapshot),/格式/);
});
