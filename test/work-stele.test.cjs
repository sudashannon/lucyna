const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  mergeWorkSteleMcpConfig,
  mergeWorkSkillSettings,
  installWorkSteleMcp,
  installWorkSkillDirectory,
  restoreWorkSteleMcp,
  restoreWorkSkillDirectory,
  toWslPath,
  workSkillDirectories,
  workSkillDirectory,
  workSteleServerDefinition,
  adaptWorkCommandForWindows,
} = require('../src/work-stele.cjs');

test('maps the Windows project path to the WSL mount path', () => {
  assert.equal(toWslPath('C:\\Users\\sample user\\omp-cindy'), '/mnt/c/Users/sample user/omp-cindy');
});

test('builds a stdio bridge definition without embedding the Stele token', () => {
  const definition = workSteleServerDefinition({
    projectRoot: 'C:\\Users\\sample\\project',
    distro: 'Ubuntu-22.04',
  });
  assert.deepEqual(definition, {
    type: 'stdio',
    command: 'wsl.exe',
    args: ['-d', 'Ubuntu-22.04', '-u', 'user', '--', 'python3', '/mnt/c/Users/sample/project/tools/work-stele/server.py'],
  });
  assert.equal(JSON.stringify(definition).includes('token'), false);
});

test('merges the bridge into each OMP agent config while retaining other servers', () => {
  const merged = mergeWorkSteleMcpConfig(
    { mcpServers: { github: { type: 'stdio', command: 'gh-mcp' }, stele: { type: 'http', url: 'http://127.0.0.1:18989/mcp' } } },
    { type: 'stdio', command: 'wsl.exe', args: ['-d', 'Ubuntu-22.04'] },
  );
  assert.equal(merged.mcpServers.github.command, 'gh-mcp');
  assert.equal(merged.mcpServers.stele.type, 'stdio');
});

test('points native OMP skill discovery at the WSL skills directory without copying it', () => {
  const directory = workSkillDirectory();
  assert.equal(directory, '\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.agents\\skills');
  assert.deepEqual(workSkillDirectories(), [
    directory,
    '\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.omp\\agent\\managed-skills',
  ]);
  const merged = mergeWorkSkillSettings(
    { skills: { includeSkills: ['*'], customDirectories: ['D:\\shared-skills'] } },
    directory,
  );
  assert.deepEqual(merged.settings.skills.customDirectories, ['D:\\shared-skills', directory]);
  assert.deepEqual(merged.settings.skills.includeSkills, ['*']);
  assert.equal(merged.added, true);
  assert.equal(mergeWorkSkillSettings(merged.settings, directory).added, false);
});

test('keeps command frontmatter and adds Windows WSL execution constraints', () => {
  const mirrored = adaptWorkCommandForWindows('---\ndescription: Example\n---\nBody');
  assert.equal(mirrored.startsWith('---\ndescription: Example\n---\n'), true);
  assert.match(mirrored, /wsl\.exe -d Ubuntu-22\.04/);
  assert.match(mirrored, /native OMP `\/move` command takes a Windows path/);
  assert.match(mirrored, /per-repository and per-operation approval rule/);
  assert.match(mirrored, /Body$/);
});

test('restore reverts only the bridge entry in an isolated agentDir', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-stele-'));
  try {
    const configPath = path.join(dir, 'mcp.json');
    const previous = { type: 'http', url: 'http://127.0.0.1:18989/mcp' };
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { stele: previous, other: { type: 'stdio', command: 'other' } } }));
    const installation = await installWorkSteleMcp(dir, { projectRoot: 'C:\\project' });
    assert.equal(installation.changed, true);
    assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.stele.type, 'stdio');
    await restoreWorkSteleMcp(dir, installation);
    const restored = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.deepEqual(restored.mcpServers.stele, previous);
    assert.deepEqual(restored.mcpServers.other, { type: 'stdio', command: 'other' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('does not overwrite a manually changed Stele MCP config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-stele-conflict-'));
  try {
    const configPath = path.join(dir, 'mcp.json');
    const original = JSON.stringify({
      mcpServers: {
        stele: { type: 'http', url: 'http://127.0.0.1:18989/mcp', headers: { 'X-User-Setting': 'keep' } },
        custom: { type: 'stdio', command: 'user-server' },
      },
    }, null, 2) + '\n';
    await fs.writeFile(configPath, original);
    await assert.rejects(installWorkSteleMcp(dir, { projectRoot: 'C:\\project' }), /was preserved/);
    assert.equal(await fs.readFile(configPath, 'utf8'), original);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('installs and restores native skill discovery independently in two agentDirs', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'work-skill-agentdirs-'));
  const defaultAgentDir = path.join(base, 'default-agent');
  const historyAgentDir = path.join(base, 'history-agent');
  try {
    await fs.mkdir(defaultAgentDir);
    await fs.mkdir(historyAgentDir);
    await fs.writeFile(path.join(defaultAgentDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    await fs.writeFile(path.join(historyAgentDir, 'settings.json'), JSON.stringify({ skills: { customDirectories: ['D:\\shared'] } }));

    const defaultInstall = await installWorkSkillDirectory(defaultAgentDir);
    const historyInstall = await installWorkSkillDirectory(historyAgentDir);
    const defaultSettings = JSON.parse(await fs.readFile(path.join(defaultAgentDir, 'settings.json'), 'utf8'));
    const historySettings = JSON.parse(await fs.readFile(path.join(historyAgentDir, 'settings.json'), 'utf8'));
    assert.equal(defaultSettings.skills.customDirectories.length, 2);
    assert.equal(historySettings.skills.customDirectories.length, 3);
    assert.equal(historySettings.theme, undefined);
    assert.equal(defaultSettings.theme, 'dark');

    await restoreWorkSkillDirectory(defaultAgentDir, defaultInstall);
    await restoreWorkSkillDirectory(historyAgentDir, historyInstall);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(defaultAgentDir, 'settings.json'), 'utf8')), { theme: 'dark', skills: { customDirectories: [] } });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(historyAgentDir, 'settings.json'), 'utf8')), { skills: { customDirectories: ['D:\\shared'] } });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
