const sections = [
  ['goals', 'g'], ['decisions', 'd'], ['progress', 'p'],
  ['openQuestions', 'q'], ['nextSteps', 'n'],
];

// Keep durable item identities in the host. Each model request gets short,
// section-specific handles that can only resolve through this request's map.
function projectSummaryItems(value) {
  const itemIds = new Map();
  if (!value) return {summary: null, itemIds};
  const project = (item, id) => ({id, text: item.text, sourceCount: item.sources?.length || 0});
  const summary = {overview: value.overview ? project(value.overview, 'overview') : null};
  for (const [section, prefix] of sections) {
    summary[section] = (value[section] || []).map((item, index) => {
      if (typeof item?.id !== 'string' || !item.id) throw Error('摘要条目缺少稳定身份');
      const id = prefix + (index + 1);
      itemIds.set(id, {section, id: item.id});
      return project(item, id);
    });
  }
  return {summary, itemIds};
}

module.exports = {projectSummaryItems};
