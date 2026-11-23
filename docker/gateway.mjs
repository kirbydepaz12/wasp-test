import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseFile} from 'music-metadata';
import {parseFileTags} from '../src/file-metadata.js';
import {proxyToWorker} from './proxy.mjs';
import {createPeerRelay} from './peer-relay.mjs';
import {folderFallbackCover} from './folder-art.mjs';
import {unchanged,loadFileIndex,saveFileIndex} from './file-index-cache.mjs';
import {createOfflineMetadata} from './offline-metadata.mjs';

const roots=(process.env.MUSIC_SCAN_PATHS||'/music').split(',').map(x=>x.trim()).filter(Boolean);
const port=Number(process.env.GATEWAY_PORT||8788), worker='http://127.0.0.1:8787';
const secret=process.env.SCANNER_SECRET;
const offline=createOfflineMetadata({secret,autoUpdate:process.env.WASP_OFFLINE_AUTO_UPDATE==='1'});
setInterval(()=>offline.updateTick(),3600000);
const scanInterval=Math.max(60,Number(process.env.MUSIC_SCAN_INTERVAL||300))*1000;
const catalogue=new Map(), covers=new Map();
const cacheFile=process.env.WASP_FOLDER_INDEX_CACHE||'/app/.wrangler/state/folder-index-v183.json';
let persisted=await loadFileIndex(cacheFile);
const peerRelay=createPeerRelay({worker});
const supported=/\.(mp3|flac|m4a|mp4|ogg|opus|wav|aac)$/i;
async function picardFromFile(full,size){if(!/\.mp3$/i.test(full))return {};let fd;try{fd=await fs.promises.open(full,'r');const len=Math.min(size,6*1024*1024);const buf=Buffer.allocUnsafe(len);const {bytesRead}=await fd.read(buf,0,len,0);return parseFileTags(buf.subarray(0,bytesRead));}catch{return {};}finally{await fd?.close().catch(()=>{});}}
function fileId(p){return 'folder-'+crypto.createHash('sha1').update(p).digest('hex');}
async function walk(root,found,force=false){
 let entries;try{entries=await fs.promises.readdir(root,{withFileTypes:true});}catch{return;}
 for(const e of entries){
  const full=path.join(root,e.name);
  if(e.isSymbolicLink())continue;
  if(e.isDirectory()){await walk(full,found,force);continue;}
  if(!e.isFile()||!supported.test(e.name))continue;
  try{
   const stat=await fs.promises.stat(full),id=fileId(full);
   const previous=catalogue.get(id)||persisted.tracks.get(id);
   if(!force&&unchanged(previous,stat)&&previous?.tagVersion===2){found.set(id,previous);continue;}
   const meta=await parseFile(full,{duration:true,skipCovers:false});
   const tags=await picardFromFile(full,stat.size);
   const pic=meta.common.picture?.find(p=>p.type==='Cover (front)')||meta.common.picture?.[0];
   // Replaced files can lose their APIC frame; don't retain an old cover.
   covers.delete(id);
   if(pic&&pic.data?.length<5e6&&/^image\/(jpeg|png|webp)$/.test(pic.format||''))
     covers.set(id,{data:Buffer.from(pic.data),type:pic.format});
   found.set(id,{id,path:full,mtime:stat.mtimeMs,size:stat.size,title:meta.common.title||path.parse(full).name,
    artist:meta.common.artist||meta.common.albumartist||'Unknown Artist',album:meta.common.album||'Unknown Album',
    duration:meta.format.duration||0,track_no:meta.common.track?.no||0,release_year:tags.release_year||meta.common.year||0,genre:tags.genre||meta.common.genre?.[0]||'',original_date:tags.original_date||'',release_date:tags.release_date||'',artist_names:tags.artist_names||[],musicbrainz_artist_ids:tags.musicbrainz_artist_ids||[],artist_origins:tags.artist_origins||[],tagVersion:2,hasCover:covers.has(id)});
  }catch(e){console.warn('Skipping unreadable file',full,e.message);}
 }
}
let scanning=false;
async function scan(){
 if(scanning)return;scanning=true;
 try{
  let token=persisted.token;
  try{const r=await fetch(worker+'/api/internal/folder-rescan-token',{headers:{'x-scanner-secret':secret},signal:AbortSignal.timeout(5000)});if(r.ok)token=String((await r.json()).token||'');}catch{}
  const force=token!==persisted.token;
  const found=new Map();for(const root of roots)await walk(root,found,force);
  // Never commit the cache until all changed tracks were acknowledged; a failed
  // database write must be retried on the next directory poll.
  const changed=[...found.values()].filter(t=>force||t.tagVersion!==1&&!unchanged(catalogue.get(t.id)||persisted.tracks.get(t.id),{mtimeMs:t.mtime,size:t.size})||(catalogue.get(t.id)||persisted.tracks.get(t.id))?.tagVersion!==2);
  for(let i=0;i<changed.length;i+=250){
   const response=await fetch(worker+'/api/internal/folder-index',{method:'POST',headers:{'content-type':'application/json','x-scanner-secret':secret},body:JSON.stringify({tracks:changed.slice(i,i+250)})});
   if(!response.ok)throw Error('Index update failed: '+response.status+' '+await response.text());
  }
  for(const id of catalogue.keys())if(!found.has(id))covers.delete(id);
  if(changed.length||force||found.size!==persisted.tracks.size){await saveFileIndex(cacheFile,found,token);persisted={token,tracks:new Map(found)};}
  catalogue.clear();for(const [id,t] of found)catalogue.set(id,t);
  console.log('Scanned',catalogue.size,'server-folder songs; changed',changed.length);
 }catch(e){console.error('Scanner error',e);}finally{scanning=false;}
}
const fingerprintsEndpoint=worker+'/api/internal/fingerprint-index';
const scannerHeaders={'content-type':'application/json','x-scanner-secret':secret};
let hashInProgress=false,lastRequestedHash='';
async function fingerprintBatch(items,status){
  const r=await fetch(fingerprintsEndpoint,{method:'POST',headers:scannerHeaders,body:JSON.stringify({items,status}),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error('Fingerprint write failed: '+r.status+' '+await r.text());
}
async function hashScan(){
  if(hashInProgress)return;
  hashInProgress=true;
  let scanned=0,changed=0,total=0;
  try {
    // Don't take a partial catalogue snapshot while folder indexing is still
    // parsing files at startup. Hashes must refer to a complete folder scan.
    for(let retries=0;scanning&&retries<120;retries++)
      await new Promise(resolve=>setTimeout(resolve,500));
    if(scanning)throw Error('Folder indexing is still running. Please retry the SHA-256 scan.');
    // Always refresh the folder inventory before a manual or scheduled hash
    // scan so files removed since the last 5-minute poll cannot count.
    await scan();
    const saved=new Map();let after='';
    while(true){
      const r=await fetch(worker+'/api/internal/fingerprints?after='+encodeURIComponent(after),{headers:{'x-scanner-secret':secret},signal:AbortSignal.timeout(25000)});
      if(!r.ok)throw Error('Unable to read stored fingerprints: '+r.status);
      const page=await r.json();for(const f of page)saved.set(f.track_id,f);
      if(page.length<500)break;after=page.at(-1).track_id;
    }
    const entries=[...catalogue.values()];total=entries.length;
    // Stale paths (including files removed before this gateway was restarted)
    // must not be used as evidence for deleting a managed upload.
    const missing=[...saved.keys()].filter(id=>!catalogue.has(id));
    for(let i=0;i<missing.length;i+=80){
      const r=await fetch(worker+'/api/internal/fingerprint-prune',{method:'POST',headers:scannerHeaders,body:JSON.stringify({ids:missing.slice(i,i+80)}),signal:AbortSignal.timeout(30000)});
      if(!r.ok)throw Error('Unable to clear stale file fingerprints: '+r.status);
    }
    await fingerprintBatch([],{state:'running',total,scanned,changed});
    let pending=[];
    for(const t of entries){
      const prior=saved.get(t.id);
      if(!prior || prior.size!==t.size || Number(prior.mtime_ms)!==Math.floor(t.mtime)){
        // Stream the original file; never write, rename or delete it.
        const digest=await new Promise((resolve,reject)=>{
          const hash=crypto.createHash('sha256');
          const stream=fs.createReadStream(t.path,{highWaterMark:1024*1024});
          stream.on('data',chunk=>hash.update(chunk));
          stream.on('end',()=>resolve(hash.digest('hex')));
          stream.on('error',reject);
        });
        pending.push({id:t.id,path:t.path,sha256:digest,size:t.size,mtime:Math.floor(t.mtime)});changed++;
      }
      scanned++;
      if(pending.length>=40 || scanned===total){await fingerprintBatch(pending,{state:'running',total,scanned,changed});pending=[];}
      if(scanned%15===0)await new Promise(resolve=>setTimeout(resolve,20));
    }
    await fingerprintBatch([],{state:'complete',total,scanned,changed});
    console.log('SHA-256 folder scan finished:',scanned,'files,',changed,'new/changed');
  }catch(error){
    console.error('SHA-256 folder scan:',error.message);
    try{await fingerprintBatch([],{state:'error',total,scanned,changed,error:error.message});}catch{}
  }finally{hashInProgress=false;}
}
async function pollHashRequest(){
  try {
    const r=await fetch(worker+'/api/internal/hash-request',{headers:{'x-scanner-secret':secret},signal:AbortSignal.timeout(7000)});
    if(!r.ok)return;
    const request=(await r.json()).request;
    if(request && request!==lastRequestedHash && !hashInProgress){lastRequestedHash=request;void hashScan();}
  }catch{}
}
// The Worker cannot read /music (a read-only host mount). If its online
// artwork search has no match, serve an embedded cover from a matching local
// folder track. Never change the MP3 or write a new audio file.
async function ensureFolderCover(t){if(!t||!t.hasCover||covers.has(t.id))return covers.get(t?.id);try{const stat=await fs.promises.stat(t.path);if(!unchanged(t,stat))return null;const meta=await parseFile(t.path,{duration:false,skipCovers:false});const pic=meta.common.picture?.find(p=>p.type==='Cover (front)')||meta.common.picture?.[0];if(pic&&pic.data?.length<5e6&&/^image\/(jpeg|png|webp)$/.test(pic.format||''))covers.set(t.id,{data:Buffer.from(pic.data),type:pic.format});}catch{}return covers.get(t.id);}
async function serveFolderArtFallback(req,res,u){
 const kind=u.pathname.slice(5);
 // Try the online cover first. An external source can be unavailable even
 // while an embedded cover in /music is perfectly readable.
 try{
  const r=await fetch(worker+u.pathname+u.search,{signal:AbortSignal.timeout(15000)});
  if(r.ok&&/^image\/(jpeg|png|webp)/.test(r.headers.get('content-type')||'')){
   const bytes=Buffer.from(await r.arrayBuffer());
   res.writeHead(200,{'content-type':r.headers.get('content-type'),
     'cache-control':'public, max-age=3600','content-length':bytes.length});
   res.end(req.method==='HEAD'?undefined:bytes);return;
  }
 }catch(error){console.warn('Artwork search unavailable:',error.message);}
 let cover=folderFallbackCover(kind,u.searchParams,catalogue,covers);if(!cover){const artist=String(u.searchParams.get(kind==='artist'?'name':'artist')||'').trim().toLowerCase(),album=String(u.searchParams.get('album')||'').trim().toLowerCase();for(const t of catalogue.values()){if(!t.hasCover||!String(t.artist||'').toLowerCase().split(/\s*(?:[,;&]|\bfeat\.?\s|\bft\.?\s)\s*/).includes(artist)||(kind==='album'&&String(t.album||'').trim().toLowerCase()!==album))continue;cover=await ensureFolderCover(t);if(cover)break;}}
 if(cover){res.writeHead(200,{'content-type':cover.type,
    'cache-control':'public, max-age=3600','content-length':cover.data.length});
    res.end(req.method==='HEAD'?undefined:cover.data);return;}
 res.writeHead(404,{'cache-control':'no-store'});res.end();
}
function streamFile(req,res,t){
 let start=0,end=t.size-1;const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range||'');
 if(match){start=match[1]?Number(match[1]):0;end=match[2]?Number(match[2]):end;
  if(!match[1]&&match[2]){start=Math.max(0,t.size-Number(match[2]));end=t.size-1;}}
 if(start>end||end>=t.size){res.writeHead(416,{'content-range':`bytes */${t.size}`});res.end();return;}
 const ext=path.extname(t.path).toLowerCase();const types={'.mp3':'audio/mpeg','.flac':'audio/flac','.m4a':'audio/mp4','.mp4':'audio/mp4','.ogg':'audio/ogg','.opus':'audio/ogg','.wav':'audio/wav','.aac':'audio/aac'};
 res.writeHead(match?206:200,{'content-type':types[ext]||'application/octet-stream','accept-ranges':'bytes','content-length':end-start+1,...(match?{'content-range':`bytes ${start}-${end}/${t.size}`}:{})});
 if(req.method==='HEAD'){res.end();return;}fs.createReadStream(t.path,{start,end}).on('error',()=>res.destroy()).pipe(res);
}
// Exact MPEG payload fingerprint for matching a Picard-retagged Windows copy.
// Reads a configured, read-only /music file. Never makes its bytes downloadable.
async function payloadHash(file,size){
 const fd=await fs.promises.open(file,'r');let start=0,end=size;
 try{const head=Buffer.alloc(10),tail=Buffer.alloc(Math.min(128,size));await fd.read(head,0,10,0);await fd.read(tail,0,tail.length,size-tail.length);
  if(head.toString('ascii',0,3)==='ID3'&&[2,3,4].includes(head[3])){const length=10+((head[6]&127)<<21)+((head[7]&127)<<14)+((head[8]&127)<<7)+(head[9]&127)+(head[5]&0x10?10:0);if(length<size)start=length;}
  if(tail.length===128&&tail.toString('ascii',0,3)==='TAG')end-=128;
 }finally{await fd.close();}
 if(end<=start)throw Error('No MP3 audio payload');const h=crypto.createHash('sha256');
 for await(const chunk of fs.createReadStream(file,{start,end:end-1,highWaterMark:512*1024}))h.update(chunk);
 return h.digest('hex');
}
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(await offline.handle(req,res,u))return;
 if(u.pathname==='/_internal/metadata-audio-hash'&&req.method==='GET'){
   if(!secret||req.headers['x-scanner-secret']!==secret){res.writeHead(403);res.end();return;}
   const id=u.searchParams.get('id')||'',entry=catalogue.get(id);
   if(!entry||!/\.mp3$/i.test(entry.path)||entry.size>64*1024*1024){res.writeHead(404);res.end();return;}
   try{const hash=await payloadHash(entry.path,entry.size);res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({hash}));}
   catch{res.writeHead(500);res.end();}return;
 }
 if(u.pathname==='/_internal/hash-scan'&&req.method==='POST'){
   if(!secret||req.headers['x-scanner-secret']!==secret){res.writeHead(403);res.end();return;}
   void hashScan();res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));return;
 }
 if(u.pathname==='/api/local/scan'&&req.method==='POST'){res.writeHead(404);res.end();return;}
 if(u.pathname.startsWith('/audio/folder-')){
  const t=catalogue.get(u.pathname.slice(7));if(!t){res.writeHead(404);res.end();return;}streamFile(req,res,t);return;
 }
 if(u.pathname==='/art/track'&&u.searchParams.get('id')?.startsWith('folder-')){
  const cover=await ensureFolderCover(catalogue.get(u.searchParams.get('id')));
  if(cover){res.writeHead(200,{'content-type':cover.type,'cache-control':'public, max-age=3600'});
    res.end(req.method==='HEAD'?undefined:cover.data);return;}
  // If the file has no embedded cover, let the Worker try its online search.
 }
 if((u.pathname==='/art/album'||u.pathname==='/art/artist')&&['GET','HEAD'].includes(req.method)){
  await serveFolderArtFallback(req,res,u);return;
 }
 try { if (await peerRelay.handle(req,res)) return; }
 catch (error) { console.error('Peer relay error',error.message); if(!res.headersSent)res.writeHead(502);res.end();return; }
 // Wrangler HTML, audio and assets must be streamed without decompression.
 proxyToWorker(req,res);
});
server.listen(port,'127.0.0.1',()=>console.log('RiffVault gateway listening on',port));
setTimeout(scan,7000);setInterval(scan,scanInterval);

setInterval(pollHashRequest,12000);setTimeout(pollHashRequest,16000);
