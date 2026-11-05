const test=require('node:test');
const assert=require('node:assert/strict');
const {addEvidence,resolveEvidenceCitation}=require('../src/work-evidence.cjs');
const {validateSummary}=require('../src/work-assistant.cjs');

test('host excerpts remain bounded exact source text across Unicode and chunk boundaries',()=>{
  for(const text of ['不要','一'.repeat(639)+'😀尾部','条目说明\n'.repeat(300),'a'.repeat(640)+' short','  \n  ','完整说明 '.repeat(140)+'\n末尾','a'.repeat(600)+' '.repeat(40)+'end','a'.repeat(600)+' '.repeat(1600)+'end']){
    const map=new Map();
    const excerpts=addEvidence(text,'c1',{sessionId:'session',messageId:'message',role:'user'},map);
    assert.equal(excerpts.length,map.size);
    for(const excerpt of excerpts){
      const source=resolveEvidenceCitation({evidenceId:excerpt.evidenceId},map);
      assert.equal(source.quote,excerpt.text);
      assert.ok(text.includes(source.quote));
      assert.ok(source.quote.length<=800);
      assert.ok(source.quote.length>=Math.min(8,text.trim().length));
      assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(source.quote));
    }
  }
});

test('a model-selected ID cannot override canonical quotations or cite outside the current request',()=>{
  const map=new Map();
  const text='用户确认先汇总多个会话的决定，再安排下一步。';
  const [excerpt]=addEvidence(text,'c1',{sessionId:'canonical-session',messageId:'canonical-message',role:'user'},map);
  const source={evidenceId:excerpt.evidenceId};
  const sent=new Map([[JSON.stringify(['canonical-session','canonical-message']),{role:'user',text}]]);
  const summary={overview:{text:'先整理跨会话决定。',sources:[source]},goals:[],decisions:[],progress:[],openQuestions:[],nextSteps:[]};
  assert.equal(validateSummary(summary,sent,map).overview.sources[0].quote,text);
  for(const invalid of [{evidenceId:'c99.1'},{...source,quote:'改写的假引用'},{...source,role:'assistant'},{...source,sessionId:'other'},excerpt.evidenceId]){
    assert.equal(resolveEvidenceCitation(invalid,map),null);
    assert.throws(()=>validateSummary({...summary,overview:{...summary.overview,sources:[invalid]}},sent,map),/可核对来源/);
  }
  assert.throws(()=>validateSummary(summary,new Map(),map),/可核对来源/,'the canonical citation must still exist in the sent source snapshot');
});
