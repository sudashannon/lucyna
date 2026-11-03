export function settledOutcome(run:{active:boolean;phase?:string;outcome?:'completed'|'aborted'|'error'}|null,event:Record<string,any>):'completed'|'aborted'|'error'|null;
