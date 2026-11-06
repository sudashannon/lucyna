import {useLayoutEffect, useMemo, useRef} from 'react';
import {Diff, Hunk, parseDiff} from 'react-diff-view';
import 'react-diff-view/style/index.css';

// react-diff-view is the reusable MIT-licensed viewer also used by GitBench.
// Rendering is read-only; a truncated response is never an editable patch.
export default function WorkspaceDiff({text, split, focusRange}: {text:string;split:boolean;focusRange?:[number,number]}) {
  const container = useRef<HTMLDivElement>(null);
  const parsed=useMemo(()=>{if(!/^diff --git /m.test(text))return null;try{return parseDiff(text);}catch{return null;}},[text]);
  useLayoutEffect(()=>{
    if (!focusRange) return;
    const target = container.current?.querySelector('.code-review-focused-line');
    target?.scrollIntoView({block:'center',behavior:'smooth'});
  }, [focusRange?.[0], focusRange?.[1], parsed]);
  if(!text)return <p className="wf-empty">当前比较范围内没有差异。</p>;
  if(!parsed?.length||parsed.reduce((n,f)=>n+f.hunks.reduce((m,h)=>m+h.changes.length,0),0)>3000)
    return <div ref={container} className="wf-raw-diff"><p className="wf-caption">此差异以原始文本显示。</p><pre>{text}</pre></div>;
  return <div ref={container} className="wf-diff">{parsed.map((file,i)=><section key={i} className="wf-diff-file">
    <h3>{file.newPath==='/dev/null'?file.oldPath:file.newPath}</h3>
    {file.hunks.length?<Diff viewType={split?'split':'unified'} diffType={file.type} hunks={file.hunks}
      generateLineClassName={({changes,defaultGenerate})=>{
        if (!focusRange) return defaultGenerate();
        const [start,end]=focusRange;
        const focused=changes.some(change=>{
          const newLine=change.type==='normal'?change.newLineNumber:change.type==='insert'?change.lineNumber:undefined;
          return newLine!==undefined&&newLine>=start&&newLine<=end;
        });
        return focused?`${defaultGenerate()} code-review-focused-line`:defaultGenerate();
      }}>
      {hunks=>hunks.map((hunk,index)=><Hunk key={index} hunk={hunk}/>)}</Diff>
      :<p className="wf-empty">文件内容没有可显示的文本差异，可能是二进制、重命名或文件属性变化。</p>}
  </section>)}</div>;
}
