const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {appId,productName}=require('./app-identity.cjs');
const {applicationIcon}=require('./app-icon.cjs');

// Windows parses a command line here (not a shell command). In particular, quote
// the absolute application directory: a taskbar launch has no project cwd.
function quoteArgument(value){
  return '"'+String(value).replace(/(\\*)"/g,'$1$1\\"').replace(/\\+$/g,'$&$&')+'"';
}

function launchArguments(app){
  return [...(app.isPackaged?[]:[app.getAppPath()]),'--user-data-dir='+app.getPath('userData')].map(quoteArgument).join(' ');
}

function taskbarDetails(app){
  const bytes=fs.readFileSync(applicationIcon);
  const hash=createHash('sha256').update(bytes).digest('hex').slice(0,16);
  // Explorer cannot read an icon inside app.asar. Also resolve the physical file
  // because a packaged parent (e.g. Codex) can virtualize its AppData writes.
  const folder=path.join(app.getPath('userData'),'icons');
  fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,`lucyna-${hash}.ico`);
  if(!fs.existsSync(file)||!fs.readFileSync(file).equals(bytes))fs.writeFileSync(file,bytes);
  return {
    appId,appIconPath:fs.realpathSync.native(file),appIconIndex:0,
    relaunchCommand:quoteArgument(process.execPath)+' '+launchArguments(app),
    relaunchDisplayName:productName,
  };
}

function installTaskbarIdentity(app){
  if(process.platform!=='win32')return;
  const details=taskbarDetails(app);
  // A BrowserWindow icon and process AppUserModelID alone don't supply the
  // taskbar group's relaunch icon. Set all window properties before first show,
  // including secondary preview windows that may become the group's last one.
  app.on('browser-window-created',(_event,window)=>window.setAppDetails(details));
  return details;
}

module.exports={installTaskbarIdentity,taskbarDetails,launchArguments};
