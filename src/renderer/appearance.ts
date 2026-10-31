export type VisualTheme = 'classic' | 'blue';

export const visualThemes: {id: VisualTheme; name: string; description: string}[] = [
  {id: 'blue', name: '蓝调工作室', description: '深墨蓝导航 · 浅蓝工作目录 · 明亮阅读面'},
  {id: 'classic', name: '经典原色', description: '保留原有的中性配色与紧凑布局'},
];

export const visualThemeKey = 'lucyna.visual-theme';
export function readVisualTheme(): VisualTheme {
  return localStorage.getItem(visualThemeKey) === 'classic' ? 'classic' : 'blue';
}
