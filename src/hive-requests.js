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
const ready = new WeakMap();
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
async function applyState(db,ev,source=''){
  await db.prepare(`INSERT INTO hive_request_state
    (origin_id,request_id,status,kind,title,artist,album,image,url,created_at,updated_at,meta,source_url)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(origin_id,request_id) DO UPDATE SET
    status=excluded.status,kind=excluded.kind,title=excluded.title,artist=excluded.artist,
    album=excluded.album,image=excluded.image,url=excluded.url,updated_at=excluded.updated_at,
    meta=excluded.meta,source_url=excluded.source_url
    WHERE excluded.updated_at>=hive_request_state.updated_at`)
    .bind(ev.origin_id,ev.request_id,ev.status,ev.kind,ev.title,ev.artist,ev.album,ev.image,ev.url,
      ev.created_at,ev.updated_at,ev.meta,txt(source,250)).run();
}
export function ensureHiveRequests(env){
  if(ready.has(env.DB))return ready.get(env.DB);
  const task=(async()=>{
    const db=env.DB;
    await ensureTelemetrySchema(env); // Stable instance identity used for origin-tagged deduplication.
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
      `CREATE TABLE IF NOT EXISTS hive_request_peer_cursors (
        url TEXT PRIMARY KEY,node_id TEXT NOT NULL DEFAULT '',cursor INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '')`
    ])await db.prepare(sql).run();
    await db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES('hive_req_next_sync','0')`).run();
  })().catch(e=>{ready.delete(env.DB);throw e;});
  ready.set(env.DB,task);return task;
}
// Own request events are exported only after explicit public request submission.
export async function publishHiveRequest(env,row,status='active'){
  await ensureHiveRequests(env);
  const db=env.DB;
  const local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
  if(!originValid(local))throw Error('HIVE instance identity missing');
  const raw={origin_id:local,event_id:crypto.randomUUID(),request_id:row.id,status,
    kind:row.kind,title:row.title,artist:row.artist,album:row.album,image:row.image,
    url:row.url,created_at:Number(row.created_at)||Date.now(),updated_at:Date.now(),meta:row.meta};
  const ev=validateEvent(raw);if(!ev)throw Error('Invalid request event');
  await db.batch([statement(db,ev)]);
  await applyState(db,ev,'');
  return ev;
}
export async function reconcileLocalRequestEvents(env){
  await ensureHiveRequests(env);
  const db=env.DB,local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value||'';
  if(!originValid(local))return 0;
  // Bounded backfill on first upgrade and eventual status reconciliation.
  const source=rows(await db.prepare(`SELECT id,kind,title,artist,album,image,url,created_at,done_at,status,meta
    FROM requests ORDER BY created_at DESC LIMIT 500`).all());
  let added=0;
  for(const r of source){
    const status=['done','active'].includes(r.status)?r.status:'cancelled';
    const prior=await db.prepare('SELECT status FROM hive_request_state WHERE origin_id=? AND request_id=?')
      .bind(local,r.id).first();
    if(prior?.status===status)continue;
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
export async function hiveRequestsForDisplay(env,{history=false,admin=false}={}){
  await ensureHiveRequests(env);
  const db=env.DB,local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value||'';
  const rowsOut=rows(await db.prepare(`SELECT * FROM hive_request_state WHERE origin_id<>? AND status=?
    ORDER BY created_at ASC LIMIT 500`).bind(local,history?'done':'active').all());
  return rowsOut.map(r=>{
    let meta=null;try{meta=r.meta?JSON.parse(r.meta):null;}catch{}
    return {id:r.origin_id+'|'+r.request_id,kind:r.kind,title:r.title,artist:r.artist,album:r.album,
      image:r.image,url:r.url,created_at:r.created_at,done_at:history?r.updated_at:null,
      remote:true,origin_id:r.origin_id,source_url:r.source_url,
      ...(meta&&meta.total?{total:meta.total,partial:!!meta.partial}:{}),
      // Only the originating WASP may complete/remove remote requests.
      read_only:true};
  });
}
// Pull from every directly connected admin peer and approved user-published
// server, eventually forwarding origin-tagged events through intermediate peers.
export async function syncHiveRequests(env,{fetcher=fetch,force=false}={}){
  await ensureHiveRequests(env);await reconcileLocalRequestEvents(env);
  const db=env.DB,now=Date.now();
  if(!force){
    const lease=await db.prepare(`UPDATE settings SET value=? WHERE key='hive_req_next_sync' AND CAST(value AS INTEGER)<?`)
      .bind(String(now+300000),now).run();
    if(!changes(lease))return {skipped:true};
  }
  const direct=rows(await db.prepare('SELECT url FROM peers ORDER BY added_at LIMIT 60').all()).map(x=>x.url);
  const published=rows(await db.prepare(`SELECT l.url FROM user_published_peers l
    LEFT JOIN user_peer_permissions p ON p.user_id=l.user_id
    WHERE COALESCE(p.enabled,(SELECT CAST(value AS INTEGER) FROM settings WHERE key='user_publish_default'),0)=1
      AND l.last_ok IS NOT NULL AND l.last_error IS NULL ORDER BY l.created_at LIMIT 60`).all()).map(x=>x.url);
  const peers=[...new Set([...direct,...published])].filter(Boolean);
  const offset=Number((await db.prepare("SELECT value FROM settings WHERE key='hive_req_peer_offset'").first())?.value)||0;
  const count=Math.min(peers.length,MAX_PEERS);
  const selected=Array.from({length:count},(_,i)=>peers[(offset+i)%peers.length]);
  if(peers.length)await db.prepare("INSERT INTO settings(key,value) VALUES('hive_req_peer_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(String((offset+count)%peers.length)).run();
  let checked=0,imported=0,errors=0;
  for(const base of selected){
    try{
      const u=new URL(base);
      if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))continue;
      const prior=await db.prepare('SELECT node_id,cursor FROM hive_request_peer_cursors WHERE url=?').bind(base).first();
      const request=new URL('/api/hive/requests/feed',u);
      request.searchParams.set('cursor',String(Number(prior?.cursor)||0));request.searchParams.set('limit',String(MAX_BATCH));
      const response=requireNoRedirect(await fetcher(request,{redirect:'manual',signal:AbortSignal.timeout(TIMEOUT),headers:{accept:'application/json'}}));
      if([403,404].includes(response.status))continue; // Legacy/non-sharing peers remain compatible for music.
      if(!response.ok)throw Error('Peer HTTP '+response.status);
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
      const newly=[];
      for(const ev of events){
        if(ev.origin_id===local)continue;
        // Do not apply an event already imported through a different route.
        if(await db.prepare('SELECT 1 FROM hive_request_events WHERE origin_id=? AND event_id=?')
          .bind(ev.origin_id,ev.event_id).first())continue;
        newly.push(ev);
      }
      const statements=newly.map(e=>statement(db,e));
      statements.push(db.prepare(`INSERT INTO hive_request_peer_cursors(url,node_id,cursor,synced_at,last_error)
        VALUES(?,?,?,?,'') ON CONFLICT(url) DO UPDATE SET node_id=excluded.node_id,cursor=excluded.cursor,
        synced_at=excluded.synced_at,last_error=''`).bind(base,data.nodeId,next,now));
      await db.batch(statements);
      for(const ev of newly)await applyState(db,ev,base);
      checked++;imported+=newly.length;
    }catch(error){
      errors++;
      await db.prepare(`INSERT INTO hive_request_peer_cursors(url,node_id,cursor,synced_at,last_error)
        VALUES(?,'',0,0,?) ON CONFLICT(url) DO UPDATE SET last_error=excluded.last_error`)
        .bind(base,txt(error.message,140)).run().catch(()=>{});
    }
  }
  return {checked,imported,errors,totalPeers:peers.length};
}
