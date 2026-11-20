// Private, persistent metadata cache on the existing Docker state volume.
// The cache is only committed after the database acknowledges the index batch.
import fs from 'node:fs/promises';
import path from 'node:path';
export function unchanged(cached,stat){return !!cached&&cached.mtime===stat.mtimeMs&&cached.size===stat.size;}
export async function loadFileIndex(filename){try{const saved=JSON.parse(await fs.readFile(filename,'utf8'));if(saved.version!==1||!Array.isArray(saved.tracks))throw Error('invalid index');return {token:String(saved.token||''),tracks:new Map(saved.tracks.filter(t=>t?.id&&typeof t.path==='string').map(t=>[t.id,t]))};}catch{return {token:'',tracks:new Map()};}}
export async function saveFileIndex(filename,tracks,token){await fs.mkdir(path.dirname(filename),{recursive:true});const tmp=filename+'.tmp';await fs.writeFile(tmp,JSON.stringify({version:1,token,tracks:[...tracks.values()]}),{mode:0o600});await fs.rename(tmp,filename);}
