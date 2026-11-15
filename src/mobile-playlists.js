/**
 * Subsonic playlist compatibility over WASP's native playlist tables and
 * synchronized, explicitly shared peer snapshots. Read-only by design.
 * Never requests remote audio during library listings.
 */
const clean=s=>String(s??'').trim();
const originKey=(origin,id)=>String(origin||'')+'\0'+String(id||'');
const LIMIT=1200;
function stamp(value){
  const ts=Number(value);
  return new Date(ts>0 ? ts : Date.now()).toISOString();
}
function sourceSong(catalogue,source,remoteId){
  if(!source || !remoteId || !catalogue.authorizedOrigins.has(source))return null;
  return catalogue.byOrigin.get(originKey(source,remoteId)) || null;
}
/** Get the list and a resolver for the authenticated account. */
export async function readMobilePlaylists(DB,catalogue,auth){
  const ownAndPublic=(await DB.prepare(`SELECT p.id,p.name,p.is_public,p.created_at,p.user_id,u.username
    FROM user_playlists p JOIN user_accounts u ON u.id=p.user_id
    WHERE p.user_id=? OR p.is_public=1
    ORDER BY (p.user_id=?) DESC,p.created_at DESC LIMIT 400`).bind(auth.userId,auth.userId).all()).results;
  const server=(await DB.prepare('SELECT id,name,created_at FROM playlists ORDER BY created_at DESC LIMIT 300').all()).results;
  const mobile=new Map();
  const references=new Map();
  const allIds=[...new Set([...ownAndPublic.map(x=>x.id),...server.map(x=>x.id)])];
  const userLinks=new Map(),serverLinks=new Map();
  // Chunk IN parameters to stay compatible with D1 SQLite's variable limits.
  for(let i=0;i<allIds.length;i+=75){
    const ids=allIds.slice(i,i+75),holders=ids.map(()=>'?').join(',');
    for(const [sql,target] of [
      [`SELECT playlist_id,track_id FROM user_playlist_tracks WHERE playlist_id IN (${holders}) ORDER BY added_at,rowid`,userLinks],
      [`SELECT playlist_id,track_id FROM playlist_tracks WHERE playlist_id IN (${holders}) ORDER BY added_at,rowid`,serverLinks]
    ]){
      const items=(await DB.prepare(sql).bind(...ids).all()).results;
      for(const item of items){if(!target.has(item.playlist_id))target.set(item.playlist_id,[]);
        if(target.get(item.playlist_id).length<LIMIT)target.get(item.playlist_id).push(clean(item.track_id));}
    }
  }
  const refs=[...new Set([...userLinks.values(),...serverLinks.values()].flat().filter(id=>id.startsWith('peer:')))];
  for(let i=0;i<refs.length;i+=75){
    const batch=refs.slice(i,i+75);
    const rows=(await DB.prepare(`SELECT ref,origin,remote_id FROM peer_track_refs WHERE ref IN (${batch.map(()=>'?').join(',')})`).bind(...batch).all()).results;
    for(const row of rows)references.set(row.ref,row);
  }
  function resolvedSource(value){
    const id=clean(value);
    if(!id)return null;
    if(catalogue.byId.has('l:'+id))return catalogue.byId.get('l:'+id);
    const ref=references.get(id);
    if(!ref)return null;
    return sourceSong(catalogue,ref.origin,ref.remote_id);
  }
  function put(row,raw){
    if(mobile.has(row.id))return;
    mobile.set(row.id,{...row,raw});
  }
  // WASP's server-managed playlists are public through /api/playlists. Their
  // IDs are namespaced to avoid collisions with user and remote playlist IDs.
  for(const p of server){
    const entries=(serverLinks.get(p.id)||[]).map(resolvedSource).filter(Boolean);
    put({id:'sv:'+p.id,name:p.name,owner:'WASP server',public:true,created:stamp(p.created_at),songCount:entries.length,kind:'server'},entries);
  }
  for(const p of ownAndPublic){
    const entries=(userLinks.get(p.id)||[]).map(resolvedSource).filter(Boolean);
    put({id:p.id,name:p.name,owner:p.username||'WASP member',public:!!p.is_public,created:stamp(p.created_at),songCount:entries.length,kind:'user'},entries);
  }
  for(const p of (catalogue.peerPlaylists||[])){
    const entries=(p.tracks||[]).slice(0,LIMIT).map(item=>{
      const ref=typeof item==='string'?item:clean(item?.id||item?.track_id);
      const mapped=p.track_sources?.[ref];
      if(mapped)return sourceSong(catalogue,clean(mapped.origin).replace(/\/$/,''),clean(mapped.remote_id));
      return sourceSong(catalogue,p.origin,ref);
    }).filter(Boolean);
    put({id:p.id,name:p.name,owner:p.owner||'WASP peer',public:true,created:stamp(p.created_at),songCount:entries.length,kind:'peer'},entries);
  }
  const rows=[...mobile.values()];
  return {rows,find(id){return mobile.get(id)||null;}};
}
