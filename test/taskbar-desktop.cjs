// Native Windows integration check; no OMP, WSL or user profile is opened.
const {app,BrowserWindow,nativeImage,shell}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {configureAppIdentity,appId}=require('../src/app-identity.cjs');
const {installTaskbarIdentity,taskbarDetails}=require('../src/windows-taskbar.cjs');
const {applicationIcon}=require('../src/app-icon.cjs');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna taskbar '));
app.commandLine.appendSwitch('user-data-dir',profile);
configureAppIdentity(app,{});
const details=installTaskbarIdentity(app),applied=[];
const setDetails=BrowserWindow.prototype.setAppDetails;
BrowserWindow.prototype.setAppDetails=function(value){applied.push({window:this.id,details:value});return setDetails.call(this,value);};

app.whenReady().then(async()=>{
  try{
    if(process.platform!=='win32'){console.log('Windows taskbar check skipped on this platform');app.quit();return;}
    assert.equal(details.appId,appId);
    assert.equal(details.relaunchDisplayName,'Lucyna');
    const args=`"${app.getAppPath()}" "--user-data-dir=${app.getPath('userData')}"`;
    assert.equal(details.relaunchCommand,`"${process.execPath}" ${args}`);
    assert.equal(details.appIconPath.includes('app.asar'),false);
    assert.ok(fs.readFileSync(details.appIconPath).equals(fs.readFileSync(applicationIcon)));
    assert.equal(nativeImage.createFromPath(details.appIconPath).isEmpty(),false);
    const packaged=taskbarDetails({isPackaged:true,getPath:key=>app.getPath(key)});
    assert.equal(packaged.relaunchCommand,`"${process.execPath}" "--user-data-dir=${app.getPath('userData')}"`);
    const shortcut=path.join(profile,'Lucyna.lnk');
    assert.ok(shell.writeShortcutLink(shortcut,{target:process.execPath,args,appUserModelId:appId,icon:details.appIconPath,iconIndex:0,description:'Lucyna'}));
    const link=shell.readShortcutLink(shortcut);
    assert.equal(link.appUserModelId,appId);assert.equal(link.icon,details.appIconPath);assert.equal(link.args,args);
    const win=new BrowserWindow({title:'Lucyna · 任务栏图标验收',icon:applicationIcon,width:560,height:260,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    const secondary=new BrowserWindow({show:false,icon:applicationIcon});
    assert.deepEqual(applied.map(x=>x.window),[win.id,secondary.id]);
    assert.ok(applied.every(x=>x.details.appIconPath===details.appIconPath));
    secondary.destroy();
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html lang="zh-CN"><title>Lucyna · 任务栏图标验收</title><style>body{font:16px system-ui;background:#f9f9f8;padding:24px;color:#272b2d}h1{font-size:22px}</style><h1>Lucyna · 任务栏图标验收</h1><p>请查看 Windows 底部任务栏中的图标是否为猫咪 Logo。</p><p>此窗口仅测试图标，不连接任何会话。</p></html>'));
    console.log(JSON.stringify({passed:true,checks:['native window taskbar properties','external ICO readable by Windows','native shortcut icon and AppID round-trip','absolute source relaunch command','packaged relaunch command','secondary windows'],profile}));
    if(process.argv.includes('--preview')){win.show();return;}
    app.quit();
  }catch(error){console.error(error.stack);app.exit(1);}
});
app.on('window-all-closed',()=>app.quit());
