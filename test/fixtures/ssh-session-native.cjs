const fs = require('node:fs');
const assert = require('node:assert/strict');
const {HostConnection} = require('../../src/hosts/connection.cjs');
const {RemoteSession} = require('../../src/hosts/remote-session.cjs');
const [profilePath, installedPath, optionsPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for(let i=0;i<100;i++){if(check())return;await delay(50);}throw Error('Fixture event timeout'); }
async function main() {
  const connection = new HostConnection(config, installed);
  let session = new RemoteSession(connection, 'native-acceptance');
  try {
    const record = await session.start({root: options.root, omp: options.omp, agentDir: options.agentDir}, options.fake ? 'native-fake-create' : 'native-real-create');
    const state = await session.request('get_state');
    let pending;
    if (options.fake) {
      const large = await session.request('get_messages');
      assert.equal(large.messages[0].length, 1200*1024);
      pending = session.request('prompt', {message: 'lost-ack'}, {operationId: 'only-once'}).catch(error => error);
      for (let i=0;i<100;i++) {
        if ((await session.operationStatus('only-once')).status !== 'not_found') break;
        await delay(10);
      }
    }
    const descriptor = session.descriptor();
    const disconnected = new Promise(resolve => connection.once('disconnected', resolve));
    const transport = connection.child;
    transport.kill(); transport.stdin.destroy(); transport.stdout.destroy(); transport.stderr.destroy();
    await disconnected;
    if (pending) assert.equal((await pending).code, 'transport_lost');
    session.detach(); await delay(500);
    let replayed = false;
    session = new RemoteSession(connection, 'native-acceptance');
    session.on('frame', frame => { if(frame.marker === 'after-disconnect') replayed = true; });
    const attached = await session.attach(descriptor);
    assert.equal(attached.pid, record.pid);
    assert.equal(attached.nativeSessionId, state.sessionId);
    const after = await session.request('get_state');
    assert.equal(after.sessionId, state.sessionId);
    if (options.fake) {
      await until(() => replayed);
      assert.equal((await session.operationStatus('only-once')).status, 'succeeded');
      await assert.rejects(session.request('prompt', {message: 'lost-ack'}, {operationId: 'only-once'}), {code: 'operation_recorded'});
      assert.equal((await session.request('get_state')).promptCount, 1);
    }
    const snapshot = await session.resync();
    assert.equal(snapshot.state.sessionId, state.sessionId);
    assert.ok(Array.isArray(snapshot.messages));
    await session.stop();
    process.stdout.write(JSON.stringify({fake: options.fake, samePid: true, sameNativeSession: true,
      nativeId: state.sessionId, replayed, duplicatePromptPrevented: options.fake,
      nativeChunking: options.fake, abruptTransportLoss: true, lostAcknowledgement: options.fake,
      snapshotResync: true, modelCalled: false}));
  } finally { session.detach(); await connection.disconnect(); }
}
main().catch(error => { process.stderr.write(String(error.stack)+'\n'); process.exitCode=1; });
