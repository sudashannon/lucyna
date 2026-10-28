// Reproducible extraction of the pure UI components; no Cindy agent code is imported.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const upstream = path.resolve('work/references/cindy');
const source = path.join(upstream, 'apps/desktop/src/renderer');
const target = path.resolve('src/renderer/vendor/cindy');
const revision = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
const files = ['components/ui/button.tsx', 'components/ui/button.css', 'components/ui/spinner.tsx', 'components/ui/tooltip.tsx', 'components/ui/segmented-control.tsx', 'components/ui/segmented-control.css', 'components/ui/input.tsx', 'components/sidebar/SidebarIconButton.tsx', 'components/sidebar/AttentionDot.tsx', 'components/layout/RightSidebarToggle.tsx', 'lib/utils.ts', 'styles/generated/token-mappings.ts', 'styles/generated/tokens.css'];
for (const file of files) {
  const dest = path.join(target, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let text = fs.readFileSync(path.join(source, file), 'utf8');
  text = text.replaceAll("'@/", "'@cindy/");
  if (file.endsWith('AttentionDot.tsx')) text = text.replace("import type { AttentionKind } from '@cindy/lib/sessionAttentionStore';", "// Adapter: retain the upstream type without importing its session store.\ntype AttentionKind = 'done' | 'awaiting' | 'error';");
  if (file.endsWith('segmented-control.css')) text = text.replace(/transform var\(--motion-base\) var\(--motion-ease-move\),\s*width var\(--motion-base\) var\(--motion-ease-move\),\s*height var\(--motion-base\) var\(--motion-ease-move\);/, 'transform var(--motion-base) var(--motion-ease-move);');
  if (file.endsWith('styles/generated/tokens.css')) text = text.replace(/^\s*--font-weight-(normal|medium|semibold):[^\n]+\n/gm, '');
  if (file.endsWith('button.css')) text = text.replace('inset var(--motion-instant)', 'transform var(--motion-instant)').replace('inset: calc(var(--space-px) - var(--button-face-outset, 0px));', 'transform: scale(0.96);').replace('inset: calc(0px - var(--button-face-outset, 0px));\n  }', 'transform: none;\n  }');
  fs.writeFileSync(dest, `/* SPDX-License-Identifier: Apache-2.0\n * Cindy ${revision} / ${file}\n * Local adaptations are listed in PROVENANCE.md.\n */\n` + text);
}
for (const file of ['LICENSE', 'NOTICE']) if (fs.existsSync(path.join(upstream, file))) fs.copyFileSync(path.join(upstream, file), path.join(target, file));
const colors = fs.readFileSync(path.join(source, 'themes/colors.ts'), 'utf8');
const start = colors.indexOf('{', colors.indexOf('const GENERATED_DEFAULTS'));
const end = colors.indexOf('} as const;', start) + 1;
const defaults = JSON.parse(colors.slice(start, end));
fs.writeFileSync(path.join(target, 'colors.css'), `/* Cindy ${revision}: generated default-light/default-dark semantic colors. Apache-2.0. */\n` + ['light', 'dark'].map(theme => `${theme === 'light' ? ':root' : ':root[data-theme="dark"]'} {\n` + Object.entries(defaults).map(([key, value]) => `  --${key}: ${value[theme]};`).join('\n') + '\n}').join('\n'));
fs.writeFileSync(path.join(target, 'PROVENANCE.md'), `# Cindy component reuse\n\nSource: https://github.com/makecindy/cindy/tree/${revision}/apps/desktop/src/renderer\n\nRevision: ${revision}. License: Apache-2.0; LICENSE and NOTICE retained beside these files.\n\nCopied: ${files.join(', ')}; semantic colors extracted from themes/colors.ts.\n\nLocal changes: alias imports use @cindy; AttentionKind is an equivalent local type instead of importing the Cindy session store; segmented indicator dimensions change instantly while its position animates with transform. The shell/composer/session integration is new OMP code, inspired by Cindy layout, and does not copy its agent harness.\n\nRun node tools/vendor-cindy.cjs only after explicitly updating and reviewing the upstream checkout.\n`);
fs.appendFileSync(path.join(target, 'PROVENANCE.md'), '\nAdditional adapters: button face press uses transform instead of inset; unused font-weight custom properties are omitted while equivalent Tailwind weights are retained. App tokens separately override placeholder/boundary readability and graphite CTA ink.\n');
console.log(`Vendored ${files.length} files from Cindy ${revision}`);
