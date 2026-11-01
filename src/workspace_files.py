"""Relative, bounded file reads for the SSH workspace. No model or shell."""
import base64
import os
import hashlib
from pathlib import Path

IMAGES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp'}
TEXT={'.txt','.log','.json','.jsonl','.yaml','.yml','.toml','.xml','.csv','.ini','.cfg','.conf','.py','.js','.jsx','.ts','.tsx','.cjs','.mjs','.css','.scss','.html','.htm','.sh','.bash','.zsh','.ps1','.bat','.cmd','.c','.cc','.cpp','.h','.hpp','.rs','.go','.java','.kt','.swift','.sql','.vue','.svelte','.cmake'}


def kind(path):
    if path.suffix.lower() in ('.md','.markdown'):return 'markdown'
    if path.suffix.lower() in IMAGES:return 'image'
    if path.suffix.lower() in TEXT or path.name.lower() in ('dockerfile','makefile','cmakelists.txt','license','.gitignore','.gitattributes','.editorconfig'):return 'text'
    return 'file'


def location(root,reference='',base=''):
    if not isinstance(root,str) or not root.startswith('/') or any(c in root for c in '\0\r\n'):raise ValueError('无效工作根')
    root=Path(root)
    if root.is_symlink():raise ValueError('工作根不能是链接')
    root=root.resolve(strict=True)
    if not root.is_dir():raise ValueError('无效工作根')
    if not isinstance(reference,str) or len(reference)>4096 or '\0' in reference or not isinstance(base,str) or '\0' in base:raise ValueError('无效文件路径')
    candidate=((root/base).parent if base else root)/reference
    target=candidate.resolve(strict=True)
    if not target.is_relative_to(root):raise ValueError('只能读取当前工作区内的文件')
    return root,target


def listing(root,directory='',options=None):
    options=options or {};root,target=location(root,directory)
    query=options.get('query','');offset=options.get('offset',0)
    if not isinstance(query,str) or len(query)>200 or not isinstance(offset,int) or isinstance(offset,bool) or offset<0 or offset>1000000:raise ValueError('无效目录筛选')
    entries=sorted([p for p in target.iterdir() if (options.get('showHidden') is True or not p.name.startswith('.')) and query.strip().casefold() in p.name.casefold()],key=lambda p:(not p.is_dir(),p.name.casefold()))
    rows=[]
    for p in entries[offset:offset+200]:
        try:p.name.encode('utf-8','strict')
        except UnicodeEncodeError:
            rows.append(dict(name='无法显示的文件名',path='unsupported-'+hashlib.sha256(os.fsencode(p.name)).hexdigest(),kind='blocked',link=False,reason='文件名不是 UTF-8，请在远端终端处理'))
            continue
        k='directory' if p.is_dir() else kind(p) if p.is_file() else 'file';reason=None
        if p.is_symlink():
            try:
                if not p.resolve(strict=True).is_relative_to(root):k='blocked';reason='链接目标在当前工作区之外'
            except OSError:k='blocked';reason='链接目标无法读取'
        rows.append(dict(name=p.name,path=p.relative_to(root).as_posix(),kind=k,link=p.is_symlink(),reason=reason))
    return dict(directory=target.relative_to(root).as_posix().removeprefix('.'),entries=rows,total=len(entries),nextOffset=offset+len(rows) if offset+len(rows)<len(entries) else None)


def read(root,reference,base=''):
    root,target=location(root,reference,base);k=kind(target)
    if not target.is_file() or k=='file':raise ValueError('此文件类型不支持预览')
    # A complete response fits the existing 2 MiB host frame, including base64.
    with target.open('rb') as stream:data=stream.read(1024*1024+1)
    if len(data)>1024*1024:raise ValueError('文件超过远端预览上限（1 MiB），请在远端查看')
    result=dict(kind=k,name=target.name,path=target.relative_to(root).as_posix())
    if k=='image':result['dataUrl']='data:'+IMAGES[target.suffix.lower()]+';base64,'+base64.b64encode(data).decode('ascii')
    else:
        if b'\0' in data:raise ValueError('文件包含二进制数据')
        try:result['content']=data.decode('utf-8')
        except UnicodeDecodeError:raise ValueError('文件不是 UTF-8 编码，无法安全预览') from None
    return result
