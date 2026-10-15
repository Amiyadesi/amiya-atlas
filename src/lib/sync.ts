export interface SyncStatus { configured: boolean; kind: "webdav" | "server"; url: string; username: string; automatic: boolean; lastSync: string | null; conflicts: string[]; }
export const emptySync: SyncStatus = { configured:false,kind:"webdav",url:"",username:"",automatic:false,lastSync:null,conflicts:[] };
