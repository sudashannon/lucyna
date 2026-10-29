const path = require('node:path');

// Stele owns indexing, file boundaries and knowledge semantics. This adapter is
// deliberately a bounded, read-only bridge, never a second knowledge store.
function createKnowledgeReader(fetchImpl = fetch, {origin = 'http://127.0.0.1:18989'} = {}) {
  let catalog, loaded = 0, pending;
  async function read(route, params, format = 'json', limit = 8 * 1024 * 1024) {
    const url = new URL(route, origin);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(url, {signal: controller.signal, redirect: 'error'});
      if (!response.ok) {await response.body?.cancel(); throw new Error(`Stele 读取失败（${response.status}）`);}
      const reader = response.body.getReader(), chunks = []; let length = 0;
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        length += value.length;
        if (length > limit) {await reader.cancel(); throw new Error('内容过大，请在 Stele 中打开');}
        chunks.push(Buffer.from(value));
      }
      const body = Buffer.concat(chunks);
      if (format === 'image') {
        const mime = (response.headers.get('content-type') || '').split(';')[0];
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('此图片格式不支持预览');
        return `data:${mime};base64,${body.toString('base64')}`;
      }
      return format === 'text' ? body.toString('utf8') : JSON.parse(body.toString('utf8'));
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Stele 读取超时，请稍后重试');
      if (error.message === 'fetch failed') throw new Error('无法连接 Stele，请检查 WSL 中的 Stele 服务（18989）');
      throw error;
    } finally {clearTimeout(timer);}
  }
  async function getCatalog(force = false) {
    if (!force && catalog && Date.now() - loaded < 30000) return catalog;
    if (!pending) pending = Promise.all([read('/api/workspaces'), read('/api/wiki/index')]).then(([workspaces, documents]) => {
      if (!Array.isArray(workspaces) || !Array.isArray(documents)) throw new Error('Stele 索引格式不兼容');
      catalog = {workspaces, documents, fetchedAt: new Date().toISOString()}; loaded = Date.now(); return catalog;
    }).finally(() => {pending = null;});
    return pending;
  }
  async function component(id) {
    if (typeof id !== 'string' || !id || id.length > 4096) throw new Error('无效的知识文档');
    let found = (await getCatalog()).documents.find(doc => doc.id === id);
    if (!found) found = (await getCatalog(true)).documents.find(doc => doc.id === id);
    if (!found) throw new Error('文档未被 Stele 索引，请刷新知识库或在 Stele 中查看来源');
    return found;
  }
  return async function knowledge(kind, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('无效的知识库请求');
    switch (kind) {
      case 'catalog': return getCatalog(args.refresh === true);
      case 'candidates': return (await read('/api/wiki/candidates')) || [];
      case 'reviews': {
        // The native scanner can report the same finding more than once when
        // a document repeats a broken link. Its canonical ID is the identity.
        const findings = (await read('/api/wiki/reviews')) || [];
        return [...new Map(findings.map(finding => [finding.id, finding])).values()];
      }
      case 'document': {
        const doc = await component(args.id);
        const [body, relations] = await Promise.allSettled([
          read('/api/artifact', {path: doc.path, workspace: doc.workspace}, 'text', 2 * 1024 * 1024),
          read('/api/wiki/component/x', {id: doc.id}),
        ]);
        return {component: doc, content: body.status === 'fulfilled' ? body.value : '',
          contentError: body.status === 'rejected' ? body.reason.message : '',
          forward: relations.status === 'fulfilled' ? relations.value.forward || [] : [],
          backlinks: relations.status === 'fulfilled' ? relations.value.backlinks || [] : [],
          relationsError: relations.status === 'rejected' ? relations.reason.message : ''};
      }
      case 'image': {
        const doc = await component(args.id), src = args.src;
        if (typeof src !== 'string' || src.length > 4096 || /^(?:[a-z]+:|\/\/)/i.test(src)) throw new Error('只读取文档内的本地图片');
        const image = path.posix.resolve(path.posix.dirname(doc.path), decodeURIComponent(src).split(/[?#]/)[0]);
        const workspace = (await getCatalog()).workspaces.find(space => space.alias === doc.workspace);
        const root = workspace?.path?.replace(/\/$/, '');
        if (!root || !image.startsWith(root + '/') || !/\.(png|jpe?g|webp|gif)$/i.test(image)) throw new Error('图片不在文档的知识库来源内');
        return read('/api/artifact', {path: image, workspace: doc.workspace}, 'image', 10 * 1024 * 1024);
      }
      default: throw new Error('不支持的知识库操作');
    }
  };
}
module.exports = {createKnowledgeReader};
