// Explicit fallback to the preserved vanilla renderer.
const { spawn } = require('node:child_process');
const path = require('node:path');
const child = spawn(require('electron'), [path.resolve(__dirname, '..')], {stdio: 'inherit', env: {...process.env, OMP_CINDY_LEGACY_UI: '1'}});
child.on('exit', code => process.exit(code ?? 0));
