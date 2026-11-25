// Docker-only music-root registry. The admin can register already-mounted
// container directories, but WASP never creates Docker bind mounts or writes audio.
import fs from 'node:fs/promises';
import path from 'node:path';
export const REGISTRY_PATH='/app/.wrangler/state/music-folders.json';
export function validMusicRoot(value){
  if(typeof value!=='string')return '';
  const s=value.trim();
  if(s.length>180||!s.startsWith('/')||s.includes('\\')||/\s/.test(s)||s.includes('\0')||s.includes('//')||s.endsWith('/')||s==='/'||!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(s))return '';
  // Do not scan internal app configuration, system trees, secrets or upload storage.
  if(!(/^\/music[\w-]*(?:\/[\w-]+)*$/.test(s)||/^\/mnt\/music[\w-]*(?:\/[\w-]+)*$/.test(s)||/^\/media\/music[\w-]*(?:\/[\w-]+)*$/.test(s)))return '';
  return path.posix.normalize(s);
}
export async function verifyMusicRoot(input,{fsApi=fs}={}){
  const root=validMusicRoot(input);if(!root)throw Error('Use an absolute container music path, such as /music2, /mnt/music2 or /media/music2.');
  const info=await fsApi.lstat(root).catch(()=>null);
  if(!info?.isDirectory()||info.isSymbolicLink())throw Error('This folder is not mounted or is not a regular directory in the container. Add its bind mount in Portainer first.');
  const real=await fsApi.realpath(root);
  if(real!==root)throw Error('Folder contains a symbolic-link path and cannot be scanned.');
  // Only accept actual container mounts, not directories created in the
  // image's writable layer. This survives a container recreation safely.
  const infoText=await fsApi.readFile('/proc/self/mountinfo','utf8').catch(()=>null);
  if(!infoText)throw Error('Cannot inspect container mounts. Verify this is a Docker deployment.');
  const mountPoints=new Set(infoText.split('\n').map(line=>line.split(' ')[4]).filter(Boolean)
    .map(value=>value.replace(/\\([0-7]{3})/g,(_,oct)=>String.fromCharCode(parseInt(oct,8)))));
  if(!mountPoints.has(root))throw Error('This path is not a Docker mount point. Bind the host folder to '+root+' in Portainer first.');
  await fsApi.readdir(root);
  return root;
}
export async function readMusicRoots(file=REGISTRY_PATH){
  try{const raw=JSON.parse(await fs.readFile(file,'utf8'));
    return Array.isArray(raw?.roots)?[...new Set(raw.roots.map(validMusicRoot).filter(Boolean))].slice(0,32):[];
  }catch(e){if(e.code==='ENOENT')return [];throw Error('Saved music-folder registry could not be read: '+e.message);}
}
export async function saveMusicRoots(roots,file=REGISTRY_PATH){
  if(!Array.isArray(roots)||roots.length>32||roots.some(v=>validMusicRoot(v)!==v))throw Error('Invalid music-folder registry.');
  await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';
  await fs.writeFile(tmp,JSON.stringify({version:1,roots},null,2),{mode:0o600});
  try{await fs.rename(tmp,file)}finally{await fs.unlink(tmp).catch(()=>{})}
}
export function combinedMusicRoots(base,additional){return [...new Set([...base,...additional])];}
