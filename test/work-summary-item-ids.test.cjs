const test = require('node:test');
const assert = require('node:assert/strict');
const {projectSummaryItems} = require('../src/work-summary-item-ids.cjs');

const item = (id, text) => ({id, text, sources: [{sessionId: 'private-journal', messageId: 'private-message', quote: 'PRIVATE_ORIGINAL_QUOTE'}]});

test('model summary handles are short and section-scoped while durable IDs and source quotes stay in the host', () => {
  const original = {overview: item('overview', '工作概况'), goals: [item('si-3d75a70f661a6f4dacf822e6', '目标')],
    progress: [item('si-8762f32d08159ab062a029de', '进展'), item('si-7919c049e7727a03bd55d6bd', '另一项进展')]};
  const copy = structuredClone(original);
  const {summary, itemIds} = projectSummaryItems(original);
  assert.deepEqual(summary.progress.map(row => row.id), ['p1', 'p2']);
  assert.deepEqual(itemIds.get('p1'), {section: 'progress', id: 'si-8762f32d08159ab062a029de'});
  assert.deepEqual(itemIds.get('g1'), {section: 'goals', id: 'si-3d75a70f661a6f4dacf822e6'});
  assert.equal(itemIds.has('n1'), false);
  assert.equal(summary.overview.sourceCount, 1);
  assert.ok(!/si-|PRIVATE_ORIGINAL_QUOTE|private-journal|private-message/.test(JSON.stringify(summary)));
  assert.deepEqual(original, copy);
});

test('summary item maps are local to each projection and never share identities between Works or revisions', () => {
  const first = projectSummaryItems({nextSteps: [item('stable-work-one', '下一步')]}).itemIds;
  const second = projectSummaryItems({nextSteps: [item('stable-work-two', '下一步')]}).itemIds;
  assert.deepEqual(first.get('n1'), {section: 'nextSteps', id: 'stable-work-one'});
  assert.deepEqual(second.get('n1'), {section: 'nextSteps', id: 'stable-work-two'});
  first.delete('n1');
  assert.equal(second.size, 1);
  const empty = projectSummaryItems(null);
  assert.equal(empty.summary, null);
  assert.equal(empty.itemIds.size, 0);
});
