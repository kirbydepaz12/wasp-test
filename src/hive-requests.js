import { ensureTelemetrySchema } from './telemetry.js';
import { requireNoRedirect } from './peer-fetch.js';
// WASP v17.0.2: Federated community request queue.
// Peer sync is pull-only. No user IDs, visitor tokens, IPs, account credentials,
// or private playlist contents are exchanged. Origin + event ID is stable across
// relay hops; duplicate and cyclic connections never produce duplicate requests.
const rows = result => result?.results || [];
const out = (body,status=200) => new Response(JSON.stringify(body), {status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const txt = (s,max=180) => String(s??'').trim().slice(0,max);
const idValid = s => /^[a-zA-Z0-9_-]{8,100}$/.test(String(s||''));
const originValid = s => /^[a-f0-9-]{10,90}$/i.test(String(s||''));
const kindValid = s => ['song','artist','album','playlist'].includes(s);
const statusValid = s => ['active','done','cancelled'].includes(s);
const MAX_BATCH = 120;
const MAX_PEERS = 10;
const MAX_META = 65536;
const TIMEOUT = 9000;
const ready = new WeakSet();
const changes = r => Number(r?.meta?.changes??r?.changes??0);
function validateEvent(ev){
  if(!ev||typeof ev!=='object'||!originValid(ev.origin_id)||!idValid(ev.event_id)||!idValid(ev.request_id)||
    !kindValid(ev.kind)||!statusValid(ev.status))return null;
  const t=Number(ev.created_at),updated=Number(ev.updated_at)||t;
  if(!Number.isSafeInteger(t)||t<946684800000||t>Date.now()+300000||!Number.isSafeInteger(updated)||updated> Date.now()+300000)return null;
  let metadata=null;
  if(ev.meta!=null){
    const raw=typeof ev.meta==='string'?ev.meta:JSON.stringify(ev.meta);
    if(raw.length>MAX_META)return null;
    try{const o=JSON.parse(raw);if(o&&typeof o==='object')metadata=JSON.stringify(o);}catch{return null;}
  }
  return {origin_id:txt(ev.origin_id,90),event_id:txt(ev.event_id,100),request_id:txt(ev.request_id,100),
    status:ev.status,kind:ev.kind,title:txt(ev.title,160),artist:txt(ev.artist,160),album:txt(ev.album,160),
    image:txt(ev.image,700),url:txt(ev.url,700),created_at:t,updated_at:updated,meta:metadata};
}
function statement(db,ev){
  return db.prepare(`INSERT OR IGNORE INTO hive_request_events
    (origin_id,event_id,request_id,status,kind,title,artist,album,image,url,created_at,updated_at,meta)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ev.origin_id,ev.event_id,ev.request_id,ev.status,ev.kind,
      ev.title,ev.artist,ev.album,ev.image,ev.url,ev.created_at,ev.updated_at,ev.meta);
}
function stateStatement(db,ev,source=''){
  return db.prepare(`INSERT INTO hive_request_state
    (origin_id,request_id,status,kind,title,artist,album,image,url,created_at,updated_at,meta,source_url)
    SELECT origin_id,request_id,status,kind,title,artist,album,image,url,created_at,updated_at,meta,? FROM hive_request_events WHERE origin_id=? AND event_id=? ON CONFLICT(origin_id,request_id) DO UPDATE SET
    status=excluded.status,kind=excluded.kind,title=excluded.title,artist=excluded.artist,
    album=excluded.album,image=excluded.image,url=excluded.url,updated_at=excluded.updated_at,
    meta=excluded.meta,source_url=CASE WHEN excluded.source_url='' THEN hive_request_state.source_url ELSE excluded.source_url END
    WHERE excluded.updated_at>hive_request_state.updated_at OR (excluded.updated_at=hive_request_state.updated_at AND hive_request_state.status='active')`)
    .bind(txt(source,250),ev.origin_id,ev.event_id);
}
export async function ensureHiveRequests(env){
  if(ready.has(env.DB))return;
  await (async()=>{
    const db=env.DB;
    await ensureTelemetrySchema(env); // Stable instance identity used for origin-tagged deduplication.
    if((await db.prepare("SELECT value FROM settings WHERE key='hive_request_schema'").first())?.value==='18.2')return;
    for(const sql of [
      `CREATE TABLE IF NOT EXISTS hive_request_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, origin_id TEXT NOT NULL,event_id TEXT NOT NULL,
        request_id TEXT NOT NULL,status TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,
        artist TEXT NOT NULL DEFAULT '',album TEXT NOT NULL DEFAULT '',image TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        meta TEXT,UNIQUE(origin_id,event_id))`,
      `CREATE INDEX IF NOT EXISTS idx_hive_request_events_origin ON hive_request_events(origin_id,request_id,updated_at)`,
      `CREATE TABLE IF NOT EXISTS hive_request_state (
        origin_id TEXT NOT NULL,request_id TEXT NOT NULL,status TEXT NOT NULL,kind TEXT NOT NULL,
        title TEXT NOT NULL,artist TEXT NOT NULL DEFAULT '',album TEXT NOT NULL DEFAULT '',
        image TEXT NOT NULL DEFAULT '',url TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,meta TEXT,source_url TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(origin_id,request_id))`,
      `CREATE INDEX IF NOT EXISTS idx_hive_active_request ON hive_request_state(status,created_at)`,
      `CREATE TABLE IF NOT EXISTS hive_request_dismissals (
        origin_id TEXT NOT NULL, request_id TEXT NOT NULL, dismissed_at INTEGER NOT NULL,
        PRIMARY KEY(origin_id,request_id))`,
      `CREATE TABLE IF NOT EXISTS hive_request_local_review (
        origin_id TEXT NOT NULL, request_id TEXT NOT NULL, stats TEXT, done_at INTEGER,
        hidden_at INTEGER, PRIMARY KEY(origin_id,request_id))`,
      `CREATE TABLE IF NOT EXISTS hive_request_peer_cursors (
        url TEXT PRIMARY KEY,node_id TEXT NOT NULL DEFAULT '',cursor INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '')`
    ])await db.prepare(sql).run();
    await db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES('hive_req_next_sync','0')`).run();
    await db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('hive_request_schema','18.2')").run();
  })();
  ready.add(env.DB);
}
// Own request events are exported only after explicit public request submission.
export async function publishHiveRequest(env,row,status='active'){
  await ensureHiveRequests(env);
  const db=env.DB;
  const local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
  if(!originValid(local))throw Error('HIVE instance identity missing');
  let sharedMeta=row.meta;try{const parsed=typeof sharedMeta==='string'?JSON.parse(sharedMeta):sharedMeta;if(parsed){const {matched_missing,review,...other}=parsed;sharedMeta=JSON.stringify(other);if(sharedMeta.length>MAX_META){const {tracks,...summary}=other;sharedMeta=JSON.stringify({...summary,track_list_truncated:true});}}}catch{sharedMeta=null;}
  const raw={origin_id:local,event_id:crypto.randomUUID(),request_id:row.id,status,
    kind:row.kind,title:row.title,artist:row.artist,album:row.album,image:row.image,
    url:row.url,created_at:Number(row.created_at)||Date.now(),updated_at:Date.now(),meta:sharedMeta};
  const ev=validateEvent(raw);if(!ev)throw Error('Invalid request event');
  await db.batch([statement(db,ev),stateStatement(db,ev,'')]);
  return ev;
}
export async function reconcileLocalRequestEvents(env){
  await ensureHiveRequests(env);
  const db=env.DB,local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value||'';
  if(!originValid(local))return 0;
  // Bounded backfill on first upgrade and eventual status reconciliation.
  const source=rows(await db.prepare(`SELECT r.id,r.kind,r.title,r.artist,r.album,r.image,r.url,r.created_at,r.done_at,r.status,r.meta
    FROM requests r LEFT JOIN hive_request_state h ON h.origin_id=? AND h.request_id=r.id
    WHERE h.request_id IS NULL OR h.status<>CASE WHEN r.status IN ('done','active') THEN r.status ELSE 'cancelled' END
    ORDER BY r.created_at DESC LIMIT 8`).bind(local).all());
  let added=0;
  for(const r of source){
    const status=['done','active'].includes(r.status)?r.status:'cancelled';
    try{await publishHiveRequest(env,r,status);added++;}catch{}
  }
  return added;
}
export async function hiveRequestFeed(env,url){
  await ensureHiveRequests(env);
  const db=env.DB;
  const shared=await db.prepare("SELECT value FROM settings WHERE key='network_share'").first();
  if(shared?.value!=='1')return out({error:'Request sharing disabled'},403);
  await reconcileLocalRequestEvents(env);
  const cursor=Number(url.searchParams.get('cursor')||0);
  if(!Number.isSafeInteger(cursor)||cursor<0)return out({error:'Invalid cursor'},400);
  const limit=Math.max(1,Math.min(MAX_BATCH,Number(url.searchParams.get('limit'))||MAX_BATCH));
  const events=rows(await db.prepare('SELECT * FROM hive_request_events WHERE seq>? ORDER BY seq LIMIT ?').bind(cursor,limit).all());
  const node=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
  return out({ok:true,protocol:1,nodeId:node,cursor:events.length?events.at(-1).seq:cursor,
    events:events.map(({seq,...rest})=>rest)});
}
// The last relay is not necessarily the originating WASP. Only a verified
// feed node ID can associate an approved directly connected URL with the origin.
async function originRecords(env,origin=null){
  await ensureHiveRequests(env);const db=env.DB;
  const sql=`SELECT c.node_id,c.url,c.synced_at,c.last_error FROM hive_request_peer_cursors c
    WHERE ${origin?'c.node_id=? AND ':''}(EXISTS(SELECT 1 FROM peers p WHERE p.url=c.url) OR EXISTS(
      SELECT 1 FROM user_published_peers u LEFT JOIN user_peer_permissions p ON p.user_id=u.user_id
      WHERE u.url=c.url AND COALESCE(p.enabled,(SELECT CAST(value AS INTEGER) FROM settings WHERE key='user_publish_default'),0)=1))
    ORDER BY CASE WHEN c.last_error='' THEN 0 ELSE 1 END,c.synced_at DESC`;
  const q=db.prepare(sql);return rows(await (origin?q.bind(origin):q).all());
}
const noOrigin=()=>({origin_domain:null,origin_status:'unknown',origin_checked_at:null});
function originDetails(hit){if(!hit)return noOrigin();const status=hit.last_error?(/^Offline:/.test(hit.last_error)?'offline':'unknown'):(Date.now()-Number(hit.synced_at)<20*60*1000?'online':'unknown');return {origin_domain:hit.url,origin_status:status,origin_checked_at:hit.synced_at||null};}
export async function originStatus(env,origin){return originDetails((await originRecords(env,origin))[0]);}
function publicRequestImage(value){try{const u=new URL(value);return u.protocol==='https:'&&(/(^|\.)dzcdn\.net$|(^|\.)scdn\.co$|(^|\.)spotifycdn\.com$|(^|\.)wikimedia\.org$/.test(u.hostname))?u.href:'';}catch{return '';}}
function publicRequestLink(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='open.spotify.com'&&/^\/playlist\/[A-Za-z0-9]{10,40}$/.test(u.pathname)?u.origin+u.pathname:'';}catch{return '';}}
export async function hiveRequestsForDisplay(env,{history=false,admin=false}={}){
  await ensureHiveRequests(env);
  const db=env.DB,local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value||'';
  const rowsOut=rows(await db.prepare(`SELECT s.*,v.stats AS local_stats,v.done_at AS local_done_at,v.hidden_at
    FROM hive_request_state s LEFT JOIN hive_request_local_review v ON v.origin_id=s.origin_id AND v.request_id=s.request_id
    WHERE s.origin_id<>? AND ${history?"(s.status='done' OR (s.status='active' AND v.done_at IS NOT NULL))":"s.status='active' AND v.done_at IS NULL AND v.hidden_at IS NULL AND NOT EXISTS (SELECT 1 FROM hive_request_dismissals d WHERE d.origin_id=s.origin_id AND d.request_id=s.request_id)"}
    ORDER BY s.created_at ASC LIMIT 500`).bind(local).all());
  const origins=new Map();
  if(admin)for(const r of await originRecords(env))if(!origins.has(r.node_id))origins.set(r.node_id,originDetails(r));
  return rowsOut.map(r=>{
    let meta=null,stats=null;try{meta=r.meta?JSON.parse(r.meta):null;}catch{}try{stats=r.local_stats?JSON.parse(r.local_stats):null;}catch{}
    return {id:r.origin_id+'|'+r.request_id,kind:r.kind,title:r.title,artist:r.artist,album:r.album,
      image:publicRequestImage(r.image),url:publicRequestLink(r.url),created_at:r.created_at,done_at:history?(r.status==='done'?r.updated_at:r.local_done_at):null,
      remote:true,read_only:true,local_completion:!!r.local_done_at&&r.status!=='done',
      ...(meta&&meta.total?{total:meta.total,partial:!!meta.partial,source_total:meta.source_total??null,source_status:meta.source_status||'unverified'}:{}),
      ...(stats?{matched_local:stats.matched_local??null,matched_peer:stats.matched_peer??null,availability_checked_at:stats.availability_checked_at??null}:{}),
      ...(admin?{...(origins.get(r.origin_id)||noOrigin()),...(stats||{})}:{})};
  });
}
export async function reviewRemoteRequest(env,id,{stats=null,done=false,hide=false}={}){
  await ensureHiveRequests(env);const db=env.DB;
  const [o,r,...rest]=String(id).split('|');if(rest.length||!originValid(o)||!idValid(r))return false;
  const current=await db.prepare("SELECT origin_id FROM hive_request_state WHERE origin_id=? AND request_id=? AND status='active'").bind(o,r).first();if(!current)return false;
  if(hide&&(await originStatus(env,o)).origin_status!=='offline')return false;
  await db.prepare(`INSERT INTO hive_request_local_review(origin_id,request_id,stats,done_at,hidden_at)
    VALUES(?,?,?,?,?) ON CONFLICT(origin_id,request_id) DO UPDATE SET
    stats=COALESCE(excluded.stats,hive_request_local_review.stats),
    done_at=COALESCE(excluded.done_at,hive_request_local_review.done_at),
    hidden_at=COALESCE(excluded.hidden_at,hive_request_local_review.hidden_at)`)
    .bind(o,r,stats?JSON.stringify(stats):null,done?Date.now():null,hide?Date.now():null).run();return true;
}
export async function remoteRequestRow(env,id){
  await ensureHiveRequests(env);const [o,r,...rest]=String(id).split('|');if(rest.length||!originValid(o)||!idValid(r))return null;
  return env.DB.prepare("SELECT * FROM hive_request_state WHERE origin_id=? AND request_id=? AND status='active'").bind(o,r).first();
}
// Remote dismissals are private to this server; no exported cancellation event.
export async function dismissHiveRequests(env,{ids=[],all=false}={}){
  await ensureHiveRequests(env);
  const db=env.DB,local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
  const now=Date.now();
  if(all){const r=await db.prepare(`INSERT OR IGNORE INTO hive_request_dismissals(origin_id,request_id,dismissed_at)
    SELECT origin_id,request_id,? FROM hive_request_state WHERE origin_id<>? AND status='active'`).bind(now,local).run();return changes(r);}
  const pairs=[...new Set(ids)].map(id=>String(id).split('|')).filter(p=>p.length===2&&originValid(p[0])&&idValid(p[1])&&p[0]!==local);
  if(!pairs.length)return 0;
  const statements=pairs.map(([o,id])=>db.prepare(`INSERT OR IGNORE INTO hive_request_dismissals(origin_id,request_id,dismissed_at)
    SELECT origin_id,request_id,? FROM hive_request_state WHERE origin_id=? AND request_id=? AND status='active'`).bind(now,o,id));
  return (await db.batch(statements)).reduce((n,r)=>n+changes(r),0);
}
// Pull from every directly connected admin peer and approved user-published
// server, eventually forwarding origin-tagged events through intermediate peers.
export async function syncHiveRequests(env,{fetcher=fetch,force=false,targetOrigin=null}={}){
  await ensureHiveRequests(env);await reconcileLocalRequestEvents(env);
  const db=env.DB,now=Date.now();
  if(!force){
    const lease=await db.prepare(`UPDATE settings SET value=? WHERE key='hive_req_next_sync' AND CAST(value AS INTEGER)<?`)
      .bind(String(now+300000),now).run();
    if(!changes(lease))return {skipped:true};
  }
  // v18.0.1 could persist an event/cursor before its state write. Replay existing
  // ledger in bounded pages; origin ownership and newer states are preserved.
  const repair=(await db.prepare("SELECT value FROM settings WHERE key='hive_request_repair_v182'").first())?.value;
  if(repair!=='done'){
    const page=rows(await db.prepare('SELECT * FROM hive_request_events WHERE seq>? ORDER BY seq LIMIT 60').bind(Number(repair)||0).all());
    const operations=page.map(e=>stateStatement(db,e,''));
    operations.push(db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('hive_request_repair_v182',?)").bind(page.length<60?'done':String(page.at(-1).seq)));
    await db.batch(operations);
  }
  const direct=rows(await db.prepare('SELECT url FROM peers ORDER BY added_at LIMIT 60').all()).map(x=>x.url);
  const published=rows(await db.prepare(`SELECT l.url FROM user_published_peers l
    LEFT JOIN user_peer_permissions p ON p.user_id=l.user_id
    WHERE COALESCE(p.enabled,(SELECT CAST(value AS INTEGER) FROM settings WHERE key='user_publish_default'),0)=1
      AND l.last_ok IS NOT NULL AND l.last_error IS NULL ORDER BY l.created_at LIMIT 60`).all()).map(x=>x.url);
  const peers=[...new Set([...direct,...published])].filter(Boolean);
  const offset=Number((await db.prepare("SELECT value FROM settings WHERE key='hive_req_peer_offset'").first())?.value)||0;
  const count=Math.min(peers.length,MAX_PEERS);
  let selected=Array.from({length:count},(_,i)=>peers[(offset+i)%peers.length]);
  if(targetOrigin){const direct=(await originStatus(env,targetOrigin)).origin_domain;if(direct&&peers.includes(direct))selected=[direct];}
  if(peers.length&&!targetOrigin)await db.prepare("INSERT INTO settings(key,value) VALUES('hive_req_peer_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(String((offset+count)%peers.length)).run();
  let checked=0,imported=0,errors=0;
  for(const base of selected){
    let connected=false;
    try{
      const u=new URL(base);
      if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))continue;
      const prior=await db.prepare('SELECT node_id,cursor FROM hive_request_peer_cursors WHERE url=?').bind(base).first();
      const request=new URL('/api/hive/requests/feed',u);
      request.searchParams.set('cursor',String(Number(prior?.cursor)||0));request.searchParams.set('limit',String(MAX_BATCH));
      const fetched=await fetcher(request,{redirect:'manual',signal:AbortSignal.timeout(TIMEOUT),headers:{accept:'application/json'}});connected=true;const response=requireNoRedirect(fetched);
      if([403,404].includes(response.status)){await db.prepare('UPDATE hive_request_peer_cursors SET last_error=? WHERE url=?').bind('Feed unavailable '+response.status,base).run();continue;} // not proof of an offline host
      if(!response.ok)throw Error((response.status>=500?'Offline: ':'')+'Peer HTTP '+response.status);
      const data=await response.json();
      if(!data.ok||data.protocol!==1||!originValid(data.nodeId)||!Array.isArray(data.events)||data.events.length>MAX_BATCH)throw Error('Invalid HIVE request feed');
      const local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
      if(local===data.nodeId)continue;
      if(prior?.node_id&&prior.node_id!==data.nodeId){
        await db.prepare('UPDATE hive_request_peer_cursors SET node_id=?,cursor=0,synced_at=?,last_error=? WHERE url=?')
          .bind(data.nodeId,now,'Peer database changed; replay from start',base).run();continue;
      }
      const events=data.events.map(validateEvent);
      if(events.some(e=>!e))throw Error('Invalid HIVE request event');
      const next=Number(data.cursor),cursor=Number(prior?.cursor)||0;
      if(!Number.isSafeInteger(next)||next<cursor||(events.length&&next<=cursor))throw Error('Invalid sync cursor');
      // INSERT OR IGNORE deduplicates atomically; avoid one D1 subrequest per
      // event, which exhausted the Free Worker limit on larger request feeds.
      const incoming=events.filter(e=>e.origin_id!==local);
      const statements=incoming.flatMap(e=>[statement(db,e),stateStatement(db,e,base)]);
      statements.push(db.prepare(`INSERT INTO hive_request_peer_cursors(url,node_id,cursor,synced_at,last_error)
        VALUES(?,?,?,?,'') ON CONFLICT(url) DO UPDATE SET node_id=excluded.node_id,cursor=MAX(hive_request_peer_cursors.cursor,excluded.cursor),
        synced_at=excluded.synced_at,last_error=''`).bind(base,data.nodeId,next,now));
      statements.push(db.prepare('UPDATE hive_request_local_review SET hidden_at=NULL WHERE origin_id=? AND hidden_at IS NOT NULL AND hidden_at<=?').bind(data.nodeId,now));
      const applied=await db.batch(statements);
      checked++;imported+=incoming.reduce((n,_,i)=>n+changes(applied[2*i]),0);
    }catch(error){
      errors++;
      await db.prepare(`INSERT INTO hive_request_peer_cursors(url,node_id,cursor,synced_at,last_error)
        VALUES(?,'',0,0,?) ON CONFLICT(url) DO UPDATE SET last_error=excluded.last_error`)
        .bind(base,txt((connected?'':'Offline: ')+error.message,140)).run().catch(()=>{});
    }
  }
  return {checked,imported,errors,totalPeers:peers.length};
}
