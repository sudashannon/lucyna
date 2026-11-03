// One policy is shared by the renderer and the trusted capture service.
function classifyWorkAsset(asset){
 const name=String(asset.path||asset.name||'').replaceAll('\\','/');
 if(/(?:^|\/)(?:\.env(?:\.|$)|\.ssh(?:\/|$)|auth\.json$|credentials?(?:\.|$)|secrets?(?:\.|$))|\.(?:pem|key|pfx|p12)$/i.test(name))return {category:'excluded',label:'不入库',action:'不入库',snapshot:false,allowed:false,reason:'认证、密钥与敏感配置保留在原有凭据系统'};
 if(asset.unavailable)return {category:'unavailable',label:'来源不可用',action:'来源不可用',snapshot:false,allowed:false,reason:String(asset.unavailable)};
 if(asset.directory)return {category:'reference',label:'目录引用',action:'登记目录引用',snapshot:false,allowed:true,reason:'只保存目录位置与归属，不递归复制目录'};
 if(asset.kind==='note')return {category:'work-note',label:'Work 专属资料',action:'保存为工作资料',snapshot:true,allowed:true,reason:'保存当前笔记快照；可复用结论需审核后另行提炼，不自动成为共享知识'};
 if(asset.kind==='log')return {category:'work-record',label:'过程归档',action:'归档过程记录',snapshot:true,allowed:true,reason:'保留当时的过程和出处，不进入全局知识检索'};
 if(asset.kind==='script')return {category:'script-reference',label:'脚本引用',action:'登记脚本引用',snapshot:false,allowed:true,reason:'登记路径、大小与内容摘要；脚本原件留在 Work，不复制为知识、不执行'};
 if(asset.kind==='evidence'&&/\.(?:png|jpe?g|webp|gif|pdf)$/i.test(name)&&Number(asset.size||0)<=10*1024*1024)return {category:'evidence-copy',label:'证据附件',action:'保存证据副本',snapshot:true,allowed:true,reason:'作为 Work 内证据附件保留，不把原始图片或报告自动认定为结论'};
 return {category:'evidence-reference',label:'原始资料引用',action:'登记证据引用',snapshot:false,allowed:true,reason:'原始日志、数据、固件和大文件保留原件，仅登记版本与引用'};
}
function sensitiveDocument(text){
 const patterns=[[/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,'私钥内容'],[/\b(?:sk-[A-Za-z0-9_-]{24,}|hf_[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/,'疑似访问凭据'],[/https?:\/\/[^\s/:@]+:[^\s/@]+@/,'带口令的地址']];
 for(const [pattern,reason] of patterns)if(pattern.test(text))return reason;
 for(const match of text.matchAll(/(?:password|passwd|api[_ -]?key|access[_ -]?token|密码|口令)\s*[:=：]\s*[`"']?([^\s`"',;#]{4,120})/gi)){
  const value=match[1];if(/^(?:\$|<|\{|\[|\*|x{3,}|your[_-]|不|无|未|已|通过|使用|见|环境|变量|读取|配置)/i.test(value)||/^(?:example|demo|fixture|test|none|null|true|false)$/i.test(value))continue;
  if(/[a-zA-Z0-9]/.test(value)&&/[\d@!$%^&*_-]/.test(value))return '疑似明文凭据';
 }
 return '';
}
module.exports={classifyWorkAsset,sensitiveDocument};
