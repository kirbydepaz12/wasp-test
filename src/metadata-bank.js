import {ensureTelemetrySchema} from './telemetry.js';
// WASP v18.1.5. Administrator-mediated, metadata-only pulls from explicitly
// configured sources. Never downloads audio from sources or mutates R2 objects.
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
const rows=r=>r?.results||[];
const str=(v,max=240)=>String(v??'').trim().slice(0,max);
const validHash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const validId=s=>typeof s==='string'&&/^[a-z0-9_-]{1,100}$/i.test(s);
const safeUrl=value=>{try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return null;return u.origin+u.pathname.replace(/\/$/,'');}catch{return null;}};
const same=(a,b)=>str(a).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()===str(b).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const sourceList=env=>{const list=[];if(env.WASP_METADATA_SOURCE_URL&&env.WASP_METADATA_PULL_TOKEN)list.push({url:env.WASP_METADATA_SOURCE_URL,token:env.WASP_METADATA_PULL_TOKEN,name:'PC Picard source'});
 try{for(const e of JSON.parse(env.WASP_METADATA_SOURCES_JSON||'[]'))list.push(e);}catch{}
 return list.map(x=>({url:safeUrl(x.url),name:str(x.name||'WASP metadata source',80),token:String(x.token||'')})).filter(x=>x.url&&x.token.length>=32).filter((x,i,a)=>a.findIndex(v=>v.url===x.url)===i).slice(0,10);
};
const ready=new WeakSet();
// Workers Free has a small CPU allowance per request; don't perform 25 sequential D1 writes.
// A Docker-hosted runtime has a larger per-request budget, but still stays bounded.
const workLimit=env=>env.WASP_RUNTIME==='docker'?25:2;
export async function ensureBank(env){if(ready.has(env.DB))return;for(const sql of [
`CREATE TABLE IF NOT EXISTS pc_metadata_audio_hashes(track_id TEXT PRIMARY KEY,audio_hash TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'done',updated_at INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS pc_audio_hash_lookup ON pc_metadata_audio_hashes(audio_hash)`,
`CREATE TABLE IF NOT EXISTS pc_metadata_pending(source_url TEXT NOT NULL,entry_id TEXT NOT NULL,seq INTEGER NOT NULL,audio_hash TEXT NOT NULL,tags_json TEXT NOT NULL,track_id TEXT NOT NULL DEFAULT '',match_type TEXT NOT NULL DEFAULT 'unmatched',state TEXT NOT NULL DEFAULT 'pending',updated_at INTEGER NOT NULL,PRIMARY KEY(source_url,entry_id))`,
`CREATE INDEX IF NOT EXISTS pc_metadata_pending_source ON pc_metadata_pending(source_url,state,seq)`,
`CREATE TABLE IF NOT EXISTS pc_metadata_tags(track_id TEXT PRIMARY KEY,tags_json TEXT NOT NULL,source_url TEXT NOT NULL,updated_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS pc_metadata_undo(source_url TEXT NOT NULL,entry_id TEXT NOT NULL,batch_id TEXT NOT NULL,track_id TEXT NOT NULL,old_json TEXT NOT NULL,new_json TEXT NOT NULL,applied_at INTEGER NOT NULL,undone_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_url,entry_id,batch_id))`,
`CREATE INDEX IF NOT EXISTS pc_metadata_undo_batch ON pc_metadata_undo(batch_id,undone_at)`
 ])await env.DB.prepare(sql).run();ready.add(env.DB);}
