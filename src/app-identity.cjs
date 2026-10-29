const path=require('node:path');
const {resolveDataRoot}=require('./data-root.cjs');
const productName='Lucyna',storageName='omp-cindy',appId='io.github.sudashannon.lucyna';

function configureAppIdentity(app,env=process.env){
  const variable=env.LUCYNA_USERDATA?'LUCYNA_USERDATA':env.OMP_CINDY_USERDATA?'OMP_CINDY_USERDATA':'--user-data-dir';
  const override=variable==='--user-data-dir'?app.commandLine?.getSwitchValue('user-data-dir'):env[variable];
  if(override&&!path.isAbsolute(override))throw Error(variable+' must be absolute');
  // Electron derives userData from productName. Keep both application files and
  // Chromium's IndexedDB/localStorage at the existing root across the rename.
  const directory=resolveDataRoot(override||path.join(app.getPath('appData'),storageName));
  app.setName(productName);
  if(process.platform==='win32'&&app.setAppUserModelId)app.setAppUserModelId(appId);
  app.setPath('userData',directory);
  app.setPath('sessionData',directory);
  return directory;
}
module.exports={productName,appId,configureAppIdentity};
