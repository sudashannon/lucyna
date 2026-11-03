// Git/manifest health is independent of directory access and OMP journals.
// Discovery is the allowlist; only a missing, linked or unreadable root blocks
// directory-based operations. Git services retain their own member checks.
function canAccessWorkRoot(work){
  return !!work&&typeof work.root==='string'&&work.root.startsWith('/')&&!/[\0\r\n]/.test(work.root)
    &&work.rootAvailable!==false&&!(work.issues||[]).some(issue=>['root_invalid','scan_failed'].includes(issue.code));
}
function requireWorkRoot(works,root){
  const work=works.find(work=>work.root===root&&!work.hostId);
  if(!canAccessWorkRoot(work))throw Error('无效工作根：工作目录不存在、不可访问或不在当前工作区列表中');
  return work;
}
module.exports={canAccessWorkRoot,requireWorkRoot};
