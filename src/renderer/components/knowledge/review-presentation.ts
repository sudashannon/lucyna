import type {KnowledgeReview} from '../../knowledge-types';

export type ReviewPresentation={label:string;summary:string;guidance:string};

type SectionType='proposal'|'design'|'report';
const sectionTerms:Record<SectionType,{label:string;aliases:string[]}[]>={
  proposal:[
    {label:'背景或动机',aliases:['why','背景','动机']},
    {label:'方案或改动',aliases:['what change','方案','改动']},
  ],
  design:[{label:'目标、决策或风险',aliases:['goal','decision','risk','目标','决策','风险','trade']}],
  report:[{label:'验证结果或结论',aliases:['pass','fail','验证','结论']}],
};

function missingSectionGuidance(detail:string):ReviewPresentation{
  const match=/^type\s+(proposal|design|report)\s+missing:\s*(.+)$/i.exec(detail.trim());
  if(!match)return {label:'缺少类型要点',summary:'自动检查未在正文中找到该类文档要求的要点词。',guidance:'对照原文和下方检查详情，补充需要的内容后重新检查。'};
  const kind=match[1].toLowerCase() as SectionType,expressions=match[2].split(';').map(value=>value.trim().toLocaleLowerCase());
  const missing=sectionTerms[kind].filter(group=>expressions.some(expression=>group.aliases.some(alias=>expression.includes(alias.toLocaleLowerCase()))));
  const names=missing.map(group=>group.label);
  const typeLabel=kind==='proposal'?'提案':kind==='design'?'设计文档':'报告';
  if(!names.length)return {label:'缺少类型要点',summary:`自动检查未在这份${typeLabel}中找到所需要点词。`,guidance:'对照原文和下方检查详情，补充需要的内容后重新检查。'};
  return {label:'缺少类型要点',summary:`这份${typeLabel}中未检测到${names.join('、')}相关要点词。`,guidance:`对照原文补充${names.join('、')}相关内容，然后重新检查。`};
}

const presentations:Record<string,ReviewPresentation>={
  orphan:{label:'缺少文档关联',summary:'没有找到这篇文档与其他文档之间的链接。',guidance:'如果它属于某个主题，可在原文中补充相关链接；如果它是一篇独立笔记，可以忽略此版本。'},
  'orphan-component':{label:'缺少文档关联',summary:'没有找到这篇文档与其他文档之间的链接。',guidance:'如果它属于某个主题，可在原文中补充相关链接；如果它是一篇独立笔记，可以忽略此版本。'},
  'dead-link':{label:'链接目标未找到',summary:'原文中的链接指向一个当前路径下找不到的目标。',guidance:'打开原文，检查目标是否已移动、路径是否写错；修正链接后重新检查。'},
  duplicate:{label:'标题重复',summary:'另有已索引文档使用了相同标题。',guidance:'确认读者能区分这些文档；必要时将标题改得更具体。'},
  'low-link-density':{label:'缺少正式关联',summary:'已有文档链接指向这里，但尚未找到正式的关联记录。',guidance:'检查是否需要补充元数据或约定的内部关联；若现有链接已足够，可忽略此版本。'},
  'missing-sections':missingSectionGuidance(''),
  'low-quality':{label:'内容可能待完善',summary:'自动检查发现正文可能偏短、结构不足或含有未完成标记。',guidance:'打开原文判断这些信号是否影响使用，再决定是否补充内容。'},
  'design-no-plan':{label:'设计缺少计划引用',summary:'这项变更已创建超过三天，已有设计文档，但还没有找到计划引用。',guidance:'确认这项设计是否需要实施计划；若需要，将计划关联到该变更。'},
  'stale-active':{label:'变更状态待更新',summary:'这项变更尚未归档，创建已超过两周。',guidance:'核对当前进度，继续推进、更新状态或归档已结束的变更。'},
  'mermaid-syntax':{label:'图表语法需修正',summary:'原文中的 Mermaid 图表代码存在语法问题。',guidance:'打开原文，检查对应的 Mermaid 图表并修正语法。'},
  'task-artifact-missing':{label:'任务产物缺失',summary:'自动检查未找到这项任务对应的文件产物。',guidance:'确认该任务是否需要产物；需要时补齐文件，不需要时调整任务清单。'},
  'stale-claim':{label:'结论依据待核实',summary:'这条结论的引用证据需要重新核验。',guidance:'查看结论和引用证据，再确认仍适用、撤回结论或转为待办。'},
  'stale-evidence':{label:'证据需要更新',summary:'这条知识关联的证据可能已变化。',guidance:'打开原文核对当前证据；必要时更新引用，再重新检查。'},
};

const fallback:ReviewPresentation={label:'需要核实',summary:'自动检查发现一项需要结合原文判断的问题。',guidance:'打开原文核对后，再选择忽略此版本或转为待办。'};

export function reviewPresentation(issue:KnowledgeReview['issue']):ReviewPresentation{
  return issue.rule==='missing-sections'?missingSectionGuidance(issue.detail):presentations[issue.rule]||fallback;
}
