const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {configureAppIdentity}=require('../src/app-identity.cjs');
function fixture(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-identity-')),paths={appData:directory,userData:path.join(directory,'Lucyna'),sessionData:path.join(directory,'Lucyna')};return{directory,paths,app:{getPath:key=>paths[key],setPath:(key,value)=>paths[key]=value,setName(value){this.name=value;}}};}
test('formal rename retains existing settings, history and Chromium draft storage',()=>{
 const f=fixture(),old=path.join(f.directory,'omp-cindy');fs.mkdirSync(path.join(old,'IndexedDB'),{recursive:true});
 fs.writeFileSync(path.join(old,'client-settings.json'),'{"runtime":"wsl"}');fs.writeFileSync(path.join(old,'history.json'),'existing history');fs.writeFileSync(path.join(old,'IndexedDB','draft-fixture'),'unsent draft');
 const root=configureAppIdentity(f.app,{});assert.equal(f.app.name,'Lucyna');assert.equal(root,fs.realpathSync.native(old));assert.equal(f.paths.userData,root);assert.equal(f.paths.sessionData,root);assert.equal(configureAppIdentity(f.app,{}),root);
 assert.equal(fs.readFileSync(path.join(root,'client-settings.json'),'utf8'),'{"runtime":"wsl"}');assert.equal(fs.readFileSync(path.join(root,'history.json'),'utf8'),'existing history');assert.equal(fs.readFileSync(path.join(f.paths.sessionData,'IndexedDB','draft-fixture'),'utf8'),'unsent draft');assert.equal(fs.existsSync(path.join(f.directory,'Lucyna')),false);
});
test('both old and new profile overrides remain isolated; relative paths are rejected',()=>{
 const f=fixture(),old=path.join(f.directory,'old-override'),next=path.join(f.directory,'new-override');
 assert.equal(configureAppIdentity(f.app,{OMP_CINDY_USERDATA:old}),fs.realpathSync.native(old));assert.equal(configureAppIdentity(f.app,{OMP_CINDY_USERDATA:old,LUCYNA_USERDATA:next}),fs.realpathSync.native(next));
 assert.throws(()=>configureAppIdentity(f.app,{LUCYNA_USERDATA:'relative'}),/must be absolute/);
});
test('Explorer and taskbar launches retain the explicitly selected physical profile',()=>{
 const f=fixture(),directory=path.join(f.directory,'existing profile');
 f.app.commandLine={getSwitchValue:()=>directory};
 assert.equal(configureAppIdentity(f.app,{}),fs.realpathSync.native(directory));
 assert.equal(f.paths.sessionData,f.paths.userData);
 const override=path.join(f.directory,'env-profile');assert.equal(configureAppIdentity(f.app,{LUCYNA_USERDATA:override}),fs.realpathSync.native(override));
 f.app.commandLine.getSwitchValue=()=> 'relative';assert.throws(()=>configureAppIdentity(f.app,{}),/must be absolute/);
});
