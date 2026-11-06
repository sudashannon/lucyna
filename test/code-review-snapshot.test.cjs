'use strict';

const assert = require('node:assert/strict');
const {execFileSync, spawn} = require('node:child_process');
const {mkdtemp, mkdir, readFile, rm, writeFile, access} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {captureWorkspace, createCodeReviewSnapshot} = require('../src/code-review-snapshot.cjs');

const python = process.env.LUCYNA_TEST_PYTHON || 'python';

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env},
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8').trim();
}

async function makeWork({head = true} = {}) {
  const parent = await mkdtemp(path.join(__dirname, '.tmp-code-review-snapshot-'));
  const root = path.join(parent, 'work root');
  const member = path.join(root, 'repos', 'app');
  await mkdir(member, {recursive: true});
  await writeFile(path.join(root, 'SESSION.md'), '# Fixture\n');
  git(member, ['init']);
  git(member, ['config', 'user.name', 'Snapshot Test']);
  git(member, ['config', 'user.email', 'snapshot@example.invalid']);
  git(member, ['config', 'core.autocrlf', 'false']);
  const emptyExcludes = path.join(member, '.git', 'test-empty-excludes');
  await writeFile(emptyExcludes, '');
  git(member, ['config', 'core.excludesFile', emptyExcludes]);
  git(member, ['branch', '-M', 'main']);
  if (head) {
    await writeFile(path.join(member, 'source.txt'), 'base line\n');
    git(member, ['add', '--', 'source.txt']);
    git(member, ['commit', '-m', 'fixture baseline'], {GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'});
  }
  const common = git(member, ['rev-parse', '--git-common-dir']);
  const commonPath = path.resolve(member, common);
  await writeFile(path.join(root, 'work.json'), JSON.stringify({
    version: 1,
    members: [{name: 'app', path: 'repos/app', repo: commonPath}],
  }));
  const scriptPath = path.resolve(__dirname, '../src/code-review-snapshot.py');
  const probe = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("review_snapshot",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
    'try:',
    '    snapshot=module.capture(json.loads(sys.stdin.readline()),module.GitRunner())',
    '    print(json.dumps({"success":True,"snapshot":snapshot},ensure_ascii=True))',
    'except module.SnapshotError as error:',
    '    print(json.dumps({"success":False,"error":str(error)},ensure_ascii=True))',
  ].join('\n');
  const capture = async input => {
    const output = execFileSync(python, ['-c', probe, scriptPath], {
      cwd: root,
      input: JSON.stringify(input) + '\n',
      encoding: 'utf8',
      timeout: 15000,
    });
    const result = JSON.parse(output);
    if (!result.success) throw Object.assign(Error(result.error), {publicMessage: result.error});
    return result.snapshot;
  };
  return {parent, root, member, capture};
}

async function dispose(fixture) {
  await rm(fixture.parent, {recursive: true, force: true});
}

test('captures staged, unstaged, and untracked changes independently without changing the index', async () => {
  const fixture = await makeWork();
  try {
    await writeFile(path.join(fixture.member, 'source.txt'), 'staged line\n');
    git(fixture.member, ['add', '--', 'source.txt']);
    await writeFile(path.join(fixture.member, 'source.txt'), 'working line\n');
    await writeFile(path.join(fixture.member, 'new file.txt'), 'untracked line\n');
    const indexBefore = await readFile(path.join(fixture.member, '.git', 'index'));

    const snapshot = await fixture.capture({root: fixture.root, member: 'app', scope: 'all'});
    const staged = snapshot.files.find(file => file.path === 'source.txt' && file.scope === 'staged');
    const unstaged = snapshot.files.find(file => file.path === 'source.txt' && file.scope === 'unstaged');
    const untracked = snapshot.files.find(file => file.path === 'new file.txt' && file.scope === 'unstaged');

    assert.match(staged.patch, /\+staged line/);
    assert.match(unstaged.patch, /-staged line[\s\S]*\+working line/);
    assert.match(untracked.patch, /\+untracked line/);
    assert.equal(snapshot.partial, false);
    assert.deepEqual(await readFile(path.join(fixture.member, '.git', 'index')), indexBefore);
  } finally {
    await dispose(fixture);
  }
});

test('scope filters preserve staged versus unstaged semantics and include untracked only as unstaged', async () => {
  const fixture = await makeWork();
  try {
    await writeFile(path.join(fixture.member, 'source.txt'), 'staged line\n');
    git(fixture.member, ['add', '--', 'source.txt']);
    await writeFile(path.join(fixture.member, 'source.txt'), 'working line\n');
    await writeFile(path.join(fixture.member, 'fresh.txt'), 'new\n');

    const staged = await fixture.capture({root: fixture.root, member: 'app', scope: 'staged'});
    const unstaged = await fixture.capture({root: fixture.root, member: 'app', scope: 'unstaged'});
    assert.deepEqual(staged.files.map(file => [file.path, file.scope]), [['source.txt', 'staged']]);
    assert.deepEqual(unstaged.files.map(file => [file.path, file.scope]), [['fresh.txt', 'unstaged'], ['source.txt', 'unstaged']]);
  } finally {
    await dispose(fixture);
  }
});

test('captures deletions and supports an empty repository with staged and untracked files', async () => {
  const fixture = await makeWork();
  try {
    await rm(path.join(fixture.member, 'source.txt'));
    git(fixture.member, ['add', '-u', '--', 'source.txt']);
    const deleted = await fixture.capture({root: fixture.root, member: 'app', scope: 'staged'});
    assert.equal(deleted.files.length, 1);
    assert.match(deleted.files[0].patch, /deleted file mode|^-base line/);
  } finally {
    await dispose(fixture);
  }

  const empty = await makeWork({head: false});
  try {
    await writeFile(path.join(empty.member, 'staged.txt'), 'staged in empty repo\n');
    git(empty.member, ['add', '--', 'staged.txt']);
    await writeFile(path.join(empty.member, 'untracked.txt'), 'untracked in empty repo\n');
    const snapshot = await empty.capture({root: empty.root, member: 'app', scope: 'all'});
    assert.match(snapshot.files.find(file => file.path === 'staged.txt').patch, /\+staged in empty repo/);
    assert.match(snapshot.files.find(file => file.path === 'untracked.txt').patch, /\+untracked in empty repo/);
  } finally {
    await dispose(empty);
  }
});

test('reports conflicts, binary files, and over-limit text as omitted partial entries', async () => {
  const fixture = await makeWork();
  try {
    await writeFile(path.join(fixture.member, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    git(fixture.member, ['add', '--', 'binary.dat']);
    git(fixture.member, ['commit', '-m', 'binary fixture']);
    await writeFile(path.join(fixture.member, 'binary.dat'), Buffer.from([0, 1, 4, 5]));
    await writeFile(path.join(fixture.member, 'large.txt'), 'large line\n'.repeat(18000));
    const bounded = await fixture.capture({root: fixture.root, member: 'app', scope: 'all'});
    assert.equal(bounded.partial, true);
    assert.equal(bounded.files.find(file => file.path === 'binary.dat')?.omitted, true);
    assert.equal(bounded.files.find(file => file.path === 'large.txt')?.omitted, true);

    git(fixture.member, ['branch', 'conflict-side']);
    await writeFile(path.join(fixture.member, 'source.txt'), 'main side\n');
    git(fixture.member, ['add', '--', 'source.txt']);
    git(fixture.member, ['commit', '-m', 'main conflict side']);
    git(fixture.member, ['checkout', 'conflict-side']);
    await writeFile(path.join(fixture.member, 'source.txt'), 'other side\n');
    git(fixture.member, ['add', '--', 'source.txt']);
    git(fixture.member, ['commit', '-m', 'other conflict side']);
    git(fixture.member, ['checkout', 'main']);
    let mergeFailed = false;
    try { git(fixture.member, ['merge', 'conflict-side']); } catch { mergeFailed = true; }
    assert.equal(mergeFailed, true);
    const conflicted = await fixture.capture({root: fixture.root, member: 'app', scope: 'all'});
    assert.equal(conflicted.partial, true);
    assert.equal(conflicted.files.find(file => file.path === 'source.txt')?.omitted, true);
    assert.ok(conflicted.warnings.some(warning => warning.includes('冲突文件')));
  } finally {
    await dispose(fixture);
  }
});

test('staged review is independent of a large untracked APK and full review omits it by metadata', async () => {
  const fixture = await makeWork();
  try {
    await writeFile(path.join(fixture.member, 'source.txt'), 'staged while APK exists\n');
    git(fixture.member, ['add', '--', 'source.txt']);
    await writeFile(path.join(fixture.member, 'large.apk'), Buffer.alloc(17 * 1024 * 1024, 0x5a));

    const staged = await fixture.capture({root: fixture.root, member: 'app', scope: 'staged'});
    assert.deepEqual(staged.files.map(file => [file.path, file.scope]), [['source.txt', 'staged']]);
    assert.equal(staged.partial, false);

    const all = await fixture.capture({root: fixture.root, member: 'app', scope: 'all'});
    const apk = all.files.find(file => file.path === 'large.apk' && file.scope === 'unstaged');
    assert.equal(apk?.omitted, true);
    assert.equal(apk?.patch, '');
    assert.equal(all.partial, true);
    assert.ok(all.warnings.some(warning => warning.includes('large.apk') && warning.includes('未读取也未传入审查')));
  } finally {
    await dispose(fixture);
  }
});

test('rejects a mixed snapshot when file contents change during capture', async () => {
  const fixture = await makeWork();
  try {
    await writeFile(path.join(fixture.member, 'source.txt'), 'before capture\n');
    const scriptPath = path.resolve(__dirname, '../src/code-review-snapshot.py');
    const probe = [
      'import importlib.util,json,sys,os',
      `spec=importlib.util.spec_from_file_location("review_snapshot",${JSON.stringify(scriptPath)})`,
      'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
      'original=module.diff_for',
      'def change_after_diff(runner,member,path,scope,untracked):',
      '    original_bytes=open(member/path,"rb").read()',
      '    before=os.stat(member/path)',
      '    with open(member/path,"wb") as stream: stream.write(b"temporary intermediate content\\n")',
      '    result=original(runner,member,path,scope,untracked)',
      '    with open(member/path,"wb") as stream: stream.write(original_bytes)',
      '    os.utime(member/path,ns=(before.st_atime_ns,before.st_mtime_ns+2_000_000_000))',
      '    return result',
      'module.diff_for=change_after_diff',
      'try:',
      '    module.capture(json.loads(sys.stdin.readline()),module.GitRunner())',
      'except module.SnapshotError as error:',
      '    print(json.dumps(str(error),ensure_ascii=True));sys.exit(0)',
      'print("snapshot unexpectedly succeeded");sys.exit(1)',
    ].join('\n');
    const output = execFileSync(python, ['-c', probe, fixture.member], {
      cwd: fixture.root,
      input: JSON.stringify({root: fixture.root, member: 'app', scope: 'all'}) + '\n',
      encoding: 'utf8',
      timeout: 12000,
    });
    assert.match(JSON.parse(output), /工作区在快照读取期间发生变化/);
  } finally {
    await dispose(fixture);
  }
});

test('cancellation sends EOF, waits for the owned worker to exit, and has a hard-kill fallback', async () => {
  const parent = await mkdtemp(path.join(__dirname, '.tmp-code-review-cancel-'));
  try {
    const marker = path.join(parent, 'exited.txt');
    const cooperative = createCodeReviewSnapshot({
      launch: (_script, options) => spawn(python, ['-c', 'import pathlib,sys;sys.stdin.readline();sys.stdin.read();pathlib.Path(sys.argv[1]).write_text("closed")', marker], options),
      timeoutMs: 5000,
      killGraceMs: 1000,
    });
    const controller = new AbortController();
    const pending = cooperative({root: '/work', member: 'app', scope: 'all'}, controller.signal);
    setTimeout(() => controller.abort(Error('fixture cancellation')), 75);
    await assert.rejects(pending, /fixture cancellation/);
    await access(marker);

    const uncooperative = createCodeReviewSnapshot({
      launch: (_script, options) => spawn(python, ['-c', 'import sys,time;sys.stdin.readline();time.sleep(30)'], options),
      timeoutMs: 120,
      killGraceMs: 100,
    });
    await assert.rejects(uncooperative({root: '/work', member: 'app', scope: 'all'}), /超时/);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('real Ubuntu WSL transport returns a snapshot and cooperatively cancels on stdin EOF', {
  skip: process.env.LUCYNA_TEST_WSL !== '1',
}, async () => {
  const setup = [
    'import json,pathlib,subprocess,sys,tempfile,os',
    'base=pathlib.Path(tempfile.mkdtemp(prefix="lucyna-review-fixture-"))',
    'root=base/"work";member=root/"repos"/"app";member.mkdir(parents=True)',
    '(root/"SESSION.md").write_text("# Isolated WSL fixture\\n",encoding="utf-8")',
    'env={**os.environ,"GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null"}',
    'def git(*args): return subprocess.run(["git",*args],cwd=member,env=env,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout.strip()',
    'git("init");git("config","user.name","Snapshot Test");git("config","user.email","snapshot@example.invalid");git("branch","-M","main")',
    '(member/"source.txt").write_text("base\\n",encoding="utf-8");git("add","--","source.txt");git("commit","-m","fixture baseline")',
    '(member/"source.txt").write_text("worktree change\\n",encoding="utf-8")',
    'common=pathlib.Path(git("rev-parse","--git-common-dir"));common=(member/common).resolve()',
    '(root/"work.json").write_text(json.dumps({"version":1,"members":[{"name":"app","path":"repos/app","repo":str(common)}]}),encoding="utf-8")',
    'print(json.dumps({"base":str(base),"root":str(root)}))',
  ].join('\n');
  const fixture = JSON.parse(execFileSync('wsl.exe', ['-d', 'Ubuntu-22.04', '--exec', 'python3', '-c', setup], {
    encoding: 'utf8',
    timeout: 20000,
  }));
  const linuxScript = file => {
    const normalized = file.replaceAll('\\', '/');
    return '/mnt/' + normalized[0].toLowerCase() + normalized.slice(2);
  };
  const capture = createCodeReviewSnapshot({
    launch: (script, options) => spawn('wsl.exe', ['-d', 'Ubuntu-22.04', '--exec', 'python3', linuxScript(script)], options),
    timeoutMs: 15000,
  });
  try {
    const snapshot = await capture({root: fixture.root, member: 'app', scope: 'all'});
    assert.match(snapshot.files.find(file => file.path === 'source.txt' && file.scope === 'unstaged').patch, /\+worktree change/);

    const controller = new AbortController();
    const cancelled = capture({root: fixture.root, member: 'app', scope: 'all'}, controller.signal);
    controller.abort(Error('WSL fixture cancellation'));
    await assert.rejects(cancelled, /WSL fixture cancellation/);
  } finally {
    const cleanup = [
      'import pathlib,shutil,sys',
      'base=pathlib.Path(sys.argv[1]).resolve()',
      'if base.parent!=pathlib.Path("/tmp") or not base.name.startswith("lucyna-review-fixture-"): raise SystemExit("refusing cleanup target")',
      'shutil.rmtree(base)',
    ].join('\n');
    execFileSync('wsl.exe', ['-d', 'Ubuntu-22.04', '--exec', 'python3', '-c', cleanup, fixture.base], {timeout: 10000});
  }
});

test('rejects invalid Work-member/scope inputs before launching WSL', async () => {
  let launched = false;
  const capture = createCodeReviewSnapshot({launch: () => {launched = true; throw Error('unexpected spawn');}});
  await assert.rejects(capture({root: '/work', member: '../app', scope: 'all'}), /无效 Git 成员/);
  await assert.rejects(capture({root: '/work', member: 'app', scope: 'baseline'}), /无效改动范围/);
  assert.equal(launched, false);
});
