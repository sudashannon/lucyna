import type {Work} from './types';
export const workKey = (work: Pick<Work,'root'|'hostId'>) => work.hostId ? JSON.stringify([work.hostId,work.root]) : work.root;
export const sameWork = (a: Pick<Work,'root'|'hostId'>,b: Pick<Work,'root'|'hostId'>) => workKey(a)===workKey(b);
