const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const file=path.resolve(__dirname,'../src/renderer/panel-data.ts'),mod=new Module(file,module);
mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {parseMemory,workOutline,documentHeadings,plainText,memoryPreviewMarkdown}=mod.exports;
test('Stele context separates metadata from prose and preserves stale evidence',()=>{
 const result=parseMemory('# Context: query\n\n## Documents\n\n- [knowledge] First guide (project, rank 1.000; semantic-match)\n  /home/user/knowledge/first.md\n  tags: alpha, beta\n  snapshot: doc-v1:123 lines 1-3\n  ---\ntitle: First guide\ntags: [alpha]\n- [knowledge] Second guide (project, rank 0.9; tag-match)\n  /home/user/knowledge/second.md\n  tags: beta\n  ---\nActual useful paragraph.\n\n## Stale claims (re-verify before relying on these)\n\n- old evidence\n');
 assert.equal(result.hits.length,2); assert.equal(result.hits[0].title,'First guide');assert.equal(result.hits[0].excerpt,'');assert.deepEqual(result.hits[0].tags,['alpha','beta']);assert.match(result.hits[0].metadata,/snapshot/);assert.equal(result.hits[1].excerpt,'Actual useful paragraph.');assert.equal(result.extra[0].stale,true);assert.match(result.extra[0].text,/old evidence/);
});
test('unrecognized and empty results remain visible without inventing a record',()=>{for(const text of ['No matching documents.','# New format\nNot a document list']){const r=parseMemory(text);assert.equal(r.hits.length,0);assert.equal(r.fallback,text);}});
test('work outline extracts real checkboxes and ignores headings in code fences',()=>{const r=workOutline('# Project\n## Goal\nDescription\n```md\n## not a section\n```\n## Next\n- [ ] Actual todo\n- [x] Finished');assert.equal(r.sections.length,2);assert.deepEqual(r.tasks,['Actual todo']);assert.equal(r.completed,1);});
test('document outline supports Chinese headings and stable duplicate anchors',()=>{assert.deepEqual(documentHeadings('# 工作概览\n## Next\n## Next\n```md\n# skip\n```').map(h=>h.id),['工作概览','next','next-1']);});
test('summaries preserve code identifiers; setext headings retain source locations',()=>{assert.equal(plainText('`md_manu_toolkit` **状态**'),'md_manu_toolkit 状态');assert.deepEqual(documentHeadings('Title\n=====\n\n## Next').map(h=>[h.id,h.line]),[['title',1],['next',4]]);assert.equal(workOutline('## Example\n```md\n- [ ] example\n```\n- [ ] real').tasks.length,1);});

test('memory previews render table fragments without inventing missing column names or changing quoted evidence',()=>{
 const raw='|---|---|---|\n|loco_task|**运行中**|`tracking_rms=0.125`|';
 const preview=memoryPreviewMarkdown(raw);assert.equal(preview.tableFragment,true);assert.equal(preview.content,'| | | |\n|---|---|---|\n'+raw.split('\n')[1]);
 const context='## Documents\n\n- [knowledge] Table source (project, rank 1.0)\n  /wiki/source.md\n  ---\n'+raw;
 const result=parseMemory(context);assert.equal(result.hits[0].excerpt,raw);assert.ok(result.hits[0].raw.includes(raw));
 assert.equal(memoryPreviewMarkdown('|task|running|').tableFragment,true);
});

test('memory Markdown retains complete tables, formatting, escaped pipes, and code fences',()=>{
 const complete='**重点**与 `md_control`\n\n| 任务 | 状态 |\n| --- | --- |\n| 调查 | 已核对 |';assert.deepEqual(memoryPreviewMarkdown(complete),{content:complete,tableFragment:false});
 const fenced='```text\n|raw|pipes|\n~~~\n|still|code|\n```';assert.deepEqual(memoryPreviewMarkdown(fenced),{content:fenced,tableFragment:false});
 const escaped='|`a\\|b`|value|';assert.ok(memoryPreviewMarkdown(escaped).content.includes(escaped));assert.equal(memoryPreviewMarkdown('').content,'');
});

test('memory excerpt headings and task lists remain Markdown inside their source hit',()=>{
 const excerpt='## 调查结果\n\n- [x] 已完成\n- [ ] 待核实\n\n```python\nprint("literal")\n```';
 const parsed=parseMemory('## Documents\n\n- [knowledge] Source (project, rank 1.0)\n  /wiki/source.md\n  ---\n'+excerpt+'\n\n## Stale claims (re-verify before relying on these)\n\n- verify');
 assert.equal(parsed.hits.length,1);assert.equal(parsed.hits[0].excerpt,excerpt);assert.equal(parsed.extra.length,1);assert.equal(parsed.extra[0].stale,true);
});

test('current MCP context without a separator retains snapshot metadata and separates agent memory',()=>{
 const parsed=parseMemory('## Documents\n\n- [knowledge] Source (project, rank 1.000; literal-body)\n  /wiki/source.md\n  snapshot: doc-v1:123 lines 5-6 (literal-body)\n  **source text**\nnext line\n\n## Agent memory\n\n- remembered artifact');
 assert.equal(parsed.hits[0].excerpt,'**source text**\nnext line');assert.match(parsed.hits[0].metadata,/snapshot: doc-v1:123 lines 5-6/);assert.equal(parsed.extra[0].title,'Agent memory');
});
