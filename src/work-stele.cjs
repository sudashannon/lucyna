const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const pathWin = path.win32;
const runtime=require('./runtime-config.cjs');

const SERVER_NAME = 'stele';
const DEFAULT_DISTRO = runtime.distro;
const DEFAULT_WSL_USER = runtime.user;
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SKILL_DIRECTORY = runtime.skillDirectory;
const DEFAULT_MANAGED_SKILL_DIRECTORY = runtime.wslAgentDir+'/managed-skills';
const DEFAULT_COMMAND_DIRECTORY = runtime.wslAgentDir+'/commands';
const WORK_COMMANDS = ['work-start', 'work-continue', 'work-review', 'work-end'];
const LEGACY_STELE_HTTP = { type: 'http', url: 'http://127.0.0.1:18989/mcp' };

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function toWslPath(windowsPath) {
  if (typeof windowsPath !== 'string' || !pathWin.isAbsolute(windowsPath)) {
    throw new TypeError('Expected an absolute Windows path');
  }
  const normalized = pathWin.normalize(windowsPath);
  const drive = normalized.slice(0, 2);
  if (!/^[A-Za-z]:$/.test(drive)) throw new TypeError('Expected a drive-qualified Windows path');
  const tail = normalized.slice(2).replaceAll('\\', '/');
  return `/mnt/${drive[0].toLowerCase()}${tail}`;
}

function workSteleServerDefinition({ projectRoot = DEFAULT_PROJECT_ROOT, distro = DEFAULT_DISTRO, wslUser = DEFAULT_WSL_USER } = {}) {
  if (typeof distro !== 'string' || !/^[A-Za-z0-9._-]+$/.test(distro)) {
    throw new TypeError('Invalid WSL distribution name');
  }
  if (wslUser !== DEFAULT_WSL_USER) throw new TypeError('The WSL bridge must run as the configured user');
  const scriptPath = path.resolve(projectRoot, 'tools', 'work-stele', 'server.py');
  return {
    type: 'stdio',
    command: 'wsl.exe',
    args: ['-d', distro, '-u', DEFAULT_WSL_USER, '--', 'python3', toWslPath(scriptPath)],
  };
}

function wslUncPath(linuxPath, distro = DEFAULT_DISTRO) {
  if (typeof distro !== 'string' || !/^[A-Za-z0-9._-]+$/.test(distro)) {
    throw new TypeError('Invalid WSL distribution name');
  }
  if (
    typeof linuxPath !== 'string' ||
    !linuxPath.startsWith('/') ||
    linuxPath.includes('\\') ||
    linuxPath.includes('\0') ||
    linuxPath.split('/').some(part => part === '..' || part === '.')
  ) {
    throw new TypeError('Expected a safe absolute WSL path');
  }
  return `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll('/', '\\')}`;
}

function workSkillDirectory({ distro = DEFAULT_DISTRO, linuxPath = DEFAULT_SKILL_DIRECTORY } = {}) {
  return wslUncPath(linuxPath, distro);
}

function workSkillDirectories({ distro = DEFAULT_DISTRO } = {}) {
  return [
    workSkillDirectory({ distro }),
    workSkillDirectory({ distro, linuxPath: DEFAULT_MANAGED_SKILL_DIRECTORY }),
  ];
}

function sameWindowsPath(left, right) {
  return String(left).replaceAll('/', '\\').toLocaleLowerCase('en-US') ===
    String(right).replaceAll('/', '\\').toLocaleLowerCase('en-US');
}

function mergeWorkSkillSettings(settings, skillDirectory) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError('OMP settings must be an object');
  }
  const currentSkills = settings.skills;
  if (currentSkills !== undefined && (!currentSkills || typeof currentSkills !== 'object' || Array.isArray(currentSkills))) {
    throw new TypeError('OMP skills settings must be an object');
  }
  const customDirectories = currentSkills?.customDirectories;
  if (customDirectories !== undefined && !Array.isArray(customDirectories)) {
    throw new TypeError('skills.customDirectories must be an array');
  }
  const requestedDirectories = Array.isArray(skillDirectory) ? skillDirectory : [skillDirectory];
  const directories = [...(customDirectories || [])];
  const addedDirectories = [];
  for (const requested of requestedDirectories) {
    if (!directories.some(directory => sameWindowsPath(directory, requested))) {
      directories.push(requested);
      addedDirectories.push(requested);
    }
  }
  return {
    settings: { ...settings, skills: { ...(currentSkills || {}), customDirectories: directories } },
    added: addedDirectories.length > 0,
    addedDirectories,
  };
}

