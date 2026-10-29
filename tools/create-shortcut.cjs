// Run with Electron: tools/create-shortcut.cjs <absolute .lnk> <existing profile>.
const {app,shell}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {appId}=require('../src/app-identity.cjs');
const {applicationIcon}=require('../src/app-icon.cjs');
const {launchArguments}=require('../src/windows-taskbar.cjs');
const [output,directory]=process.argv.slice(2);
if(!output||!path.isAbsolute(output)||!output.endsWith('.lnk')||!directory||!path.isAbsolute(directory))throw Error('Specify an absolute .lnk path and existing profile directory');
if(fs.existsSync(output))throw Error('Shortcut already exists; choose a new output path');
const profile=path.dirname(fs.realpathSync.native(path.join(directory,'.omp-cindy-data-root'))),root=path.resolve(__dirname,'..');
// This helper must never open Chromium against the running client's profile.
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-shortcut-')));
app.whenReady().then(()=>{
 const args=launchArguments({isPackaged:false,getAppPath:()=>root,getPath:()=>profile});
 const options={target:process.execPath,cwd:root,args,appUserModelId:appId,icon:applicationIcon,iconIndex:0,description:'Lucyna 工作台'};
 if(!shell.writeShortcutLink(output,'create',options))throw Error('Unable to create shortcut');
 const saved=shell.readShortcutLink(output);
 for(const key of ['target','cwd','args','appUserModelId','icon'])if(saved[key]!==options[key])throw Error('Shortcut verification failed: '+key);
 console.log(JSON.stringify({created:output,target:saved.target,profile,verified:true}));app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
