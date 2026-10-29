const test = require('node:test');
const assert = require('node:assert/strict');
const { wslSource, belongsToWork, validateImportedSession, validateNativeSession, listNativeSessions, completeImportedFork } = require('../src/history.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('recognizes only the existing Ubuntu OMP session store', () => {
  assert.equal(wslSource('\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.omp\\agent\\sessions\\work\\x.jsonl'), '/home/user/.omp/agent/sessions/work/x.jsonl');
  assert.throws(() => wslSource('\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.omp\\agent\\sessions\\..\\x.jsonl'));
  assert.throws(() => wslSource('\\\\wsl.localhost\\Other\\home\\user\\x.jsonl'));
});
test('import metadata prevents continuing a session in a different work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-history-test-'));
  const dir = path.join(root, 'entry'); const agentDir = path.join(dir, 'agent');
  const sessions = path.join(agentDir, 'sessions', 'bucket');
  await fs.mkdir(sessions, { recursive: true });
  const sessionFile = path.join(sessions, 'one.jsonl');
  await fs.writeFile(sessionFile, JSON.stringify({ type: 'session', cwd: '/work/a/repos/main' }) + '\n');
  await fs.writeFile(path.join(dir, 'import.json'), JSON.stringify({ version: 1, workRoot: '/work/a', session: path.join('sessions', 'bucket', 'one.jsonl') }));
  assert.equal((await validateImportedSession(root, agentDir, sessionFile, '/work/a')).executionRoot, '/work/a/repos/main');
  await assert.rejects(() => validateImportedSession(root, agentDir, sessionFile, '/work/b'));
});
test('Windows source is not classified as WSL', () => assert.equal(wslSource('C:\\Users\\user\\session.jsonl'), null));

test('only a native fork with a distinct ID and correct work becomes the managed copy',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-history-fork-')),agentDir=path.join(temp,'entry','agent'),bucket=path.join(agentDir,'sessions','work');
 await fs.mkdir(bucket,{recursive:true});const source=path.join(bucket,'packed.jsonl'),fork=path.join(bucket,'fork.jsonl'),file=path.join(temp,'entry','import.json');
 const metadata={version:1,workRoot:'/work/a',session:path.relative(agentDir,source),forkPending:true};
 await fs.writeFile(source,JSON.stringify({type:'session',id:'original',cwd:'/work/a'})+'\n');await fs.writeFile(file,JSON.stringify(metadata));
 const before=await fs.readFile(source,'utf8');await fs.writeFile(fork,JSON.stringify({type:'session',id:'original',cwd:'/work/a'})+'\n');
 await assert.rejects(completeImportedFork(temp,agentDir,source,fork,'/work/a'),/未创建独立/);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),metadata);
 await fs.writeFile(fork,JSON.stringify({type:'session',id:'independent',cwd:'/work/b'})+'\n');await assert.rejects(completeImportedFork(temp,agentDir,source,fork,'/work/a'),/其他工作根/);
 await fs.writeFile(fork,JSON.stringify({type:'session',id:'independent',cwd:'/work/a'})+'\n');await completeImportedFork(temp,agentDir,source,fork,'/work/a');
 assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{...metadata,session:path.relative(agentDir,fork),forkPending:false});assert.equal(await fs.readFile(source,'utf8'),before);
 const selected=await validateImportedSession(temp,agentDir,fork,'/work/a');assert.equal(selected.forkPending,false);assert.equal(selected.id,'independent');
 await assert.rejects(validateImportedSession(temp,agentDir,source,'/work/a'),/导入记录已失效/);
});
test('historical session is bound to the selected work root', () => {
  const root = '/home/user/develop/sample-work';
  assert.equal(belongsToWork(root + '/repos/main', root), true);
  assert.equal(belongsToWork('\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\develop\\sample-work', root), true);
  assert.equal(belongsToWork('/home/user/develop/sample-work-other', root), false);
});

test('client-created sessions can be listed and resumed only under their own work', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-native-history-'));
  const agent = path.join(temp, 'agent');
  const bucket = path.join(agent, 'sessions', 'work');
  await fs.mkdir(bucket, { recursive: true });
  const file = path.join(bucket, 'session.jsonl');
  const root = '/home/user/develop/example';
  await fs.writeFile(file, JSON.stringify({ type: 'session', id: 'native-session', cwd: '\\\\wsl.localhost\\Ubuntu-22.04' + root.replaceAll('/', '\\') }) + '\n');
  const found = await listNativeSessions(agent, root);
  assert.equal(found.length, 1);
  assert.equal(found[0].sourceKind, 'native');
  assert.equal(found[0].sessionFile, await fs.realpath(file));
  await fs.appendFile(file, JSON.stringify({type:'message',message:{role:'user',content:[{type:'text',text:'检查当前工作状态'}]}}) + '\n');
  assert.equal((await listNativeSessions(agent, root))[0].title, '检查当前工作状态');
  await fs.appendFile(file, JSON.stringify({type:'session_info',name:'Work 状态检查'}) + '\n');
  assert.equal((await listNativeSessions(agent, root))[0].title, 'Work 状态检查');
  await validateNativeSession(agent, file, root);
  await assert.rejects(() => validateNativeSession(agent, file, root + '-other'));
  assert.deepEqual(await listNativeSessions(agent, root + '-other'), []);
  const outside = path.join(temp, 'outside.jsonl');
  await fs.copyFile(file, outside);
  await assert.rejects(() => validateNativeSession(agent, outside, root));
});
