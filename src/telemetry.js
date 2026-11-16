// WASP v17 HIVE telemetry: independent, anonymous confirmed-play ledger.
// No user IDs, visitor IDs, addresses, tokens, or session IDs are transmitted.
// Source identity is preserved through intermediate peers to prevent re-counting loops.
const MINUTE = 60_000;
const MAX_BATCH = 200;
const FRESH_MS = 5 * MINUTE;
const schemaPromises = new WeakMap();
const text = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const result = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: {'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}
});
const changes = x => Number(x?.meta?.changes ?? x?.changes ?? 0);
const toRows = x => x?.results || [];

export function ensureTelemetrySchema(env) {
  if(schemaPromises.has(env.DB))return schemaPromises.get(env.DB);
  const task=(async () => {
    const db = env.DB;
    const marker = await db.prepare("SELECT value FROM settings WHERE key='wasp_telemetry_schema'").first();
    if (marker?.value === '17.1') return;
    // Additive only; existing history, accounts, volumes and peer catalogues remain unchanged.
    const statements = [
      `CREATE TABLE IF NOT EXISTS telemetry_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        origin_id TEXT NOT NULL, event_id TEXT NOT NULL,
        played_at INTEGER NOT NULL, track_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '',
        duration REAL NOT NULL DEFAULT 0,
        UNIQUE(origin_id,event_id))`,
      `CREATE INDEX IF NOT EXISTS idx_telemetry_time ON telemetry_events(played_at)`,
      `CREATE INDEX IF NOT EXISTS idx_telemetry_origin_time ON telemetry_events(origin_id,played_at)`,
      `CREATE TABLE IF NOT EXISTS telemetry_peer_cursors (
        url TEXT PRIMARY KEY, node_id TEXT NOT NULL DEFAULT '', cursor INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '')`,
      `CREATE TABLE IF NOT EXISTS telemetry_summary_cache (
        key TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    ];
    for(const sql of statements) await db.prepare(sql).run();
    await db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('telemetry_instance_id',?)")
      .bind(crypto.randomUUID()).run();
    // Existing Recently Listened history is partial: label it explicitly in the UI.
    // Preserve existing event UUIDs so a repeated first-load migration cannot double count.
    const instance=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
    await db.prepare(`INSERT OR IGNORE INTO telemetry_events
      (origin_id,event_id,played_at,track_id,title,artist,album,duration)
      SELECT ?,id,played_at,track_id,title,artist,album,0 FROM recent_listens
      WHERE played_at>0 AND title<>'' ORDER BY played_at DESC LIMIT 1000`).bind(instance).run();
    await db.prepare("INSERT INTO settings(key,value) VALUES('wasp_telemetry_schema','17.1') ON CONFLICT(key) DO UPDATE SET value='17.1'").run();
  })().catch(e => {schemaPromises.delete(env.DB); throw e;});
  schemaPromises.set(env.DB,task);
  return task;
}

export async function recordTelemetryListen(env, event) {
  await ensureTelemetrySchema(env);
  const originId=(await env.DB.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
  if(!originId) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO telemetry_events
    (origin_id,event_id,played_at,track_id,title,artist,album,duration) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(originId,text(event.id || crypto.randomUUID(),80),Number(event.played_at)||Date.now(),
      text(event.track_id,160),text(event.title),text(event.artist),text(event.album),
      Math.max(0,Math.min(86400,Number(event.duration)||0))).run();
}

function readDateWindow(params) {
  const now=new Date(),year=Number(params.get('year') ?? now.getUTCFullYear());
  if(!Number.isInteger(year)||year<2000||year>2100)throw Error('Invalid year');
  const monthRaw=params.get('month')||'all';
  const month=monthRaw==='all'?0:Number(monthRaw);
  if(!Number.isInteger(month)||month<0||month>12)throw Error('Invalid month');
  const mode=params.get('period')||'year';
  if(!['year','month','week','all'].includes(mode))throw Error('Invalid period');
  const offset=Math.max(-720,Math.min(840,Math.trunc(Number(params.get('offset'))||0)));
  const offsetMs=offset*MINUTE;
  let start,end;
  if(mode==='all') {start=Date.UTC(2000,0,1);end=Date.now()+86400000;}
  else if(mode==='week') {
    const input=params.get('start');
    const ref=input && /^\d{4}-\d{2}-\d{2}$/.test(input)?new Date(input+'T00:00:00Z'):now;
    if(!Number.isFinite(ref.getTime()))throw Error('Invalid week');
    const day=(ref.getUTCDay()+6)%7;
    start=Date.UTC(ref.getUTCFullYear(),ref.getUTCMonth(),ref.getUTCDate()-day)-offsetMs;
    end=start+7*86400000;
  } else if(mode==='month'||month) {
    if(!month)throw Error('Choose a month');
    start=Date.UTC(year,month-1,1)-offsetMs;
    end=Date.UTC(year,month,1)-offsetMs;
  } else {start=Date.UTC(year,0,1)-offsetMs;end=Date.UTC(year+1,0,1)-offsetMs;}
  const span=end-start;
  return {year,month,mode,offset,offsetMs,start,end,span};
}

function scopeSql(scope,localId){
  if(scope==='local')return {where:' AND origin_id=?',extra:[localId]};
  if(scope!=='hive')throw Error('Invalid scope');
  return {where:'',extra:[]};
}

export async function telemetrySummary(env,url) {
  await ensureTelemetrySchema(env);
  const db=env.DB;
  const d=readDateWindow(url.searchParams),scope=url.searchParams.get('scope')||'hive';
  const local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value||'';
  const f=scopeSql(scope,local);
  const key=`v17:${scope}:${d.start}:${d.end}:${d.offset}`;
  const cached=await db.prepare('SELECT body FROM telemetry_summary_cache WHERE key=? AND expires_at>?').bind(key,Date.now()).first();
  if(cached?.body) {try {return JSON.parse(cached.body);} catch { /* rebuild */ }}
  const clause=`played_at>=? AND played_at<?${f.where}`;
  const bind=[d.start,d.end,...f.extra];
  const q=(sql,values=bind)=>db.prepare(sql).bind(...values).all().then(toRows);
  const totalRow=await db.prepare(`SELECT COUNT(*) AS plays,COUNT(DISTINCT NULLIF(artist,'')) AS artists,
    COUNT(DISTINCT (LOWER(title)||'~'||LOWER(artist))) AS tracks,
    COUNT(DISTINCT (LOWER(album)||'~'||LOWER(artist))) AS albums,
    SUM(CASE WHEN duration>0 THEN duration ELSE 0 END) AS indexed_duration
    FROM telemetry_events WHERE ${clause}`).bind(...bind).first();
  const topArtists=await q(`SELECT artist AS name,COUNT(*) AS plays FROM telemetry_events WHERE ${clause} AND artist<>''
    GROUP BY LOWER(artist) ORDER BY plays DESC,name LIMIT 10`);
  const topAlbums=await q(`SELECT album AS name,artist,COUNT(*) AS plays FROM telemetry_events WHERE ${clause} AND album<>''
    GROUP BY LOWER(album),LOWER(artist) ORDER BY plays DESC,name LIMIT 10`);
  const topTracks=await q(`SELECT title AS name,artist,album,COUNT(*) AS plays FROM telemetry_events WHERE ${clause}
    AND title<>'' GROUP BY LOWER(title),LOWER(artist) ORDER BY plays DESC,name LIMIT 10`);
  const shifted='(played_at + '+d.offsetMs+')';
  const unit=d.mode==='week'||d.mode==='month'||d.month?'%Y-%m-%d':'%Y-%m';
  const series=await q(`SELECT strftime('${unit}',${shifted}/1000,'unixepoch') AS label,COUNT(*) AS plays
    FROM telemetry_events WHERE ${clause} GROUP BY label ORDER BY label`);
  const weekdays=await q(`SELECT CAST(strftime('%w',${shifted}/1000,'unixepoch') AS INTEGER) AS weekday,
    COUNT(*) AS plays FROM telemetry_events WHERE ${clause} GROUP BY weekday ORDER BY weekday`);
  const hours=await q(`SELECT CAST(strftime('%H',${shifted}/1000,'unixepoch') AS INTEGER) AS hour,
    COUNT(*) AS plays FROM telemetry_events WHERE ${clause} GROUP BY hour ORDER BY hour`);
  const daily=await q(`SELECT strftime('%Y-%m-%d',${shifted}/1000,'unixepoch') AS day,
    COUNT(*) AS plays FROM telemetry_events WHERE ${clause} GROUP BY day ORDER BY day`);
  let streak=0,longestStreak=0,priorDay=null;
  for(const drow of daily){
    const utc=Date.parse(drow.day+'T00:00:00Z');
    streak=Number.isFinite(priorDay)&&utc-priorDay===86400000?streak+1:1;
    longestStreak=Math.max(longestStreak,streak);priorDay=utc;
  }
  const mostActive= daily.reduce((a,b)=>Number(b.plays)>Number(a?.plays||0)?b:a,null);
  const busiestHour=hours.reduce((a,b)=>Number(b.plays)>Number(a?.plays||0)?b:a,null);
  const previousStart=d.start-d.span;
  const previous=await db.prepare(`SELECT COUNT(*) AS plays FROM telemetry_events
    WHERE played_at>=? AND played_at<?${f.where}`).bind(previousStart,d.start,...f.extra).first();
  const sourceRow=await db.prepare(`SELECT COUNT(DISTINCT origin_id) AS nodes FROM telemetry_events WHERE ${clause}`).bind(...bind).first();
  const checked=await db.prepare('SELECT MAX(synced_at) AS updated,COUNT(*) AS peers FROM telemetry_peer_cursors WHERE synced_at>0').first();
  const output={period:d.mode,year:d.year,month:d.month,start:d.start,end:d.end,scope,
    plays:Number(totalRow?.plays||0),previousPlays:Number(previous?.plays||0),
    artists:Number(totalRow?.artists||0),tracks:Number(totalRow?.tracks||0),albums:Number(totalRow?.albums||0),
    // Catalogued song duration is not playback duration. Do not claim listening hours.
    indexedDuration:Number(totalRow?.indexed_duration||0),
    topArtists,topAlbums,topTracks,series,weekdays,hours,
    activeDays:daily.length,longestStreak,mostActiveDay:mostActive?.day||null,
    mostActiveDayPlays:Number(mostActive?.plays||0),busiestHour:busiestHour?Number(busiestHour.hour):null,
    busiestHourPlays:Number(busiestHour?.plays||0),
    repeatRate:Number(totalRow?.plays)>0?Math.max(0,1-Number(totalRow.tracks||0)/Number(totalRow.plays)):0,
    concentration:Number(totalRow?.plays)>0?Number(topArtists?.[0]?.plays||0)/Number(totalRow.plays):0,
    consistency:d.span>0?daily.length/Math.max(1,Math.floor(d.span/86400000)):0,
    nodes:Number(sourceRow?.nodes||0),
    connectedCaches:Number(checked?.peers||0),lastSynced:Number(checked?.updated||0),
    historicalCoverage:'Available from v17 confirmed plays and retained recent history; older years may be incomplete.',
    generatedAt:Date.now()};
  await db.prepare(`INSERT INTO telemetry_summary_cache(key,body,expires_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at`)
    .bind(key,JSON.stringify(output),Date.now()+FRESH_MS).run();
  // Cache is bounded and cleaned occasionally, never on playback.
  if(Math.random()<0.03)await db.prepare('DELETE FROM telemetry_summary_cache WHERE expires_at<?').bind(Date.now()-86400000).run();
  return output;
}

export async function telemetryFeed(env,url) {
  await ensureTelemetrySchema(env);
  const share=(await env.DB.prepare("SELECT value FROM settings WHERE key='network_share'").first())?.value==='1';
  if(!share)return result({error:'Telemetry not shared by this server'},403);
  const cursor=Number(url.searchParams.get('cursor')||0);
  if(!Number.isSafeInteger(cursor)||cursor<0)return result({error:'Invalid cursor'},400);
  const max=Math.max(1,Math.min(MAX_BATCH,Number(url.searchParams.get('limit'))||MAX_BATCH));
  const rows=toRows(await env.DB.prepare(`SELECT seq,origin_id,event_id,played_at,track_id,title,artist,album,duration
    FROM telemetry_events WHERE seq>? ORDER BY seq LIMIT ?`).bind(cursor,max).all());
  const instance=(await env.DB.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
  const next=rows.length?Number(rows.at(-1).seq):cursor;
  // Only coarse five-minute buckets leave the server; no exact playback timestamps.
  const shared=rows.map(row=>({...row,played_at:Math.floor(Number(row.played_at)/300000)*300000,track_id:''}));
  return result({ok:true,protocol:1,nodeId:instance,cursor:next,events:shared});
}

function validateEvent(row) {
  if(!row||typeof row!=='object'||!/^[-a-f0-9]{10,90}$/i.test(String(row.origin_id||'')) ||
     !/^[\w:-]{10,90}$/.test(String(row.event_id||'')))return null;
  const when=Number(row.played_at);
  if(!Number.isSafeInteger(when)||when<Date.UTC(2000,0,1)||when>Date.now()+5*MINUTE)return null;
  return [text(row.origin_id,90),text(row.event_id,90),when,text(row.track_id,160),
    text(row.title),text(row.artist),text(row.album),Math.max(0,Math.min(86400,Number(row.duration)||0))];
}

export async function syncTelemetryPeers(env,{fetcher=fetch,force=false}={}) {
  await ensureTelemetrySchema(env);
  const db=env.DB, now=Date.now();
  // Lease prevents concurrent scheduled workers and dashboard sync requests from
  // multiplying D1 writes and upstream HTTP requests.
  if(!force){
    const claim=await db.prepare(`INSERT INTO settings(key,value) VALUES('telemetry_next_sync',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<?`)
      .bind(String(now+FRESH_MS),now).run();
    if(!changes(claim))return {skipped:true};
  }
  const local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
  const admin=toRows(await db.prepare('SELECT url FROM peers ORDER BY added_at LIMIT 60').all()).map(x=>x.url);
  const published=toRows(await db.prepare(`SELECT l.url FROM user_published_peers l
    LEFT JOIN user_peer_permissions p ON p.user_id=l.user_id
    WHERE COALESCE(p.enabled,(SELECT CAST(value AS INTEGER) FROM settings WHERE key='user_publish_default'),0)=1
    AND l.last_ok IS NOT NULL AND l.last_error IS NULL ORDER BY l.created_at LIMIT 60`).all()).map(x=>x.url);
  const available=[...new Set([...admin,...published])].filter(Boolean);
  // Every eligible peer gets a turn, even when the HIVE has more peers than
  // can safely be polled in one Worker invocation. Never starve later peers.
  const saved=await db.prepare("SELECT value FROM settings WHERE key='telemetry_sync_offset'").first();
  const start=available.length?(Math.max(0,Number(saved?.value)||0)%available.length):0;
  const count=Math.min(10,available.length);
  const peers=Array.from({length:count},(_,i)=>available[(start+i)%available.length]);
  if(available.length)await db.prepare("INSERT INTO settings(key,value) VALUES('telemetry_sync_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(String((start+count)%available.length)).run();
  let imported=0,checked=0,errors=0;
  for(const url of peers) {
    try {
      const base=new URL(url);
      if(!['https:','http:'].includes(base.protocol)||base.username||base.password)continue;
      const ping=await fetcher(new URL('/api/peer',base),{signal:AbortSignal.timeout(5000),redirect:'error'});
      if(!ping.ok||!(await ping.json())?.ok)continue;
      const state=await db.prepare('SELECT node_id,cursor FROM telemetry_peer_cursors WHERE url=?').bind(url).first();
      const cursor=Number(state?.cursor)||0;
      const feedUrl=new URL('/api/telemetry/feed',base);
      feedUrl.searchParams.set('cursor',String(cursor));feedUrl.searchParams.set('limit',String(MAX_BATCH));
      const response=await fetcher(feedUrl,{signal:AbortSignal.timeout(9000),redirect:'error'});
      if(response.status===404||response.status===403)continue; // Older/non-sharing peers are optional.
      if(!response.ok)throw Error('Upstream HTTP '+response.status);
      const j=await response.json();
      if(!j.ok||j.protocol!==1||!/^[-a-f0-9]{10,90}$/i.test(String(j.nodeId||''))||!Array.isArray(j.events)||j.events.length>MAX_BATCH)
        throw Error('Incompatible telemetry feed');
      if(j.nodeId===local)continue; // Never import our own replicated rows from a peer.
      if(state?.node_id&&state.node_id!==j.nodeId){
        // Peer reset or database restoration: next cycle starts from cursor 0.
        await db.prepare('UPDATE telemetry_peer_cursors SET node_id=?,cursor=0,synced_at=?,last_error=? WHERE url=?')
          .bind(j.nodeId,now,'Peer identity changed; restarting cursor',url).run();
        continue;
      }
      const rows=j.events.map(validateEvent);
      if(rows.some(r=>!r))throw Error('Invalid telemetry event');
      const next=Number(j.cursor);
      if(!Number.isSafeInteger(next)||next<cursor|| (rows.length&&next<=cursor))throw Error('Invalid telemetry cursor');
      // A batch applies atomically with its cursor: no event can be lost between the two.
      const inserts=rows.map(v=>db.prepare(`INSERT OR IGNORE INTO telemetry_events
        (origin_id,event_id,played_at,track_id,title,artist,album,duration) VALUES(?,?,?,?,?,?,?,?)`).bind(...v));
      inserts.push(db.prepare(`INSERT INTO telemetry_peer_cursors(url,node_id,cursor,synced_at,last_error) VALUES(?,?,?,?, '')
        ON CONFLICT(url) DO UPDATE SET node_id=excluded.node_id,cursor=excluded.cursor,
          synced_at=excluded.synced_at,last_error=''`).bind(url,j.nodeId,next,now));
      const outcomes=await db.batch(inserts);
      imported+=outcomes.slice(0,-1).reduce((n,x)=>n+changes(x),0);
      checked++;
    } catch(e) {
      errors++;
      await db.prepare(`INSERT INTO telemetry_peer_cursors(url,node_id,cursor,synced_at,last_error)
        VALUES(?,'',0,0,?) ON CONFLICT(url) DO UPDATE SET last_error=excluded.last_error`)
        .bind(url,text(e.message,120)).run().catch(()=>{});
    }
  }
  return {checked,imported,errors,totalPeers:available.length};
}

export async function telemetryApi(req,env,url,{admin=false}={}) {
  if(req.method!=='GET'&&url.pathname!=='/api/admin/telemetry/sync')return result({error:'Method not allowed'},405);
  if(url.pathname==='/api/telemetry/feed')return telemetryFeed(env,url);
  if(url.pathname==='/api/telemetry') {
    try{return result(await telemetrySummary(env,url));}
    catch(e){return result({error:text(e.message)},400);}
  }
  if(url.pathname==='/api/admin/telemetry/sync') {
    if(!admin)return result({error:'Administrator required'},403);
    if(req.method!=='POST')return result({error:'Method not allowed'},405);
    return result(await syncTelemetryPeers(env,{force:true}));
  }
  return result({error:'Not found'},404);
}