// Same bounds algorithm as the PC scanner: ID3v2 start, optional ID3v1 tail.
export function audioBounds(bytes){const b=new Uint8Array(bytes),n=b.length;let start=0,end=n;if(n>=10&&b[0]===73&&b[1]===68&&b[2]===51&&[2,3,4].includes(b[3])){const len=10+((b[6]&127)<<21)+((b[7]&127)<<14)+((b[8]&127)<<7)+(b[9]&127)+(b[5]&16?10:0);if(len<n)start=len;}if(end>=128&&b[end-128]===84&&b[end-127]===65&&b[end-126]===71)end-=128;return [start,end];}
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
async function hashOne(env){const db=env.DB;
 const t=await db.prepare(`SELECT id FROM tracks t WHERE NOT EXISTS(SELECT 1 FROM pc_metadata_audio_hashes h WHERE h.track_id=t.id) ORDER BY t.created_at LIMIT 1`).first();
 if(!t)return {remaining:0,complete:true};
 let state='done',hash='',reason='';try{
 if(env.WASP_RUNTIME==='docker'&&t.id.startsWith('folder-')){
  if(!env.SCANNER_SECRET)throw Error('Docker scanner unavailable');
  const u=new URL('http://127.0.0.1:8788/_internal/metadata-audio-hash');u.searchParams.set('id',t.id);
  const r=await fetch(u,{headers:{'x-scanner-secret':env.SCANNER_SECRET},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('Docker folder fingerprint unavailable');const value=await r.json();if(!validHash(value.hash))throw Error('Invalid Docker folder hash');hash=value.hash;
 }else{
 const obj=await env.MUSIC.head(t.id);if(!obj){state='skipped';reason='Audio object not found';}else if(obj.size>32*1024*1024){state='skipped';reason='Audio exceeds safe 32 MiB Worker limit';}else if(obj.size<128){state='skipped';reason='Too small';}else {const data=await env.MUSIC.get(t.id);if(!data){state='skipped';reason='Audio not found';}else{const buf=await data.arrayBuffer();const [start,end]=audioBounds(buf);if(end<=start){state='skipped';reason='No MP3 payload';}else hash=hex(await crypto.subtle.digest('SHA-256',new Uint8Array(buf,start,end-start)));}}}
 }catch(e){state='skipped';reason='Fingerprint unavailable';}
 await db.prepare('INSERT OR REPLACE INTO pc_metadata_audio_hashes(track_id,audio_hash,state,updated_at) VALUES(?,?,?,?)').bind(t.id,hash,state,Date.now()).run();
 const left=await db.prepare('SELECT COUNT(*) n FROM tracks t WHERE NOT EXISTS(SELECT 1 FROM pc_metadata_audio_hashes h WHERE h.track_id=t.id)').first();return {processed:1,track_id:t.id,matched:!!hash,reason,remaining:Number(left.n),complete:!Number(left.n)};
}
function sanitized(raw){const t=raw?.tags||{};if(!raw||!validId(raw.id)||!Number.isSafeInteger(raw.seq)||raw.seq<=0||!validHash(raw.audio_sha256)||!t||typeof t!=='object'||Array.isArray(t))return null;
 const vec=(v,max=25)=>Array.isArray(v)?v.slice(0,max).map(x=>str(x,180)).filter(Boolean):[];
 const tags={title:str(t.title),artist:str(t.artist),artists:vec(t.artists,10),album:str(t.album),album_artist:str(t.album_artist),genre:vec(t.genre),date:str(t.date,40),original_date:str(t.original_date,40),year:Number(t.year)||null,track_no:Number(t.track_no)||null,track_total:Number(t.track_total)||null,disc_no:Number(t.disc_no)||null,disc_total:Number(t.disc_total)||null,duration:Number(t.duration)||0,musicbrainz_recording_id:str(t.musicbrainz_recording_id,60),musicbrainz_track_id:str(t.musicbrainz_track_id,60),musicbrainz_release_id:str(t.musicbrainz_release_id,60),musicbrainz_release_group_id:str(t.musicbrainz_release_group_id,60),musicbrainz_artist_ids:vec(t.musicbrainz_artist_ids),isrc:vec(t.isrc),label:vec(t.label),bpm:Number(t.bpm)||null,composer:vec(t.composer),native:{}};
 // Keep up to 32 custom Picard frame fields (maximum 3 values of 200 chars),
 // never store artwork/lyrics/secrets, or executable/raw binary tag payloads.
 if(t.native&&typeof t.native==='object'&&!Array.isArray(t.native))for(const [k,v] of Object.entries(t.native).slice(0,32)){if(!/^[a-z0-9 _:-]{1,70}$/i.test(k)||/apic|cover|image|lyric|priv|secret|password|url|comment/i.test(k))continue;tags.native[k]=vec(v,3).map(x=>x.slice(0,200));}
 return {id:raw.id,seq:raw.seq,audio_hash:raw.audio_sha256,tags};}
async function chooseMatch(db,e){const r=rows(await db.prepare(`SELECT t.id,t.title,t.artist,t.album,t.duration FROM pc_metadata_audio_hashes h JOIN tracks t ON t.id=h.track_id WHERE h.audio_hash=? LIMIT 3`).bind(e.audio_hash).all());if(r.length===1)return {id:r[0].id,type:'audio'};if(r.length>1)return {id:'',type:'ambiguous'};
 // Similar metadata is review-only; never automatically approve a rename.
 const candidate=rows(await db.prepare('SELECT id,title,artist,album,duration FROM tracks WHERE LOWER(title)=LOWER(?) AND LOWER(artist)=LOWER(?) LIMIT 5').bind(e.tags.title,e.tags.artist).all()).filter(t=>!e.tags.duration||!t.duration||Math.abs(t.duration-e.tags.duration)<3);
 return candidate.length===1?{id:candidate[0].id,type:'review'}:{id:'',type:candidate.length?'ambiguous':'unmatched'};
}
async function pullProgress(env,source){
 if(!sourceList(env).some(x=>x.url===source))return json({error:'Source is not explicitly authorized.'},403);
 // Existing v18.1.5a staged entries are the checkpoint: do NOT delete or reimport
 // thousands of records when a browser is reopened after a Worker timeout.
 const row=await env.DB.prepare('SELECT COALESCE(MAX(seq),0) cursor FROM pc_metadata_pending WHERE source_url=?').bind(source).first();
 return json({ok:true,source,cursor:Number(row?.cursor)||0});
}
async function pullPage(env,b,{fetcher=fetch}={}){const source=sourceList(env).find(x=>x.url===b.source);if(!source)return json({error:'Source is not explicitly authorized in server configuration.'},403);
 const cursor=Number(b.cursor||0);if(!Number.isSafeInteger(cursor)||cursor<0)return json({error:'Invalid cursor'},400);
 const requested=Number(b.batch_size);const limit=Number.isSafeInteger(requested)&&requested>=1?Math.min(workLimit(env),requested):workLimit(env);
 const u=new URL(source.url+'/api/metadata-bank/feed');u.searchParams.set('cursor',String(cursor));u.searchParams.set('limit',String(limit));
 const headers={'accept':'application/json','x-wasp-metadata-token':source.token};if(env.WASP_METADATA_ACCESS_CLIENT_ID&&env.WASP_METADATA_ACCESS_CLIENT_SECRET){headers['CF-Access-Client-Id']=env.WASP_METADATA_ACCESS_CLIENT_ID;headers['CF-Access-Client-Secret']=env.WASP_METADATA_ACCESS_CLIENT_SECRET;}
 let response;try{response=await fetcher(u.toString(),{method:'GET',redirect:'manual',headers,signal:AbortSignal.timeout(12000)});}catch(e){return json({error:'Metadata source unreachable: '+str(e.message,120)},502);}
 if(response.status!==200)return json({error:`Metadata source returned HTTP ${response.status}. Check connectivity and read-only token.`},502);
 if(Number(response.headers.get('content-length')||0)>220000)return json({error:'Source response too large'},502);
 let data;try{const payload=await response.text();if(payload.length>220000)return json({error:'Source response too large'},502);data=JSON.parse(payload);}catch{return json({error:'Invalid source response'},502);}
 if(!data?.ok||data.protocol!==2||!Array.isArray(data.entries)||data.entries.length>limit||!Number.isSafeInteger(data.cursor)||data.cursor<cursor||typeof data.more!=='boolean'||(data.more&&data.entries.length===0))return json({error:'Unsupported source metadata protocol'},502);
 const seen=new Set();let previous=cursor,staged=0,unchanged=0;
 for(const raw of data.entries){const e=sanitized(raw);if(!e||e.seq<=previous||e.seq>data.cursor||seen.has(e.id))return json({error:'Invalid entry in metadata feed'},502);seen.add(e.id);previous=e.seq;
 const previousEntry=await env.DB.prepare('SELECT seq,state FROM pc_metadata_pending WHERE source_url=? AND entry_id=?').bind(source.url,e.id).first();if(previousEntry&&previousEntry.seq===e.seq){unchanged++;continue;}
 const match=await chooseMatch(env.DB,e);
 // Existing confirmed entries cannot be silently modified by a metadata refresh.
 await env.DB.prepare(`INSERT INTO pc_metadata_pending(source_url,entry_id,seq,audio_hash,tags_json,track_id,match_type,state,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?) ON CONFLICT(source_url,entry_id) DO UPDATE SET seq=excluded.seq,audio_hash=excluded.audio_hash,tags_json=excluded.tags_json,track_id=excluded.track_id,match_type=excluded.match_type,state='pending',updated_at=excluded.updated_at`).bind(source.url,e.id,e.seq,e.audio_hash,JSON.stringify(e.tags),match.id,match.type,Date.now()).run();staged++;
 }
 return json({ok:true,source:source.url,staged,unchanged,cursor:data.cursor,more:data.more,count:data.entries.length,limit});
}
// Reconcile previously staged entries against local fingerprints without
// contacting the PC source or touching playlists/audio. Never replace an
// administrator's explicitly chosen manual match, or any applied record.
async function rematchPage(env,b){
 const source=sourceList(env).find(x=>x.url===b.source);if(!source)return json({error:'Source is not explicitly authorized.'},403);
 const after=Number(b.after||0);if(!Number.isSafeInteger(after)||after<0)return json({error:'Invalid rematch cursor'},400);
 const limit=workLimit(env);
 const candidates=rows(await env.DB.prepare(`SELECT entry_id,seq,audio_hash,tags_json,track_id,match_type FROM pc_metadata_pending WHERE source_url=? AND state='pending' AND seq>? AND match_type NOT IN('audio','manual') ORDER BY seq LIMIT ?`).bind(source.url,after,limit).all());
 let matched=0,review=0,unchanged=0,cursor=after;
 for(const row of candidates){cursor=row.seq;
  let tags;try{tags=JSON.parse(row.tags_json);}catch{unchanged++;continue;}
  const choice=await chooseMatch(env.DB,{audio_hash:row.audio_hash,tags});
  if(choice.type===row.match_type&&choice.id===row.track_id){unchanged++;continue;}
  // Guard against a concurrent approval/assignment between selection and update.
  const write=await env.DB.prepare(`UPDATE pc_metadata_pending SET track_id=?,match_type=?,updated_at=? WHERE source_url=? AND entry_id=? AND seq=? AND state='pending' AND match_type=?`).bind(choice.id,choice.type,Date.now(),source.url,row.entry_id,row.seq,row.match_type).run();
  if(Number(write?.meta?.changes||0)){if(choice.type==='audio')matched++;else if(choice.type==='review')review++;}
 }
 // No expensive COUNT query per page; the browser can get totals from Review.
 return json({ok:true,source:source.url,processed:candidates.length,matched,review,unchanged,cursor,more:candidates.length===limit,limit});
}
async function pendingPage(env,url){const source=url.searchParams.get('source')||'';if(!sourceList(env).some(s=>s.url===source))return json({error:'Invalid source'},400);const after=Number(url.searchParams.get('offset')||0);if(!Number.isInteger(after)||after<0)return json({error:'Invalid offset'},400);
 const result=rows(await env.DB.prepare(`SELECT p.source_url,p.entry_id,p.seq,p.tags_json,p.track_id,p.match_type,p.state,t.title old_title,t.artist old_artist,t.album old_album FROM pc_metadata_pending p LEFT JOIN tracks t ON t.id=p.track_id WHERE p.source_url=? AND p.state='pending' ORDER BY p.seq LIMIT 40 OFFSET ?`).bind(source,after).all());const count=await env.DB.prepare(`SELECT COUNT(*) n,SUM(CASE WHEN match_type='audio' THEN 1 ELSE 0 END) audio_matches,SUM(CASE WHEN match_type='review' THEN 1 ELSE 0 END) review,SUM(CASE WHEN match_type IN('ambiguous','unmatched') THEN 1 ELSE 0 END) unresolved FROM pc_metadata_pending WHERE source_url=? AND state='pending'`).bind(source).first();
 return json({items:result.map(x=>({...x,tags:JSON.parse(x.tags_json),tags_json:undefined})),count:Number(count.n||0),audio_matches:Number(count.audio_matches||0),review:Number(count.review||0),unresolved:Number(count.unresolved||0)});
}
async function apply(env,b,{makeArtistIndex}={}){const source=b.source,ids=b.ids;if(!sourceList(env).some(s=>s.url===source)||!Array.isArray(ids)||ids.length<1||ids.length>20||new Set(ids).size!==ids.length||ids.some(x=>!validId(x))||b.confirm!=='apply metadata')return json({error:'Select up to 20 reviewed records and confirm apply metadata.'},400);
 await ensureTelemetrySchema(env);const db=env.DB,batch=crypto.randomUUID(),now=Date.now();let applied=0;
 for(const id of ids){const p=await db.prepare('SELECT * FROM pc_metadata_pending WHERE source_url=? AND entry_id=?').bind(source,id).first();if(!p||p.state!=='pending'||!p.track_id||!['audio','manual'].includes(p.match_type))continue;
 const t=await db.prepare('SELECT id,title,artist,artists,album,track_no,duration FROM tracks WHERE id=?').bind(p.track_id).first();if(!t)continue;
 const nt=JSON.parse(p.tags_json),artists=nt.artists.length?nt.artists:nt.artist?[nt.artist]:[];
 const newRow={title:nt.title||t.title,artist:artists.length?artists.join(', '):t.artist,artists:artists.length?JSON.stringify(artists):t.artists||'[]',album:nt.album||t.album,track_no:nt.track_no||t.track_no||0};
 const prevMeta=await db.prepare('SELECT tags_json FROM pc_metadata_tags WHERE track_id=?').bind(t.id).first();
 const prevTelemetry=await db.prepare('SELECT release_year,genre FROM telemetry_track_metadata WHERE track_id=?').bind(t.id).first();
 const undo={track:{title:t.title,artist:t.artist,artists:t.artists,album:t.album,track_no:t.track_no},extra:prevMeta?.tags_json||null,telemetry:prevTelemetry||null};
 const statements=[db.prepare('UPDATE tracks SET title=?,artist=?,artists=?,album=?,track_no=? WHERE id=?').bind(newRow.title,newRow.artist,newRow.artists,newRow.album,newRow.track_no,t.id),...makeArtistIndex(db,{id:t.id,artist:newRow.artist,artists:newRow.artists,album:newRow.album}),db.prepare('INSERT INTO pc_metadata_tags(track_id,tags_json,source_url,updated_at) VALUES(?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET tags_json=excluded.tags_json,source_url=excluded.source_url,updated_at=excluded.updated_at').bind(t.id,p.tags_json,source,now),db.prepare('INSERT INTO pc_metadata_undo(source_url,entry_id,batch_id,track_id,old_json,new_json,applied_at) VALUES(?,?,?,?,?,?,?)').bind(source,id,batch,t.id,JSON.stringify(undo),JSON.stringify(newRow),now),db.prepare("UPDATE pc_metadata_pending SET state='applied' WHERE source_url=? AND entry_id=?").bind(source,id)];
 // Surface Picard genre/year in /api/tracks and future telemetry, while
 // preserving the existing event ledger and all plays.
 const year=Number(String(nt.original_date||nt.date||nt.year||'').slice(0,4));
 const validYear=Number.isInteger(year)&&year>=1850&&year<=new Date().getUTCFullYear()+1?year:0;
 const genre=str(nt.genre?.[0]||'',80).toLowerCase();
 if(validYear||genre)statements.push(db.prepare(`INSERT INTO telemetry_track_metadata(track_id,release_year,genre) VALUES(?,?,?) ON CONFLICT(track_id) DO UPDATE SET release_year=CASE WHEN excluded.release_year>0 THEN excluded.release_year ELSE telemetry_track_metadata.release_year END,genre=CASE WHEN excluded.genre<>'' THEN excluded.genre ELSE telemetry_track_metadata.genre END`).bind(t.id,validYear,genre));
 await db.batch(statements);applied++;
 }
 return json({ok:true,applied,batch_id:applied?batch:null});
}
async function rollback(env,b,{makeArtistIndex}={}){if(!/^[a-f0-9-]{36}$/i.test(b.batch_id||'')||b.confirm!=='undo metadata')return json({error:'Confirm undo metadata with a valid batch ID.'},400);await ensureTelemetrySchema(env);const db=env.DB;
 const jobs=rows(await db.prepare('SELECT * FROM pc_metadata_undo WHERE batch_id=? AND undone_at=0 LIMIT 30').bind(b.batch_id).all());let undone=0,conflicts=0;
 for(const j of jobs){const t=await db.prepare('SELECT id,title,artist,artists,album,track_no FROM tracks WHERE id=?').bind(j.track_id).first();const expected=JSON.parse(j.new_json),old=JSON.parse(j.old_json);if(!t||Object.keys(expected).some(k=>String(t[k]??'')!==String(expected[k]??''))){conflicts++;continue;}
 const x=old.track;const stmts=[db.prepare('UPDATE tracks SET title=?,artist=?,artists=?,album=?,track_no=? WHERE id=?').bind(x.title,x.artist,x.artists,x.album,x.track_no,t.id),...makeArtistIndex(db,{id:t.id,artist:x.artist,artists:x.artists,album:x.album})];
 if(old.extra===null)stmts.push(db.prepare('DELETE FROM pc_metadata_tags WHERE track_id=?').bind(t.id));else stmts.push(db.prepare('UPDATE pc_metadata_tags SET tags_json=?,updated_at=? WHERE track_id=?').bind(old.extra,Date.now(),t.id));
 if(old.telemetry===null)stmts.push(db.prepare('DELETE FROM telemetry_track_metadata WHERE track_id=?').bind(t.id));
 else stmts.push(db.prepare('INSERT INTO telemetry_track_metadata(track_id,release_year,genre) VALUES(?,?,?) ON CONFLICT(track_id) DO UPDATE SET release_year=excluded.release_year,genre=excluded.genre').bind(t.id,old.telemetry.release_year||0,old.telemetry.genre||''));
 stmts.push(db.prepare('UPDATE pc_metadata_undo SET undone_at=? WHERE source_url=? AND entry_id=? AND batch_id=?').bind(Date.now(),j.source_url,j.entry_id,j.batch_id),db.prepare("UPDATE pc_metadata_pending SET state='pending' WHERE source_url=? AND entry_id=?").bind(j.source_url,j.entry_id));await db.batch(stmts);undone++;
 }
 return json({ok:true,undone,conflicts});
}
export async function metadataBankApi(req,env,url,{makeArtistIndex,fetcher=fetch}={}){await ensureBank(env);const action=url.pathname.slice('/api/admin/metadata-bank/'.length);const db=env.DB;
 if(action==='sources'&&req.method==='GET')return json({sources:sourceList(env).map(({url,name})=>({url,name})),runtime:env.WASP_RUNTIME||'cloudflare',feature:'manual-review'});
 if(action==='fingerprints'&&req.method==='POST')return json(await hashOne(env));
 if(action==='fingerprints/status'&&req.method==='GET'){const total=await db.prepare('SELECT COUNT(*) n FROM tracks').first(),count=await db.prepare('SELECT COUNT(*) n FROM pc_metadata_audio_hashes').first();return json({total:total.n,done:count.n,remaining:total.n-count.n});}
 if(action==='pull/progress'&&req.method==='GET')return pullProgress(env,url.searchParams.get('source')||'');
 if(action==='pull'&&req.method==='POST')return pullPage(env,await req.json().catch(()=>({})),{fetcher});
 if(action==='rematch'&&req.method==='POST')return rematchPage(env,await req.json().catch(()=>({})));
 if(action==='pending'&&req.method==='GET')return pendingPage(env,url);
 if(action==='history'&&req.method==='GET'){
  const source=url.searchParams.get('source')||'';
  if(!sourceList(env).some(x=>x.url===source))return json({error:'Invalid source'},400);
  const batches=rows(await db.prepare(`SELECT batch_id,MAX(applied_at) AS applied_at,COUNT(*) AS total,SUM(CASE WHEN undone_at>0 THEN 1 ELSE 0 END) undone FROM pc_metadata_undo WHERE source_url=? GROUP BY batch_id ORDER BY applied_at DESC LIMIT 20`).bind(source).all());
  return json({batches});
 }

 if(action==='assign'&&req.method==='POST'){const b=await req.json().catch(()=>({}));if(!sourceList(env).some(x=>x.url===b.source)||!validId(b.entry_id)||!validId(b.track_id)||b.confirm!=='match manually')return json({error:'Select a valid track and confirm manual match.'},400);if(!(await db.prepare('SELECT 1 FROM tracks WHERE id=?').bind(b.track_id).first()))return json({error:'Track not found'},404);await db.prepare("UPDATE pc_metadata_pending SET track_id=?,match_type='manual' WHERE source_url=? AND entry_id=? AND state='pending'").bind(b.track_id,b.source,b.entry_id).run();return json({ok:true});}
 if(action==='apply'&&req.method==='POST')return apply(env,await req.json().catch(()=>({})),{makeArtistIndex});
 if(action==='undo'&&req.method==='POST')return rollback(env,await req.json().catch(()=>({})),{makeArtistIndex});
 return json({error:'Not found'},404);
}
