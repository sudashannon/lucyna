const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {installDesktopLog}=require('./desktop-log.cjs');
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-output-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const target={log(){},info(){},debug(){},warn(){},error(){}},stdout=new EventEmitter(),stderr=new EventEmitter();stdout.write=()=>true;stderr.write=()=>true;
 const logger=installDesktopLog(directory,{target,stdout,stderr});t.after(logger.restore);return{...logger,target,stdout,stderr,read:()=>fs.readFileSync(logger.file,'utf8')};
}
test('synchronous EPIPE preserves progress and subsequent failure diagnostics on disk',t=>{
 const f=fixture(t);let writes=0;f.stdout.write=()=>{writes++;throw Object.assign(Error('broken pipe'),{code:'EPIPE'});};
 f.target.log('PASS %s','first');f.target.log('PASS second');f.target.error(Error('real test assertion'));
 assert.equal(writes,1);assert.match(f.read(),/PASS first/);assert.match(f.read(),/PASS second/);assert.match(f.read(),/real test assertion/);assert.match(f.read(),/Output pipe closed/);
});
test('asynchronous stream EPIPE is handled for stdout and stderr without hiding other errors',t=>{
 const f=fixture(t);for(const stream of [f.stdout,f.stderr])stream.emit('error',Object.assign(Error('closed'),{code:'EPIPE'}));f.target.warn('failure after pipe closed');assert.match(f.read(),/failure after pipe closed/);
 assert.throws(()=>f.stdout.emit('error',Object.assign(Error('I/O failure'),{code:'EIO'})),/I\/O failure/);
 f.stderr.destroyed=true;f.target.error('still saved');assert.match(f.read(),/still saved/);
});
