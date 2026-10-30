const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const defaults=()=>({version:1,protocol:'chat-completions',baseURL:'',model:'',autoTitle:false,timeoutSeconds:30});
function validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('辅助模型设置格式无效');
  const value={...defaults(),...input};
  if(value.version!==1||!['chat-completions','responses'].includes(value.protocol)||typeof value.autoTitle!=='boolean'||!Number.isInteger(value.timeoutSeconds)||value.timeoutSeconds<5||value.timeoutSeconds>120)throw Error('辅助模型协议或超时设置无效');
  for(const key of ['baseURL','model'])if(typeof value[key]!=='string'||value[key].length>2048||/[\x00-\x1f\x7f]/.test(value[key]))throw Error('辅助模型字段无效：'+key);
  const baseURL=value.baseURL.trim().replace(/\/+$/,''),model=value.model.trim();
  if(baseURL){let url;try{url=new URL(baseURL);}catch{throw Error('请输入完整的辅助模型 API 地址');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('API 地址只支持不含凭据、查询参数和片段的 HTTP(S) 地址');}
  if(model.length>200)throw Error('模型名称过长');
  if(value.autoTitle&&(!baseURL||!model))throw Error('启用自动命名前，请填写 API 地址和模型名称');
  return {version:1,protocol:value.protocol,baseURL,model,autoTitle:value.autoTitle,timeoutSeconds:value.timeoutSeconds};
}
class AuxiliarySettings {
  constructor(directory,secure){this.file=path.join(directory,'auxiliary-settings.json');this.secure=secure;this.revision=0;this.saving=false;}
  available(){return this.secure.isAsyncEncryptionAvailable?this.secure.isAsyncEncryptionAvailable():this.secure.isEncryptionAvailable();}
  async decrypt(buffer){return this.secure.decryptStringAsync?(await this.secure.decryptStringAsync(buffer)).result:this.secure.decryptString(buffer);}
  encrypt(text){return this.secure.encryptStringAsync?this.secure.encryptStringAsync(text):this.secure.encryptString(text);}
  async read(){try{const raw=JSON.parse(await fs.readFile(this.file,'utf8'));return {...validate(raw),encryptedKey:typeof raw.encryptedKey==='string'?raw.encryptedKey:''};}catch(e){if(e.code==='ENOENT')return {...defaults(),encryptedKey:''};throw Error('辅助模型设置无法读取，原文件已保留');}}
  public(value){const {encryptedKey,...settings}=value;return {...settings,hasApiKey:!!encryptedKey};}
  async get(){return this.public(await this.read());}
  async resolve(input){
    const saved=await this.read(),settings=validate(input||saved);
    if(input?.clearApiKey!==undefined&&typeof input.clearApiKey!=='boolean')throw Error('清除密钥选项无效');
    if(input?.apiKey!==undefined&&(typeof input.apiKey!=='string'||input.apiKey.length>8192||/[\x00-\x20\x7f]/.test(input.apiKey)))throw Error('API Key 格式无效');
    let apiKey=input?.apiKey||'';
    if(!apiKey&&!input?.clearApiKey&&saved.encryptedKey){if(!await this.available())throw Error('系统密钥存储暂不可用，请稍后重试');try{apiKey=await this.decrypt(Buffer.from(saved.encryptedKey,'base64'));}catch{throw Error('已保存的 API Key 无法解密，请重新填写');}}
    return {...settings,apiKey};
  }
  async save(input){
    if(this.saving)throw Error('辅助模型设置正在保存，请稍候');this.saving=true;
    try{
      const resolved=await this.resolve(input),settings=validate(resolved);
      if(resolved.apiKey&&!await this.available())throw Error('系统密钥存储不可用，API Key 未保存');
      const value={...settings,encryptedKey:resolved.apiKey?(await this.encrypt(resolved.apiKey)).toString('base64'):''};
      await fs.mkdir(path.dirname(this.file),{recursive:true});
      try{await fs.copyFile(this.file,this.file+'.bak');}catch(e){if(e.code!=='ENOENT')throw e;}
      const temp=this.file+'.'+randomUUID()+'.tmp';
      try{await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temp,this.file);}finally{await fs.unlink(temp).catch(()=>{});}
      this.revision++;return this.public(value);
    }finally{this.saving=false;}
  }
}
module.exports={AuxiliarySettings,defaults,validate};
