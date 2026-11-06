const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { CodeReviewService } = require('../src/code-review.cjs');

const TEST_CONFIG = {
  baseURL: 'http://127.0.0.1:18989/v1',
  protocol: 'chat-completions',
  model: 'local-code-review-fixture',
  apiKey: 'code-review-secret-fixture',
};

function deferred() {
  let resolve;
  let reject;
  let settled = false;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = value => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    reject = error => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}

function makeSnapshot(patch = '@@ -10 +10 @@\n-return false;\n+return true;', scope = 'unstaged') {
  return {
    files: [{
      member: 'lucyna',
      path: 'src/example.cjs',
      scope,
      patch,
    }],
    warnings: [],
    partial: false,
    capturedAt: 1_800_000_000_000,
  };
}

function makeSource({
  kind = 'workspace',
  root = '/work/alpha',
  member = 'lucyna',
  scope = 'all',
  sessionId = 'session-one',
  messageId = 'user-123',
} = {}) {
  if (kind === 'turn') return { kind, sessionId, messageId };
  return { kind: 'workspace', root, member, scope };
}

function stableSourceKey(source) {
  return source.kind === 'turn'
    ? `turn:${source.messageId}`
    : `workspace:${source.root}:${source.member}`;
}

async function makeFixture(t, {
  directory,
  root,
  config = async () => ({ ...TEST_CONFIG }),
  review = async () => ({ findings: [], usage: { inputTokens: 12, outputTokens: 4 } }),
} = {}) {
  const runtimeRoot = path.resolve('.runtime');
  await fs.mkdir(runtimeRoot, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(runtimeRoot, 'code-review-tests-'));
  const ownsFixtureRoot = !directory && !root;
  const storageDirectory = directory || path.join(fixtureRoot, 'store');
  const workspaceRoot = root || path.join(fixtureRoot, 'workspace');
  await fs.mkdir(storageDirectory, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  const services = [];
  const gates = [];
  const serviceContexts = [];
  const sourceData = new Map();

  function registerSource(source, data = {}) {
    sourceData.set(stableSourceKey(source), data);
  }

  function createService({ serviceConfig = config, serviceReview = review } = {}) {
    const calls = { load: [], review: [] };
    const service = new CodeReviewService({
      directory: storageDirectory,
      resolveSource: async source => ({
        key: stableSourceKey(source),
        root: source.kind === 'workspace' ? source.root : '/work/alpha',
        source,
        load: async signal => {
          calls.load.push({ source, signal });
          const data = sourceData.get(stableSourceKey(source)) || {};
          if (data.loader) return data.loader(signal);
          return structuredClone(data.snapshot || makeSnapshot());
        },
      }),
      config: serviceConfig,
      engine: {
        id: 'native',
        version: '1',
        review: async (receivedConfig, snapshot, signal) => {
          calls.review.push({ config: receivedConfig, snapshot: structuredClone(snapshot), signal });
          return serviceReview(receivedConfig, snapshot, signal);
        },
      },
      clock: (() => {
        let now = 1_800_000_000_000;
        return () => now++;
      })(),
    });
    services.push(service);
    const context = { service, calls };
    serviceContexts.push(context);
    return context;
  }

  t.after(async () => {
    for (const gate of gates) {
      if (!gate.settled) gate.resolve({ findings: [], usage: { inputTokens: 0, outputTokens: 0 } });
    }
    for (const service of services) {
      await service.close();
      await service.drain();
    }
    if (ownsFixtureRoot) {
      const relative = path.relative(runtimeRoot, fixtureRoot);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to remove a test path outside .runtime');
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  return {
    directory: storageDirectory,
    root: workspaceRoot,
    gates,
    serviceContexts,
    createService,
    registerSource,
  };
}

test('reviews the injected snapshot without changing files in the source workspace', async t => {
  const fixture = await makeFixture(t);
  const { service, calls } = fixture.createService();
  const workFile = path.join(fixture.root, 'src', 'example.cjs');
  await fs.mkdir(path.dirname(workFile), { recursive: true });
  await fs.writeFile(workFile, 'return false;\n', 'utf8');
  const before = await fs.readFile(workFile, 'utf8');

  const source = makeSource();
  const created = await service.start(source);
  await service.drain();

  const completed = await service.read(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(calls.review.length, 1);
  assert.equal(calls.review[0].snapshot.root, '/work/alpha');
  assert.equal(calls.review[0].snapshot.files[0].path, 'src/example.cjs');
  assert.equal(await fs.readFile(workFile, 'utf8'), before);
});

test('a complete empty snapshot completes without calling the review engine', async t => {
  const fixture = await makeFixture(t);
  const { service, calls } = fixture.createService();
  const source = makeSource();
  fixture.registerSource(source, { snapshot: { files: [], warnings: [], partial: false, capturedAt: 7 } });
  const created = await service.start(source);
  await service.drain();

  const completed = await service.read(created.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.findings, []);
  assert.equal(calls.review.length, 0);
});

test('partial snapshots with evidence retain their warnings and partial marker', async t => {
  const fixture = await makeFixture(t);
  const { service, calls } = fixture.createService();
  const warning = '部分会话历史不可用';
  const source = makeSource();
  fixture.registerSource(source, { snapshot: { ...makeSnapshot(), partial: true, warnings: [warning] } });
  const created = await service.start(source);
  await service.drain();

  const completed = await service.read(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.snapshot.partial, true);
  assert.ok(completed.snapshot.warnings.includes(warning));
  assert.equal(calls.review.length, 1);
  assert.equal(calls.review[0].snapshot.partial, true);
});

test('an empty partial snapshot fails instead of being reported as a clean review', async t => {
  const fixture = await makeFixture(t);
  const { service, calls } = fixture.createService();
  const source = makeSource();
  fixture.registerSource(source, { snapshot: { files: [], warnings: ['本地改动读取失败'], partial: true, capturedAt: 9 } });
  const created = await service.start(source);
  await service.drain();

  const failed = await service.read(created.id);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error);
  assert.equal(calls.review.length, 0);
});

test('history is isolated by stable source key even when the active session changes', async t => {
  const fixture = await makeFixture(t);
  const { service } = fixture.createService();
  const firstSource = makeSource({ kind: 'turn', sessionId: 'session-before', messageId: 'user-123' });
  const betaSource = makeSource({ member: 'beta' });
  fixture.registerSource(firstSource, { snapshot: makeSnapshot('@@ -10 +10 @@\n-return false;\n+return true;', 'turn') });
  fixture.registerSource(betaSource, { snapshot: makeSnapshot('@@ -10 +10 @@\n-return false;\n+return false;') });
  const first = await service.start(firstSource);
  const second = await service.start(betaSource);
  await service.drain();

  const alphaHistory = await service.list(makeSource({ kind: 'turn', sessionId: 'session-after', messageId: 'user-123' }));
  const betaHistory = await service.list(makeSource({ member: 'beta' }));
  assert.deepEqual(alphaHistory.map(run => run.id), [first.id]);
  assert.deepEqual(betaHistory.map(run => run.id), [second.id]);
});

for (const lateOutcome of ['resolve', 'reject']) {
  test(`cancellation cannot be overwritten by an engine that later ${lateOutcome}s`, async t => {
    const entered = deferred();
    const engineGate = deferred();
    const fixture = await makeFixture(t, {
      review: async () => {
        entered.resolve();
        return engineGate.promise;
      },
    });
    fixture.gates.push(engineGate);
    const { service } = fixture.createService();
    const created = await service.start(makeSource());
    await entered.promise;

    await service.cancel(created.id);
    const stopping = await service.read(created.id);
    assert.equal(stopping.status, 'stopping');

    if (lateOutcome === 'resolve') {
      engineGate.resolve({ findings: [], usage: { inputTokens: 10, outputTokens: 2 } });
    } else {
      engineGate.reject(new Error('late engine failure'));
    }
    await service.drain();

    const cancelled = await service.read(created.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error, undefined);
    assert.deepEqual(cancelled.findings, []);
  });
}

test('completed runs and finding decisions survive restart without persisting model credentials', async t => {
  const fixture = await makeFixture(t, {
    review: async (_config, snapshot) => ({
      findings: [{
        fileId: snapshot.files[0].id,
        severity: 'high',
        title: 'The changed branch returns the wrong result',
        body: 'The new branch returns true and changes the previous behavior.',
        evidence: 'return true;',
        suggestion: 'Return the value required by the caller.',
        lineStart: 10,
        lineEnd: 10,
      }],
      usage: { inputTokens: 45, outputTokens: 12 },
    }),
  });
  const source = makeSource();
  const firstContext = fixture.createService();
  const created = await firstContext.service.start(source);
  await firstContext.service.drain();
  const completed = await firstContext.service.read(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.usage.inputTokens, 45);
  assert.equal(completed.findings.length, 1);

  await firstContext.service.updateFinding(created.id, completed.findings[0].id, 'ignored');
  const jsonFiles = (await fs.readdir(fixture.directory)).filter(file => file.endsWith('.json'));
  assert.equal(jsonFiles.length, 1);
  const persisted = await fs.readFile(path.join(fixture.directory, jsonFiles[0]), 'utf8');
  assert.ok(!persisted.includes(TEST_CONFIG.apiKey));

  await firstContext.service.close();
  const secondContext = fixture.createService({
    serviceReview: async () => { throw new Error('a completed run should load from disk'); },
  });
  const history = await secondContext.service.list(source);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, created.id);
  assert.equal(history[0].findings[0].status, 'ignored');
  assert.equal((await secondContext.service.read(created.id)).engine.id, 'native');
});

test('a new service marks a persisted in-flight run interrupted', async t => {
  const captureEntered = deferred();
  const captureGate = deferred();
  const fixture = await makeFixture(t);
  fixture.gates.push(captureGate);
  const firstContext = fixture.createService();
  const source = makeSource();
  fixture.registerSource(source, {
    loader: async () => {
      captureEntered.resolve();
      await captureGate.promise;
      return makeSnapshot();
    },
  });
  const created = await firstContext.service.start(source);
  await captureEntered.promise;

  const secondContext = fixture.createService({
    serviceReview: async () => { throw new Error('recovered runs must not be resumed'); },
  });
  const history = await secondContext.service.list(source);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, created.id);
  assert.equal(history[0].status, 'interrupted');
  assert.equal(secondContext.calls.review.length, 0);

  await firstContext.service.cancel(created.id);
  captureGate.resolve();
  await firstContext.service.drain();
});

test('identical snapshots reuse the latest finding decision; changed model invalidates reuse',async t=>{
  let model='first-model';
  const fixture=await makeFixture(t,{config:async()=>({...TEST_CONFIG,model}),review:async(_config,snapshot)=>({findings:[{
    fileId:snapshot.files[0].id,severity:'medium',title:'条件改变',body:'此改动会改变条件返回值。',evidence:'return true;',lineStart:10,
  }]})});
  const {service,calls}=fixture.createService(),source=makeSource();
  const first=await service.start(source);await service.drain();
  const second=await service.start(source);await service.drain();
  assert.equal(calls.review.length,1);assert.equal((await service.read(second.id)).reusedFrom,first.id);
  const finding=(await service.read(second.id)).findings[0];await service.updateFinding(second.id,finding.id,'ignored');
  const third=await service.start(source);await service.drain();
  assert.equal((await service.read(third.id)).findings[0].status,'ignored');
  model='different-model';await service.start(source);await service.drain();assert.equal(calls.review.length,2);
});

test('a queued model request keeps its captured input and can stop without calling the engine',async t=>{
  const entered=deferred(),gate=deferred();
  const fixture=await makeFixture(t,{review:async()=>{entered.resolve();return gate.promise;}});fixture.gates.push(gate);
  const {service,calls}=fixture.createService();
  await service.start(makeSource());await entered.promise;
  const second=await service.start(makeSource({root:'/work/beta'}));
  for(let i=0;i<200&&(await service.read(second.id)).status!=='queued';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok((await service.read(second.id)).snapshot,'snapshot is saved before waiting for model');
  await service.cancel(second.id);gate.resolve({findings:[]});await service.drain();
  assert.equal((await service.read(second.id)).status,'cancelled');assert.equal(calls.review.length,1);
});
