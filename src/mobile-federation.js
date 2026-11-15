/**
 * WASP v16 Mobile Bridge: metadata-only, one-hop federation from a trusted
 * WASP gateway (v15+). No peer credentials, private network routes or MP3 data
 * are imported. Only publicly routable HTTPS peers explicitly registered by
 * the gateway are eligible for recursive catalogue discovery.
 */
const MAX_SOURCES=15, MAX_TRACKS=6000, MAX_PLAYLISTS=500;
const MAX_JSON=8_000_000, CHUNK_BYTES=230_000;
const enc=new TextEncoder();
const safeId=s=>/^[\w-]{1,120}$/.test(String(s||''));
function clean(v,n=200){return String(v??'').trim().slice(0,n);}
export function publicPeerOrigin(raw){
  try{
    const u=new URL(String(raw));
    if(u.protocol!=='https:' || u.username || u.password || u.port && u.port!=='443' ||
       u.pathname!=='/' || u.search || u.hash)return '';
    const host=u.hostname.toLowerCase();
    if(!/^[a-z0-9.-]+$/.test(host)||host.length>253||!host.includes('.')||
       host==='localhost'||host.endsWith('.local')||host.endsWith('.internal')||
       host.endsWith('.localhost')||host.endsWith('.test')||host.endsWith('.invalid')||
       /^\d+(?:\.\d+){3}$/.test(host)||host.includes('..'))return '';
    return u.origin;
  }catch{return '';}
}
export async function ensureFederationSchema(DB){
  await DB.prepare(`CREATE TABLE IF NOT EXISTS mobile_federation_sources(
    gateway_id TEXT NOT NULL,origin TEXT NOT NULL,synced_at INTEGER NOT NULL DEFAULT 0,
    track_count INTEGER NOT NULL DEFAULT 0,playlist_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(gateway_id,origin))`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS mobile_federation_chunks(
    gateway_id TEXT NOT NULL,origin TEXT NOT NULL,kind TEXT NOT NULL,
    shard INTEGER NOT NULL,body TEXT NOT NULL,
    PRIMARY KEY(gateway_id,origin,kind,shard))`).run();
}
async function fetchJson(url,max=MAX_JSON){
  const res=await fetch(url,{method:'GET',redirect:'manual',headers:{accept:'application/json','cache-control':'no-cache'},signal:AbortSignal.timeout(6500)});
  if(!res.ok || !/application\/json/i.test(res.headers.get('content-type')||''))throw Error(`Upstream HTTP ${res.status} or non-JSON response`);
  if(Number(res.headers.get('content-length')||0)>max)throw Error('Upstream metadata exceeds limit');
  const raw=await res.text();if(enc.encode(raw).byteLength>max)throw Error('Upstream metadata exceeds limit');
  return JSON.parse(raw);
}
function normalizeCatalogue(obj){
  return {tracks:Array.isArray(obj?.tracks)?obj.tracks.slice(0,MAX_TRACKS):[],
    playlists:Array.isArray(obj?.playlists)?obj.playlists.slice(0,MAX_PLAYLISTS):[],
    users:Array.isArray(obj?.users)?obj.users.slice(0,MAX_PLAYLISTS):[],
    genres:obj?.genres && typeof obj.genres==='object' && !Array.isArray(obj.genres)?obj.genres:{}};
}
function splitChunks(rows){
  const chunks=[];let group=[],size=2;
  for(const row of rows){
    const part=JSON.stringify(row);if(!part)continue;
    const length=enc.encode(part).length;
    if(length>CHUNK_BYTES)continue;
    if(group.length && size+length+1>CHUNK_BYTES){chunks.push(JSON.stringify(group));group=[];size=2;}
    group.push(row);size+=length+1;
  }
  if(group.length)chunks.push(JSON.stringify(group));
  return chunks;
}
async function storeSource(DB,gatewayId,origin,catalogue){
  const c=normalizeCatalogue(catalogue),queries=[];
  for(const kind of ['tracks','playlists','users','genres']){
    queries.push(DB.prepare('DELETE FROM mobile_federation_chunks WHERE gateway_id=? AND origin=? AND kind=?').bind(gatewayId,origin,kind));
    const array=kind==='genres'?Object.entries(c.genres).map(([artist,genres])=>({artist,genres})):c[kind];
    for(const [index,body] of splitChunks(array).entries()){
      queries.push(DB.prepare('INSERT INTO mobile_federation_chunks(gateway_id,origin,kind,shard,body) VALUES(?,?,?,?,?)').bind(gatewayId,origin,kind,index,body));
    }
  }
  queries.push(DB.prepare(`INSERT INTO mobile_federation_sources(gateway_id,origin,synced_at,track_count,playlist_count)
    VALUES(?,?,?,?,?) ON CONFLICT(gateway_id,origin) DO UPDATE SET synced_at=excluded.synced_at,
    track_count=excluded.track_count,playlist_count=excluded.playlist_count`)
    .bind(gatewayId,origin,Date.now(),c.tracks.length,c.playlists.length+c.users.length));
  await DB.batch(queries);
  return {tracks:c.tracks.length,playlists:c.playlists.length+c.users.length};
}
async function directCatalogue(origin){
  const [tracks,playlists,users,genres]=await Promise.all([
    fetchJson(origin+'/api/tracks'),fetchJson(origin+'/api/playlists'),
    fetchJson(origin+'/api/user-playlists'),fetchJson(origin+'/api/genres',300_000).catch(()=>({}))]);
  if(!Array.isArray(tracks)||!Array.isArray(playlists)||!Array.isArray(users))throw Error('Malformed public catalogue');
  return {tracks,playlists,users,genres};
}
/** Explicitly triggered when an admin syncs a configured v15 gateway peer.
 * No URL from a mobile client can call this function. If the gateway fails,
 * existing snapshots remain intact; no destructive change to webapp tables. */
export async function syncFederatedFromGateway(env,gateway){
  await ensureFederationSchema(env.DB);
  const summary={sources:0,tracks:0,playlists:0,errors:[]};
  if(!publicPeerOrigin(gateway.url)){
    summary.errors.push('Federation discovery requires a public HTTPS gateway');return summary;
  }
  let registered, snapshots;
  try{
    const gatewayShare=await fetchJson(gateway.url+'/api/peer',100_000);
    if(gatewayShare?.ok!==true)throw Error('Gateway is not sharing its WASP library');
    [registered,snapshots]=await Promise.all([
      fetchJson(gateway.url+'/api/network/peers?mobile_sync='+crypto.randomUUID(),500_000),
      fetchJson(gateway.url+'/api/peer-catalogue?mobile_sync='+crypto.randomUUID()).catch(()=>[])
    ]);
  }catch(e){summary.errors.push('Gateway registry: '+e.message);return summary;}
  if(!Array.isArray(registered)){
    summary.errors.push('Gateway peer registry is not a list');return summary;
  }
  // Only administrator-managed peers from the configured gateway; community
  // submissions may be user-controlled and must not silently become fetch targets.
  const origins=[...new Set(registered.filter(x=>x && !x.community && x.url)
    .map(x=>publicPeerOrigin(x.url)).filter(x=>x && x!==gateway.url))].slice(0,MAX_SOURCES);
  const saved=new Map((Array.isArray(snapshots)?snapshots:[]).filter(x=>x && x.origin && origins.includes(publicPeerOrigin(x.origin)))
    .map(x=>[publicPeerOrigin(x.origin),x]));
  // The gateway's own songs have already been imported by native peer sync.
  // Its genre metadata is independent and allows mobile apps to browse genres
  // even when a track itself has no ID3 genre field.
  try{
    const genres=await fetchJson(gateway.url+'/api/genres',300_000);
    if(genres && typeof genres==='object' && !Array.isArray(genres))
      await storeSource(env.DB,gateway.id,gateway.url,{tracks:[],playlists:[],users:[],genres});
  }catch{} // Genres are optional and must never break peer synchronization.
  // Grouped concurrency makes the Worker finish within its ordinary budget,
  // while individual upstream failures do not discard other available peers.
  for(let start=0;start<origins.length;start+=4){
    const outcome=await Promise.allSettled(origins.slice(start,start+4).map(async origin=>{
      const share=await fetchJson(origin+'/api/peer',100_000);
      if(share?.ok!==true)throw Error('Downstream peer is not sharing its WASP library');
      const snap=saved.get(origin);
      // Prefer the already synchronized, authenticated gateway snapshot.
      // Fetch the peer's public API directly when the gateway did not sync it.
      let catalogue=snap && Array.isArray(snap.tracks) && snap.tracks.length ? snap : await directCatalogue(origin);
      if(!catalogue.genres || !Object.keys(catalogue.genres).length){
        const genres=await fetchJson(origin+'/api/genres',300_000).catch(()=>({}));
        catalogue={...catalogue,genres};
      }
      return {origin,...await storeSource(env.DB,gateway.id,origin,catalogue)};
    }));
    outcome.forEach((r,i)=>{
      if(r.status==='fulfilled'){
        summary.sources++;summary.tracks+=r.value.tracks;summary.playlists+=r.value.playlists;
      }else summary.errors.push(`${origins[start+i]}: ${clean(r.reason?.message||'Unavailable',140)}`);
    });
  }
  // Remove sources that are no longer approved by the gateway; do not retain
  // access to catalogue data after a peer is removed from its trusted registry.
  const old=(await env.DB.prepare('SELECT origin FROM mobile_federation_sources WHERE gateway_id=?').bind(gateway.id).all()).results;
  for(const row of old.filter(r=>r.origin!==gateway.url && !origins.includes(r.origin))){
    await env.DB.batch([
      env.DB.prepare('DELETE FROM mobile_federation_chunks WHERE gateway_id=? AND origin=?').bind(gateway.id,row.origin),
      env.DB.prepare('DELETE FROM mobile_federation_sources WHERE gateway_id=? AND origin=?').bind(gateway.id,row.origin)]);
  }
  return summary;
}
export async function readFederatedCatalogue(DB){
  await ensureFederationSchema(DB);
  // The join ensures deleting a gateway peer immediately hides its federation.
  const sources=(await DB.prepare(`SELECT f.gateway_id,f.origin FROM mobile_federation_sources f
    JOIN peers p ON p.id=f.gateway_id ORDER BY f.gateway_id,f.origin LIMIT 80`).all()).results;
  const result=[];
  for(const row of sources){
    const parts=(await DB.prepare(`SELECT kind,body FROM mobile_federation_chunks
      WHERE gateway_id=? AND origin=? ORDER BY kind,shard`).bind(row.gateway_id,row.origin).all()).results;
    const c={gatewayId:row.gateway_id,origin:row.origin,tracks:[],playlists:[],users:[],genres:{}};
    for(const part of parts){
      let list;try{list=JSON.parse(part.body);}catch{continue;}
      if(!Array.isArray(list))continue;
      if(part.kind==='genres')for(const item of list){if(item?.artist)c.genres[item.artist]=item.genres;}
      else if(['tracks','playlists','users'].includes(part.kind))c[part.kind].push(...list);
    }
    result.push(c);
  }
  return result;
}
