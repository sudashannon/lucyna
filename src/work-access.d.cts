export function canAccessWorkRoot(work: {root?:unknown;rootAvailable?:boolean;issues?:{code:string}[]}|null|undefined): boolean;
export function requireWorkRoot<T extends {root:string;hostId?:string;rootAvailable?:boolean;issues?:{code:string}[]}>(works:T[],root:string):T;
