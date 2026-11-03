export interface AssetPolicy {category:string;label:string;action:string;snapshot:boolean;allowed:boolean;reason:string}
export function classifyWorkAsset(asset:{path?:string;name?:string;kind?:string;directory?:boolean;unavailable?:string;size?:number}):AssetPolicy;
export function sensitiveDocument(text:string):string;
