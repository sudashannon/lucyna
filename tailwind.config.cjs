module.exports = {
  content: ['./src/renderer/**/*.{html,tsx,ts}', './node_modules/streamdown/dist/*.js'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: { extend: {
    fontSize: Object.fromEntries([10,11,12,13,14,15,16,18,20,24,28].map(n => [String(n), [`var(--text-${n})`, { lineHeight: '1.5' }]])),
    colors: { 'titlebar-icon': 'hsl(var(--titlebar-icon))', 'titlebar-button-hover': 'var(--titlebar-button-hover)',
      background: 'var(--surface-elevated)', foreground: 'var(--text-primary)', border: 'var(--border-default)',
      muted: {DEFAULT: 'var(--surface-hover-soft)', foreground: 'var(--muted-readable)'},
      sidebar: 'var(--code-bg)', primary: 'var(--text-primary)',
    },
    animation: { spinner: 'spin var(--motion-spinner-cycle, 1000ms) linear infinite', 'fade-in': 'appear var(--motion-fast) var(--motion-ease-out)', 'float-out': 'disappear var(--motion-exit) var(--motion-ease-in)' },
  } }, plugins: [],
};
