// Fault injection for isolated SSH acceptance, never selected by the application.
const fs = require('node:fs');
const {deployFrozen} = require('../../src/hosts/ssh-frozen.cjs');
const {runSSH} = require('../../src/hosts/ssh-executor.cjs');
const [profile, bundle, prefix, fault] = process.argv.slice(2);
const execute = (config, args, options) => {
  if (Buffer.isBuffer(options.input)) {
    const bytes = Buffer.from(options.input);
    if (fault === 'corrupt') bytes[0] ^= 1;
    options = {...options, input: fault === 'truncate' ? bytes.subarray(0, Math.floor(bytes.length / 2)) : bytes};
  }
  return runSSH(config, args, options);
};
deployFrozen(JSON.parse(fs.readFileSync(profile, 'utf8')), bundle, {prefix, mode: 'connection', execute})
  .then(value => process.stdout.write(JSON.stringify({ok: true, value})))
  .catch(error => process.stdout.write(JSON.stringify({ok: false, code: error.code, message: error.message})));
