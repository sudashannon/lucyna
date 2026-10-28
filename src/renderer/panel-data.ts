export interface MemoryHit { title: string; kind: string; source: string; tags: string[]; excerpt: string; metadata: string; raw: string }
export function parseMemory(text: string) {
  const sections = text.split(/^## /m), documents = sections.find(s => /^Documents\s*\n/.test(s));
  const hits: MemoryHit[] = [];
  if (documents) for (const match of documents.matchAll(/^- \[([^\]]+)\] (.+)\n([\s\S]*?)(?=^- \[|$(?![\s\S]))/gm)) {
    const [, kind, header, body] = match;
    const title = header.replace(/ \([^\n]*, rank [\d.]+[^\n]*\)$/, '');
    const lines = body.split('\n'), source = lines.find(l => /^\s+(?:\/|[A-Z]:\\)/.test(l))?.trim() || '';
    const tags = (lines.find(l => /^\s+tags:/.test(l)) || '').replace(/^\s+tags:\s*/, '').split(',').map(s => s.trim()).filter(Boolean);
    const split = lines.findIndex(l => /^\s+---\s*$/.test(l));
    const excerpt = (split >= 0 ? lines.slice(split + 1) : lines.filter(l => !/^\s+(?:\/|tags:|snapshot:)/.test(l)))
      .filter(l => !/^(?:---\s*$|(?:title|tags|wiki|date|created|updated):)/.test(l.trim())).join('\n').trim();
    hits.push({title, kind, source, tags, excerpt, metadata: [header.slice(title.length).trim(), ...lines.slice(0, split < 0 ? 0 : split).filter(l => l.trim() !== source && !/^\s+tags:/.test(l))].join('\n').trim(), raw: match[0]});
  }
  const extra = sections.slice(1).filter(s => !/^Documents\s*\n/.test(s)).map(s => ({title: s.split('\n')[0].trim(), text: s.slice(s.indexOf('\n') + 1).trim(), stale: /stale|re-verify/i.test(s.split('\n')[0])}));
  return {hits, extra, fallback: !hits.length ? text : ''};
}
export const plainText = (text: string) => text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/__([^_\n]+)__/g, '$1').replace(/(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, '$1').replace(/~~(.+?)~~/g, '$1').replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/gm, '').trim();
export function workOutline(text: string) {
  // Extract source sections; never infer live project status from an old journal.
  const sections: {title: string; content: string}[] = [];
  let fence = false; const tasks: string[] = []; let completed = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^##\s+(.+)$/.exec(line);
    if (!fence && /^\s*[-*] \[ \]/.test(line)) tasks.push(plainText(line));
    if (!fence && /^\s*[-*] \[[xX]\]/.test(line)) completed++;
    if (heading) sections.push({title: heading[1], content: ''});
    else if (sections.length) sections[sections.length - 1].content += line + '\n';
  }
  return {sections, tasks, completed};
}
export function documentHeadings(text: string) {
  let fence = false; const counts = new Map<string, number>();
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && (/^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line) || (line.trim() && !/^\s*[-*>|]/.test(line) && /^\s*(?:={3,}|-{3,})\s*$/.test(lines[index + 1] || '') ? ['', lines[index + 1].trim().startsWith('=') ? '#' : '##', line] : null));
    if (!match) return [];
    const title = plainText(match[2]), base = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    const count = counts.get(base) || 0; counts.set(base, count + 1);
    return [{title, level: match[1].length, id: count ? `${base}-${count}` : base, line: index + 1}];
  });
}