function mergeWorkSteleMcpConfig(config, serverDefinition) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('OMP MCP config must be an object');
  }
  const merged = { ...config };
  const existing = merged.mcpServers;
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new TypeError('OMP mcpServers must be an object');
  }
  const previousStele = existing?.[SERVER_NAME];
  if (
    previousStele !== undefined &&
    !jsonEqual(previousStele, LEGACY_STELE_HTTP) &&
    !jsonEqual(previousStele, serverDefinition)
  ) {
    throw new Error('An existing Stele MCP config differs from the known entry and was preserved');
  }
  merged.mcpServers = { ...(existing || {}), [SERVER_NAME]: serverDefinition };
  return merged;
}

async function installWorkSteleMcp(agentDir, options = {}) {
  if (typeof agentDir !== 'string' || !path.isAbsolute(agentDir)) {
    throw new TypeError('agentDir must be an absolute path');
  }
  const configPath = path.join(agentDir, 'mcp.json');
  let originalText = null;
  let originalMode = 0o600;
  let config = {};
  try {
    const file = await fs.readFile(configPath);
    originalText = file.toString('utf8');
    const stats = await fs.stat(configPath);
    originalMode = stats.mode & 0o777;
    config = JSON.parse(originalText);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw new Error(`Invalid OMP MCP config at ${configPath}`);
      throw error;
    }
  }
  const serverDefinition = workSteleServerDefinition(options);
  const merged = mergeWorkSteleMcpConfig(config, serverDefinition);
  const nextText = `${JSON.stringify(merged, null, 2)}\n`;
  const changed = originalText !== nextText;
  if (changed) {
    await fs.mkdir(agentDir, { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, nextText, { encoding: 'utf8', mode: originalMode });
    await fs.chmod(temporaryPath, originalMode);
    await fs.rename(temporaryPath, configPath);
  }
  return {
    configPath,
    changed,
    previousServer: config.mcpServers?.[SERVER_NAME] ?? null,
    serverDefinition,
  };
}

async function installWorkSkillDirectory(agentDir, options = {}) {
  if (typeof agentDir !== 'string' || !path.isAbsolute(agentDir)) {
    throw new TypeError('agentDir must be an absolute path');
  }
  const settingsPath = path.join(agentDir, 'settings.json');
  let originalText = null;
  let originalMode = 0o600;
  let settings = {};
  try {
    const file = await fs.readFile(settingsPath);
    originalText = file.toString('utf8').replace(/^\uFEFF/, '');
    const stats = await fs.stat(settingsPath);
    originalMode = stats.mode & 0o777;
    settings = JSON.parse(originalText);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw new Error(`Invalid OMP settings at ${settingsPath}`);
      throw error;
    }
  }
  const skillDirectories = workSkillDirectories(options);
  const result = mergeWorkSkillSettings(settings, skillDirectories);
  const nextText = `${JSON.stringify(result.settings, null, 2)}\n`;
  const changed = originalText !== nextText;
  if (changed) {
    await fs.mkdir(agentDir, { recursive: true });
    const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, nextText, { encoding: 'utf8', mode: originalMode });
    await fs.chmod(temporaryPath, originalMode);
    await fs.rename(temporaryPath, settingsPath);
  }
  return { settingsPath, changed, added: result.added, addedDirectories: result.addedDirectories, skillDirectories };
}

