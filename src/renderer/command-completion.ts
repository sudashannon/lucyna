export interface SlashCommand {
  name: string; aliases?: string[]; description?: string; input?: {hint?: string};
  subcommands?: {name: string; description?: string; usage?: string}[]; source: string;
}
export const desktopCommands: SlashCommand[] = [
  {name: 'resume', description: '打开历史会话，选择后继续', source: 'desktop'},
  {name: 'new', description: '结束空闲连接，开始新会话', source: 'desktop'},
  {name: 'model', aliases: ['models'], description: '打开 OMP 模型选择面板', source: 'desktop'},
];
export function normalizeCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) throw new Error('OMP 返回的技能与命令目录格式无效');
  const seen = new Set<string>();
  return value.flatMap(item => {
    if (!item || typeof item.name !== 'string' || !item.name || /[\s/\0]/.test(item.name) || seen.has(item.name)) return [];
    seen.add(item.name);
    return [{name: item.name, source: typeof item.source === 'string' ? item.source : 'native',
      aliases: Array.isArray(item.aliases) ? item.aliases.filter((x: unknown) => typeof x === 'string' && x && !/[\s/\0]/.test(x)) : [],
      description: typeof item.description === 'string' ? item.description : '',
      input: typeof item.input?.hint === 'string' ? {hint: item.input.hint} : undefined,
      subcommands: Array.isArray(item.subcommands) ? item.subcommands.filter((x: any) => typeof x?.name === 'string' && x.name && !/[\s/\0]/.test(x.name)).map((x: any) => ({name: x.name, description: typeof x.description === 'string' ? x.description : '', usage: typeof x.usage === 'string' ? x.usage : ''})) : [],
    }];
  });
}
export function commandCatalog(native: SlashCommand[]): SlashCommand[] {
  const overrides = new Set(desktopCommands.flatMap(c => [c.name, ...(c.aliases || [])]));
  return [...desktopCommands, ...native.filter(c => !overrides.has(c.name))];
}
export const sourceLabel = (source: string) => ({desktop: '工作台', builtin: 'OMP 命令', skill: '技能', extension: '扩展', custom: '自定义', file: '文件命令', mcp_prompt: 'MCP 提示词'}[source] || 'OMP');
export function findCommand(name: string, commands: SlashCommand[]): SlashCommand | undefined {
  return commands.find(c => c.name === name || c.aliases?.includes(name));
}
export type CompletionContext = {kind: 'command' | 'subcommand'; query: string; from: number; to: number; parent?: SlashCommand};
export function completionContext(text: string, caret: number, end: number, commands: SlashCommand[], manual = false): CompletionContext | null {
  const token = /^(\s*)\/([^\s]*)/.exec(text);
  if (manual) return {kind: 'command', query: '', from: token ? token[1].length : 0, to: token ? token[0].length : 0};
  if (caret !== end || !token || /[\r\n]/.test(token[1])) return null;
  const from = token[1].length, to = token[0].length;
  if (caret > from && caret <= to) return {kind: 'command', query: text.slice(from + 1, caret), from, to};
  const parent = findCommand(token[2], commands);
  if (!parent?.subcommands?.length || caret <= to) return null;
  const args = /^([ \t]+)([^\s]*)/.exec(text.slice(to));
  if (!args) return null;
  const argFrom = to + args[1].length, argTo = to + args[0].length;
  return caret >= argFrom && caret <= argTo ? {kind: 'subcommand', query: text.slice(argFrom, caret), from: argFrom, to: argTo, parent} : null;
}
export interface CommandSuggestion {key: string; name: string; insert: string; description: string; source: string; hint?: string; aliases?: string[]}
export function suggestionsFor(context: CompletionContext, commands: SlashCommand[], filter: 'all' | 'skills' | 'commands' = 'all'): CommandSuggestion[] {
  const items: CommandSuggestion[] = context.kind === 'subcommand'
    ? (context.parent?.subcommands || []).map(c => ({key: `${context.parent!.name}/${c.name}`, name: c.name, insert: c.name, description: c.description || '', source: context.parent!.source, hint: c.usage}))
    : commands.filter(c => filter === 'all' || (filter === 'skills' ? c.source === 'skill' : c.source !== 'skill')).map(c => ({key: c.name, name: `/${c.name}`, insert: `/${c.name}`, description: c.description || '', source: c.source, hint: c.input?.hint, aliases: c.aliases}));
  const query = context.query.toLocaleLowerCase();
  const ranked = items.map((item, index) => {
    const name = item.name.replace(/^\//, '').toLocaleLowerCase(), short = name.replace(/^skill:/, ''), aliases = (item.aliases || []).map(x => x.toLocaleLowerCase());
    const rank = !query ? 0 : name === query || short === query || aliases.includes(query) ? 0 : name.startsWith(query) ? 1 : short.startsWith(query) || aliases.some(a => a.startsWith(query)) ? 2 : name.includes(query) || aliases.some(a => a.includes(query)) ? 3 : item.description.toLocaleLowerCase().includes(query) ? 4 : 99;
    return {item, index, rank};
  });
  return ranked.filter(x => x.rank < 99).sort((a,b) => a.rank - b.rank || a.index - b.index).map(x => x.item);
}
export function applyCompletion(text: string, context: CompletionContext, suggestion: CommandSuggestion): {text: string; caret: number} {
  const tail = text.slice(context.to), spacer = /^[ \t]/.test(tail) ? '' : ' ';
  const replacement = suggestion.insert + spacer;
  return {text: text.slice(0, context.from) + replacement + tail, caret: context.from + replacement.length + (spacer ? 0 : 1)};
}
export function commandHint(text: string, commands: SlashCommand[]): string {
  const parsed = /^\s*\/([^\s]+)[ \t]+([^\r\n]*)/.exec(text);
  if (!parsed) return '';
  const command = findCommand(parsed[1], commands); if (!command) return '';
  const sub = command.subcommands?.find(c => c.name === parsed[2].trim().split(/\s/)[0]);
  return sub ? `/${parsed[1]} ${sub.name}${sub.usage ? ` ${sub.usage}` : ''} · ${sub.description || command.description || ''}` : `/${parsed[1]}${command.input?.hint ? ` ${command.input.hint}` : ''} · ${command.description || ''}`;
}
