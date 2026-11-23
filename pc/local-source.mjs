// WASP v18.1.5: optional Windows PC metadata source, launched via `npm run pc`.
// Only a read-only metadata feed is exposed to remote clients. Never serves MP3s.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat,readFile,mkdir,writeFile,rename,readdir,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {parseFile} from 'music-metadata';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=path.join(root,'.wasp-pc-data');
const port=Number(process.env.WASP_PC_PORT||8787);
const workerPort=Number(process.env.WASP_PC_WORKER_PORT||8788);
const feedPort=Number(process.env.WASP_PC_FEED_PORT||8792);
const maximum=100000;
const safe=(s,n=240)=>String(s??'').trim().slice(0,n);
const keyFor=(s)=>createHash('sha256').update(s.toLowerCase()).digest('hex');
const tagValues=(v,n=25)=>[...new Set((Array.isArray(v)?v:v?[v]:[]).map(x=>safe(x,160)).filter(Boolean))].slice(0,n);
const errorMessage=e=>safe(e?.message||e,180);
const tokenEqual=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&x.length>=32&&timingSafeEqual(x,y);};
const send=(res,obj,status=200)=>{res.writeHead(status,{'content-type':'application/json;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(obj));};
const tokenFile=path.join(dataDir,'source-token.txt');
async function persistedToken(){try{const s=(await readFile(tokenFile,'utf8')).trim();if(s.length>=32)return s;}catch{}const s=randomBytes(32).toString('hex');await writeFile(tokenFile,s,{mode:0o600,flag:'wx'}).catch(async()=>{});return (await readFile(tokenFile,'utf8')).trim();}
const snapshotFile=path.join(dataDir,'metadata-bank.json');
let entries=[],sequence=0,selectedFolder='',scan={state:'idle',processed:0,discovered:0,errors:0,skipped:0,changed:0,at:0,lastError:''};
async function restore(){try{const saved=JSON.parse(await readFile(snapshotFile,'utf8'));entries=Array.isArray(saved.entries)?saved.entries.filter(x=>x?.id&&x?.audio_sha256):[];sequence=Number(saved.sequence)||0;selectedFolder=safe(saved.folder,2048);scan={...scan,state:'idle',processed:entries.length,discovered:entries.length,at:saved.saved_at||0};}catch{}}
function syncsafe(b){return ((b[6]&127)<<21)|((b[7]&127)<<14)|((b[8]&127)<<7)|(b[9]&127);}
// Exact MP3 MPEG payload hash (excluding ID3v2 head and ID3v1 tail).
// No audio bytes leave this process; unsupported trailing APE tags are not stripped.
export function mp3AudioBounds(head,tail,size){let start=0,end=size;
 if(head.length>=10&&head.subarray(0,3).toString()==='ID3'&&[2,3,4].includes(head[3])){const n=10+syncsafe(head)+(head[5]&0x10?10:0);if(n<size)start=n;}
 if(tail.length>=128&&tail.subarray(tail.length-128,tail.length-125).toString()==='TAG')end-=128;
 return [start,end];
}
export async function fingerprintMP3(file){const st=await stat(file),fh=await open(file,'r');let start=0,end=st.size;
 try{const h=Buffer.alloc(10),t=Buffer.alloc(Math.min(128,st.size));await fh.read(h,0,10,0);if(t.length)await fh.read(t,0,t.length,st.size-t.length);[start,end]=mp3AudioBounds(h,t,st.size);}finally{await fh.close();}
 if(end<=start)throw Error('No audio payload');const digest=createHash('sha256');for await(const chunk of createReadStream(file,{start,end:end-1,highWaterMark:512*1024}))digest.update(chunk);
 return digest.digest('hex');
}
async function listMusic(folder){const files=[],todo=[folder];let visited=0;
 while(todo.length){const d=todo.pop();for(const item of await readdir(d,{withFileTypes:true})){if(item.isSymbolicLink())continue;const loc=path.join(d,item.name);if(item.isDirectory()){if(++visited>100000)throw Error('Directory traversal limit reached');todo.push(loc);}else if(item.isFile()&&/\.mp3$/i.test(item.name)){files.push(loc);if(files.length>maximum)throw Error('Maximum 100,000 MP3 files per scan');}}}
 return files.sort((a,b)=>a.localeCompare(b));
}
const nativeTags=(meta)=>{const record={};for(const frames of Object.values(meta.native||{}))for(const f of frames){const k=String(f.id||'').replace(/^TXXX:/i,'').toLowerCase();if(!k||/apic|cover|image|lyrics|private|geob|ufid|comment|url|password|secret/i.test(k))continue;const v=typeof f.value==='string'?f.value:typeof f.value==='number'?String(f.value):null;if(v){const values=record[k]||[];if(values.length<6)values.push(safe(v,300));record[k]=values;}}return record;};
async function readEntry(file,folder,previous){const st=await stat(file);const id=keyFor(path.relative(folder,file).replaceAll('\\','/'));if(previous?.size===st.size&&previous?.mtime===st.mtimeMs)return {...previous,_unchanged:true};
 const m=await parseFile(file,{duration:true,skipCovers:true});const c=m.common||{};
 const tags={title:safe(c.title||path.parse(file).name),artist:safe(c.artist),artists:tagValues(c.artists||c.artist),album:safe(c.album),album_artist:safe(c.albumartist),genre:tagValues(c.genre),date:safe(c.date,40),original_date:safe(c.originaldate||c.originalyear,40),year:Number(c.year)||null,track_no:Number(c.track?.no)||null,track_total:Number(c.track?.of)||null,disc_no:Number(c.disk?.no)||null,disc_total:Number(c.disk?.of)||null,duration:Math.round(Number(m.format?.duration||0)*100)/100,musicbrainz_recording_id:safe(c.musicbrainz_recordingid,60),musicbrainz_track_id:safe(c.musicbrainz_trackid,60),musicbrainz_release_id:safe(c.musicbrainz_albumid,60),musicbrainz_release_group_id:safe(c.musicbrainz_releasegroupid,60),musicbrainz_artist_ids:tagValues(c.musicbrainz_artistid),isrc:tagValues(c.isrc),label:tagValues(c.label),bpm:Number(c.bpm)||null,composer:tagValues(c.composer),native:nativeTags(m)};
 return {id,size:st.size,mtime:st.mtimeMs,seq:0,audio_sha256:await fingerprintMP3(file),tags};
}
async function scanFolder(folder){if(scan.state==='running')return false;
 scan={state:'running',processed:0,discovered:0,errors:0,skipped:0,changed:0,at:Date.now(),lastError:''};
 (async()=>{try{const resolved=path.resolve(folder),st=await stat(resolved);if(!st.isDirectory())throw Error('Not a directory');const files=await listMusic(resolved);scan.discovered=files.length;const old=new Map((selectedFolder===resolved?entries:[]).map(x=>[x.id,x]));const next=[];
 for(const file of files){try{const relative=path.relative(resolved,file).replaceAll('\\','/');const id=keyFor(relative);let entry=await readEntry(file,resolved,old.get(id));if(entry._unchanged){scan.skipped++;delete entry._unchanged;}else{entry.seq=++sequence;scan.changed++;}next.push(entry);}catch(e){scan.errors++;scan.lastError=errorMessage(e);const previous=old.get(keyFor(path.relative(resolved,file).replaceAll('\\','/')));if(previous)next.push(previous);}scan.processed++;}
 // Keep earlier metadata for files no longer on disk until explicitly replaced.
 // Never delete or change music files.
 entries=next;selectedFolder=resolved;const saved={folder:resolved,entries,sequence,saved_at:Date.now()};const tmp=snapshotFile+'.tmp';await writeFile(tmp,JSON.stringify(saved),{mode:0o600});await rename(tmp,snapshotFile);scan.state='complete';scan.at=Date.now();}catch(e){scan.state='error';scan.lastError=errorMessage(e);}})();return true;
}
const headersFrom=(incoming)=>{const h=new Headers();for(const [k,v] of Object.entries(incoming))if(!['host','connection','content-length','transfer-encoding','accept-encoding'].includes(k)&&typeof v==='string')h.set(k,v);return h;};
async function adminSession(req){const headers=headersFrom(req.headers);const r=await fetch(`http://127.0.0.1:${workerPort}/api/me`,{headers,redirect:'manual',signal:AbortSignal.timeout(5000)});return r.ok&&(await r.json()).admin===true;}
async function requestBody(req,max=4096){let s='';for await(const chunk of req){s+=chunk.toString('utf8');if(s.length>max)throw Error('Request body too large');}return JSON.parse(s||'{}');}
const localAccess=req=>{const h=String(req.headers.host||'').toLowerCase();return /^localhost(?::\d+)?$/.test(h)||/^127\.0\.0\.1(?::\d+)?$/.test(h)||/^\[::1\](?::\d+)?$/.test(h);};
async function proxy(req,res){const target=`http://127.0.0.1:${workerPort}${req.url}`;const method=req.method||'GET';const config={method,headers:headersFrom(req.headers),redirect:'manual',signal:AbortSignal.timeout(90000)};
 if(!['GET','HEAD'].includes(method)){config.body=Readable.toWeb(req);config.duplex='half';}
 const upstream=await fetch(target,config);res.statusCode=upstream.status;for(const [k,v] of upstream.headers)if(!['content-length','content-encoding','transfer-encoding','connection'].includes(k))res.setHeader(k,v);
 if(!upstream.body){res.end();return;}Readable.fromWeb(upstream.body).pipe(res);
}
async function main(){await mkdir(dataDir,{recursive:true,mode:0o700});await restore();const token=await persistedToken();
 const wranglerExe=path.join(root,'node_modules','wrangler','bin','wrangler.js');
 const child=spawn(process.execPath,[wranglerExe,'dev','--config','wrangler.local.jsonc','--ip','127.0.0.1','--port',String(workerPort)],{cwd:root,stdio:'inherit',env:{...process.env,WASP_RUNTIME:'pc'}});
 // Expose a separate, feed-only loopback listener for Cloudflare Tunnel.
 // Never tunnel the local admin port: the feed service has no admin, music,
 // user, or filesystem endpoints even if a Host header is forged.
 const feedService=http.createServer((req,res)=>{
  const u=new URL(req.url||'/',`http://127.0.0.1:${feedPort}`);
  if(req.method!=='GET'||u.pathname!=='/api/metadata-bank/feed')return send(res,{error:'Metadata feed only'},404);
  if(!tokenEqual(req.headers['x-wasp-metadata-token'],token))return send(res,{error:'Invalid metadata source token'},401);
  const cursor=Number(u.searchParams.get('cursor')||0),limit=Math.min(25,Math.max(1,Number(u.searchParams.get('limit'))||25));
  if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit))return send(res,{error:'Invalid cursor/limit'},400);
  const sorted=entries.filter(x=>x.seq>cursor).sort((a,b)=>a.seq-b.seq),page=sorted.slice(0,limit);
  return send(res,{ok:true,protocol:2,source:'WASP-PC-Picard',cursor:page.at(-1)?.seq||cursor,more:sorted.length>page.length,entries:page.map(({id,seq,audio_sha256,tags})=>({id,seq,audio_sha256,tags}))});
 });
 feedService.listen(feedPort,'127.0.0.1',()=>console.log(`Metadata-only tunnel target: http://127.0.0.1:${feedPort}`));
 const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url||'/',`http://127.0.0.1:${port}`);
  if(u.pathname.startsWith('/api/admin/pc-source/')){
   if(!localAccess(req))return send(res,{error:'Local PC only'},403);
   if(!await adminSession(req))return send(res,{error:'Administrator session required'},403);
   if(u.pathname==='/api/admin/pc-source/status'&&req.method==='GET')return send(res,{local_pc:true,folder:selectedFolder,scan,entries:entries.length});
   if(u.pathname==='/api/admin/pc-source/scan'&&req.method==='POST'){const b=await requestBody(req);if(typeof b.folder!=='string'||!path.isAbsolute(b.folder)||b.folder.length>2048)return send(res,{error:'Enter an absolute Windows music folder path'},400);if(scan.state==='running')return send(res,{error:'A scan is already running'},409);await scanFolder(b.folder);return send(res,{ok:true,scan});}
   return send(res,{error:'Not found'},404);
  }
  // Through a Cloudflare Tunnel, expose only the token-protected metadata feed.
  // The normal WASP admin/playback UI must never be remotely reachable.
  if(!localAccess(req))return send(res,{error:'This PC source publishes metadata only'},403);
  await proxy(req,res);
 }catch(e){if(!res.headersSent)send(res,{error:errorMessage(e)},502);else res.destroy();}});
 server.listen(port,'127.0.0.1',()=>{console.log(`\nWASP PC admin: http://localhost:${port}/admin#collection`);console.log(`Metadata source token (keep secret): ${token}`);console.log('Tunnel ONLY port '+feedPort+' (the feed-only listener); do NOT tunnel the WASP admin port '+port+'.');});
 for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{server.close();feedService.close();child.kill(event);});child.on('exit',code=>{server.close();feedService.close();if(code)process.exitCode=code;});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1;});