async function restoreWorkSkillDirectory(agentDir, installation) {
  if (typeof agentDir !== 'string' || !path.isAbsolute(agentDir)) {
    throw new TypeError('agentDir must be an absolute path');
  }
  if (!installation || !installation.added || !Array.isArray(installation.addedDirectories)) {
    return { restored: false, reason: 'No work skill directory was added' };
  }
  const settingsPath = path.join(agentDir, 'settings.json');
  let settings;
  try {
    settings = JSON.parse((await fs.readFile(settingsPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return { restored: false, reason: 'OMP settings file is missing' };
    throw error;
  }
  const currentSkills = settings.skills;
  const directories = currentSkills?.customDirectories;
  if (!Array.isArray(directories)) return { restored: false, reason: 'customDirectories is no longer an array' };
  const nextDirectories = [...directories];
  let removed = 0;
  for (const addedDirectory of installation.addedDirectories) {
    const index = nextDirectories.findIndex(directory => sameWindowsPath(directory, addedDirectory));
    if (index >= 0) {
      nextDirectories.splice(index, 1);
      removed += 1;
    }
  }
  if (!removed) return { restored: false, reason: 'Work skill directories are already absent' };
  const merged = { ...settings, skills: { ...currentSkills, customDirectories: nextDirectories } };
  const stats = await fs.stat(settingsPath);
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: stats.mode & 0o777 });
  await fs.chmod(temporaryPath, stats.mode & 0o777);
  await fs.rename(temporaryPath, settingsPath);
  return { settingsPath, restored: true };
}

function adaptWorkCommandForWindows(content) {
  if (typeof content !== 'string') throw new TypeError('OMP command content must be text');
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!match) throw new Error('Installed WSL OMP command has invalid frontmatter');
  const adapter = [
    '## Windows OMP and WSL runtime',
    '',
    `This command runs in native Windows OMP while its work roots, repositories, and helper scripts remain in ${runtime.distro} WSL.`,
    '- Keep canonical work roots and repository paths as Linux paths such as `'+runtime.workRoot+'/<id>`.',
    '- Run Linux helper scripts and every Git command through `wsl.exe -d '+runtime.distro+' -- ...`; for example, invoke `'+runtime.skillDirectory+'/worktree-session/scripts/worktree-work.py` as `wsl.exe -d '+runtime.distro+' -- python3 '+runtime.skillDirectory+'/worktree-session/scripts/worktree-work.py ...`. Never pass a Linux or `\\wsl.localhost` path to Windows `python3`, Windows Git, or another Windows filesystem tool.',
    '- Prefer the read-only MCP tools `mcp__stele__work_list`, `mcp__stele__work_verify`, `mcp__stele__work_read_session`, and `mcp__stele__work_read_note` for inventory, verification, SESSION, and shared notes. They execute against the existing WSL helper and files.',
    '- The native OMP `/move` command takes a Windows path. The executable `/move <path>` line emitted to the user must convert the Linux work root to `'+wslUncPath(runtime.workRoot)+'/'.replaceAll('/','\\')+'<id>`; keep and show the canonical Linux path for all WSL work operations.',
    '- Preserve every per-repository and per-operation approval rule below. A WSL bridge or available MCP tool does not grant write approval.',
    '',
    '--- original WSL OMP command follows ---',
    '',
  ].join('\n');
  return match[0] + adapter + content.slice(match[0].length);
}

