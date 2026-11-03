import type {Desktop} from './types';
import {errorText} from './errors';

export function isWorkspaceReference(src: string) {
  return !!src && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src);
}

export function mediaErrorText(error: unknown) {
  const text = errorText(error);
  if (/ENOENT|ENOTDIR|No such file/i.test(text)) return '文件不存在或已移动';
  if (/EACCES|EPERM|Permission denied/i.test(text)) return '没有权限读取此文件';
  return text || '图片无法读取，请重试';
}

// One loader per conversation/host. Only coalesce requests in flight: an image
// regenerated at the same path must be readable again without restarting.
export function createWorkspaceMedia(root: string, hostId: string | undefined, read: Desktop['readPreview']) {
  const pending = new Map<string, ReturnType<Desktop['readPreview']>>();
  const open = (href: string) => {
    if (!isWorkspaceReference(href)) return Promise.reject(Error('此链接不是工作区文件路径'));
    const [rawPath, rawAnchor] = href.split('#');
    let reference: string, anchor: string | undefined;
    try { reference = decodeURIComponent(rawPath.split('?')[0]); anchor = rawAnchor ? decodeURIComponent(rawAnchor) : undefined; }
    catch { return Promise.reject(Error('文件链接的编码无效')); }
    if (!reference) return Promise.reject(Error('文件链接缺少路径'));
    let request = pending.get(reference);
    if (!request) {
      request = read(root, reference, undefined, hostId);
      pending.set(reference, request);
      const clear = () => {if (pending.get(reference) === request) pending.delete(reference);};
      void request.then(clear, clear);
    }
    return request.then(file => ({...file, anchor}));
  };
  return {open, resolveImage: async (src: string) => {
    const file = await open(src);
    if (file.kind !== 'image' || !file.dataUrl) throw Error('此文件不是可预览的图片');
    return file.dataUrl;
  }};
}
