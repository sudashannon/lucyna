import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  root: 'src/renderer', base: './', plugins: [react()],
  resolve: { alias: { '@cindy': path.resolve('src/renderer/vendor/cindy') } },
  // The running desktop can still reference an older hashed asset. The normal
  // build command stages and publishes atomically; direct Vite builds also retain it.
  build: { commonjsOptions:{include:[/node_modules/,/run-outcome\.cjs$/]}, outDir: '../../dist/renderer', emptyOutDir: false, assetsInlineLimit: 0, rollupOptions: {output: {manualChunks(id) {
    if (!id.includes('node_modules')) return;
    if (id.includes('@xterm')) return 'terminal';
    if (/react-markdown|highlight|remark|rehype|micromark|hast|unist|mdast/.test(id)) return 'markdown';
    if (/react|radix|scheduler/.test(id)) return 'react-ui';
  }}} },
  server: { host: '127.0.0.1', port: 5177, strictPort: true },
});