async function installWorkCommandMirrors(agentDir, { distro = DEFAULT_DISTRO, wslUser = DEFAULT_WSL_USER, sourceDirectory = DEFAULT_COMMAND_DIRECTORY } = {}) {
  if (typeof agentDir !== 'string' || !path.isAbsolute(agentDir)) {
    throw new TypeError('agentDir must be an absolute path');
  }
  if (sourceDirectory !== DEFAULT_COMMAND_DIRECTORY) {
    throw new TypeError('Work command source must be the installed WSL OMP command directory');
  }
  if (typeof distro !== 'string' || !/^[A-Za-z0-9._-]+$/.test(distro)) {
    throw new TypeError('Invalid WSL distribution name');
  }
  if (wslUser !== DEFAULT_WSL_USER) throw new TypeError('The WSL command source must be read as the configured user');
  const commandDir = path.join(agentDir, 'commands');
  try {
    const stats = await fs.lstat(commandDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Refusing a non-directory OMP commands path');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pending = [];
  let sources;
  // These are static files already exposed through WSL's filesystem. Reading
  // them directly avoids launching another WSL process on every session resume.
  const sourceRoot = `\\\\wsl.localhost\\${distro}` + sourceDirectory.replaceAll('/', '\\');
  try {
    sources = Object.fromEntries(await Promise.all(WORK_COMMANDS.map(async name => {
      const file = path.join(sourceRoot, `${name}.md`);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Invalid work command size');
      return [name, await fs.readFile(file, 'utf8')];
    })));
  } catch (error) {
    throw new Error(`无法读取 WSL Work 技能命令（${error.code || '文件无效'}），请确认 WSL 可访问后重试`);
  }
  for (const name of WORK_COMMANDS) {
    const sourceContent = sources[name];
    if (typeof sourceContent !== 'string' || !sourceContent || Buffer.byteLength(sourceContent, 'utf8') > 128 * 1024) {
      throw new Error(`The installed WSL OMP command ${name}.md is empty or too large`);
    }
    const content = adaptWorkCommandForWindows(sourceContent);
    const target = path.join(commandDir, `${name}.md`);
    let existing;
    try {
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Refusing non-regular OMP command target ${target}`);
      existing = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing !== undefined) {
      if (existing !== content) throw new Error(`An existing OMP command conflicts with ${name}; it was preserved`);
      pending.push({ name, path: target, content, added: false });
      continue;
    }
    pending.push({ name, path: target, content, added: true });
  }
  await fs.mkdir(commandDir, { recursive: true });
  const installed = [];
  for (const { name, path: target, content, added } of pending) {
    if (added) {
      const temporaryPath = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, target);
    }
    installed.push({ name, path: target, added, sha256: createHash('sha256').update(content).digest('hex') });
  }
  return { commandDir, commands: installed };
}

async function restoreWorkCommandMirrors(installation) {
  if (!installation || !Array.isArray(installation.commands)) {
    throw new TypeError('Command mirror installation state is required');
  }
  const results = [];
  for (const item of installation.commands) {
    if (!item.added) {
      results.push({ name: item.name, removed: false, reason: 'Pre-existing identical command' });
      continue;
    }
    const current = await fs.readFile(item.path, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (current === null) {
      results.push({ name: item.name, removed: false, reason: 'Already absent' });
      continue;
    }
    const hash = createHash('sha256').update(current).digest('hex');
    if (hash !== item.sha256) {
      results.push({ name: item.name, removed: false, reason: 'Changed since installation' });
      continue;
    }
    await fs.unlink(item.path);
    results.push({ name: item.name, removed: true });
  }
  return results;
}

async function restoreWorkSteleMcp(agentDir, installation) {
  if (typeof agentDir !== 'string' || !path.isAbsolute(agentDir)) {
    throw new TypeError('agentDir must be an absolute path');
  }
  if (!installation || typeof installation !== 'object' || !installation.serverDefinition) {
    throw new TypeError('The MCP installation state returned by installWorkSteleMcp is required');
  }
  const configPath = path.join(agentDir, 'mcp.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const current = config.mcpServers?.[SERVER_NAME];
  if (!jsonEqual(current, installation.serverDefinition)) {
    throw new Error('The Stele MCP config changed after installation and was preserved');
  }
  const servers = { ...config.mcpServers };
  if (installation.previousServer === null || installation.previousServer === undefined) delete servers[SERVER_NAME];
  else servers[SERVER_NAME] = installation.previousServer;
  const merged = { ...config, mcpServers: servers };
  const stats = await fs.stat(configPath);
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: stats.mode & 0o777 });
  await fs.chmod(temporaryPath, stats.mode & 0o777);
  await fs.rename(temporaryPath, configPath);
  return { configPath, restored: true };
}

module.exports = {
  SERVER_NAME,
  DEFAULT_DISTRO,
  DEFAULT_WSL_USER,
  toWslPath,
  wslUncPath,
  workSkillDirectory,
  workSkillDirectories,
  mergeWorkSkillSettings,
  adaptWorkCommandForWindows,
  workSteleServerDefinition,
  mergeWorkSteleMcpConfig,
  installWorkSteleMcp,
  restoreWorkSteleMcp,
  installWorkSkillDirectory,
  restoreWorkSkillDirectory,
  installWorkCommandMirrors,
  restoreWorkCommandMirrors,
};
