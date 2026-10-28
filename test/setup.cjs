// Unit tests never inherit a developer's real work roots or private provider hook.
process.env.LUCYNA_CONFIG=require('node:path').resolve(__dirname,'fixtures/runtime.json');
