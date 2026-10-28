const path=require('node:path');
module.exports={applicationIcon:path.join(__dirname,'assets',process.platform==='win32'?'app-icon.ico':'app-icon.png'),trayIcon:path.join(__dirname,'assets/tray-icon.png')};
