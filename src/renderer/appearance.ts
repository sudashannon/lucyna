export type VisualTheme = 'classic' | 'blue' | 'folio' | 'pixel';

export const visualThemes: {id: VisualTheme; name: string; description: string}[] = [
  {id: 'blue', name: '蓝调工作室', description: '深墨蓝导航 · 浅蓝工作目录 · 明亮阅读面'},
  {id: 'folio', name: '纸页研读室', description: '深绿书架 · 暖纸阅读面 · 舒展的文字层级'},
  {id: 'pixel', name: '像素工作室', description: '位图字标 · 紧凑导航 · 利落的方形控件'},
  {id: 'classic', name: '经典原色', description: '保留原有的中性配色与紧凑布局'},
];

export const visualThemeKey = 'lucyna.visual-theme';
export function readVisualTheme(): VisualTheme {
  const stored = localStorage.getItem(visualThemeKey);
  return visualThemes.find(theme => theme.id === stored)?.id ?? 'blue';
}
