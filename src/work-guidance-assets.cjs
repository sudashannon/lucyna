const {createHash} = require('node:crypto');
const {classifyWorkAsset, sensitiveDocument} = require('./work-knowledge-policy.cjs');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identityKey = identity => JSON.stringify([identity.hostId || '', identity.root]);
const safeRelative = value => typeof value === 'string' && value.length <= 4096
  && value.length > 0 && !/^[\\/]|^[a-z]:|[\x00-\x1f]/i.test(value)
  && !value.split(/[\\/]/).includes('..');

// Recommendations contain catalog metadata only. Bodies are read through the
// existing Work material service after the user selects a recommendation.
class WorkGuidanceAssets {
  constructor({resolveWork, details, knowledge, clock = Date.now, ttlMs = 30000}) {
    Object.assign(this, {resolveWork, details, knowledge, clock, ttlMs});
    this.cache = new Map();
    this.pending = new Map();
    this.detailsCache = new Map();
  }

  observe(identity, detail) {
    if (identity.hostId || !Array.isArray(detail?.assets)) return;
    const key = identityKey(identity);
    this.detailsCache.delete(key);
    this.detailsCache.set(key, {at: this.clock(), detail});
    this.cache.delete(key);
    while (this.detailsCache.size > 32) this.detailsCache.delete(this.detailsCache.keys().next().value);
  }

  async catalog(identity, {refresh = false} = {}) {
    await this.resolveWork(identity);
    if (identity.hostId) return {assets: [], available: false, notice: '远端 Work 暂未接入资产推荐，可继续使用会话上下文补全。'};
    const key = identityKey(identity);
    const cached = this.cache.get(key);
    if (!refresh && cached && this.clock() - cached.at < this.ttlMs) return cached.value;
    if (this.pending.has(key)) return this.pending.get(key);
    const operation = this.collect(identity, {refresh}).then(value => {
      this.cache.delete(key);
      this.cache.set(key, {at: this.clock(), value});
      while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  async collect(identity, {refresh = false} = {}) {
    const cached = this.detailsCache.get(identityKey(identity));
    const details = !refresh && cached && this.clock() - cached.at < this.ttlMs
      ? Promise.resolve(cached.detail)
      : this.details(identity.root).then(detail => { this.observe(identity, detail); return detail; });
    const [detail, saved] = await Promise.allSettled([
      details,
      this.knowledge('workAssetList', {root: identity.root}),
    ]);
    const rows = [], notices = [];
    const paths = new Set();
    if (detail.status === 'fulfilled') {
      for (const asset of detail.value.assets || []) {
        const policy = classifyWorkAsset(asset);
        const title = String(asset.title || asset.name || asset.path).slice(0, 240);
        if (!safeRelative(asset.path) || !policy.allowed || sensitiveDocument(title + '\n' + asset.path)) continue;
        paths.add(asset.path);
        rows.push({id: 'file-' + hash(asset.path), path: asset.path, title,
          kind: asset.kind, origin: 'work-file', snapshot: policy.snapshot,
          modifiedAt: asset.modifiedAt || '', size: Number(asset.size) || 0,
          version: hash([asset.path, asset.kind, asset.modifiedAt || '', asset.size, !!asset.directory])});
      }
    } else notices.push('Work 文件清单暂不可用。');
    if (saved.status === 'fulfilled') {
      for (const item of saved.value || []) {
        if (item.root !== identity.root || !safeRelative(item.relative) || paths.has(item.relative)) continue;
        const title = String(item.title || item.relative).slice(0, 240);
        if (sensitiveDocument(title + '\n' + item.relative)) continue;
        const policy = classifyWorkAsset({path: item.relative, kind: item.kind});
        if (!policy.allowed) continue;
        rows.push({id: 'saved-' + hash(item.id), path: item.relative, title,
          kind: item.kind || 'note', origin: 'saved', snapshot: !!item.metadata?.snapshot,
          modifiedAt: item.metadata?.createdAt || '', savedId: item.id,
          savedRevision: item.revision, sourceHash: item.metadata?.sourceHash || null,
          version: hash([item.id, item.revision, item.metadata?.sourceHash, item.metadata?.hash])});
      }
    } else notices.push('已保存资料暂不可用。');
    rows.sort((a, b) => (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0));
    const limited = rows.length > 160;
    if (limited) notices.push('仅推荐最近 160 项资料，其他资料仍可在资产页查看。');
    return {assets: rows.slice(0, 160), available: detail.status === 'fulfilled' || saved.status === 'fulfilled',
      notice: notices.join(' '), limited};
  }

  async list(identity) {
    const catalog = await this.catalog(identity);
    return {...catalog, assets: catalog.assets.map(({savedId, savedRevision, size, sourceHash, ...item}) => item)};
  }

  async read(identity, selected) {
    const catalog = await this.catalog(identity, {refresh: true});
    const asset = catalog.assets.find(row => row.id === selected.id);
    if (!asset || asset.version !== selected.version) throw Error('资料来源已变化，请刷新建议后重新选择。');
    let saved;
    if (asset.origin === 'work-file') {
      saved = await this.knowledge('workAssetCapture', {root: identity.root, path: asset.path});
      const capturedTime = Date.parse(saved.metadata?.locator?.modifiedAt || '');
      const catalogTime = Date.parse(asset.modifiedAt || '');
      if (Number.isFinite(catalogTime) && capturedTime !== catalogTime
        || saved.metadata?.sourceSize !== undefined && saved.metadata.sourceSize !== asset.size) {
        this.cache.delete(identityKey(identity));
        throw Error('读取期间资料已变化，请刷新建议后重新选择。');
      }
    } else saved = {id: asset.savedId, revision: asset.savedRevision};
    const result = await this.knowledge('workAssetRead', {root: identity.root, id: saved.id});
    if (result.root !== identity.root || result.relative !== asset.path || result.revision !== saved.revision) {
      this.cache.delete(identityKey(identity));
      throw Error('资料快照已变化，请重新选择。');
    }
    const content = typeof result.content === 'string' ? result.content : null;
    if (content && sensitiveDocument(content)) throw Error('资料包含疑似凭据，请先脱敏后再引用。');
    return {id: asset.id, root: identity.root, path: asset.path, title: asset.title,
      origin: asset.origin, version: asset.version, snapshotVersion: result.revision,
      sourceHash: result.metadata?.sourceHash || null,
      snapshot: !!result.metadata?.snapshot, content: content?.slice(0, 16000) ?? null,
      truncated: (content?.length || 0) > 16000};
  }
}

module.exports = {WorkGuidanceAssets};
