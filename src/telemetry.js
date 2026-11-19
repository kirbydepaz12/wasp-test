// WASP v17 HIVE telemetry: independent, anonymous confirmed-play ledger.
// No user IDs, visitor IDs, addresses, tokens, or session IDs are transmitted.
// Source identity is preserved through intermediate peers to prevent re-counting loops.
import {ensureMetadataSchema} from './hive-metadata.js';
import {requireNoRedirect} from './peer-fetch.js';
const MINUTE = 60_000;
const MAX_BATCH = 200;
const FRESH_MS = 5 * MINUTE;
const schemaPromises = new WeakSet();
const text = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const result = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: {'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}
});
const changes = x => Number(x?.meta?.changes ?? x?.changes ?? 0);
const toRows = x => x?.results || [];
const validYear = v => {const m=String(v??'').match(/^(\d{4})(?:[-/].*)?$/);const n=m?Number(m[1]):Number(v);return Number.isInteger(n)&&n>=1850&&n<=new Date().getUTCFullYear()+1?n:0;};
const validCountry = v => /^[A-Z]{3}$/.test(String(v||'').toUpperCase())?String(v).toUpperCase():'';
const normTag = v => text(v,80).toLowerCase().replace(/\s+/g,' ');
export async function rememberTrackMetadata(env,trackId,metadata={}) {
  const releaseYear=validYear(metadata.release_year),genre=normTag(metadata.genre);
  if((!releaseYear&&!genre)||!trackId)return false;
  await ensureTelemetrySchema(env);
  await env.DB.prepare(`INSERT INTO telemetry_track_metadata(track_id,release_year,genre) VALUES(?,?,?)
    ON CONFLICT(track_id) DO UPDATE SET
      release_year=CASE WHEN excluded.release_year>0 THEN excluded.release_year ELSE telemetry_track_metadata.release_year END,
      genre=CASE WHEN excluded.genre<>'' THEN excluded.genre ELSE telemetry_track_metadata.genre END`)
    .bind(text(trackId,160),releaseYear,genre).run();
  return true;
}
export async function rememberTrackYear(env,trackId,year) {
  return rememberTrackMetadata(env,trackId,{release_year:year});
}

export async function ensureTelemetrySchema(env) {
  if(schemaPromises.has(env.DB))return;
  await (async () => {
    const db = env.DB;
    const marker = await db.prepare("SELECT value FROM settings WHERE key='wasp_telemetry_schema'").first();
    if (marker?.value === '17.2') return;
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
      `CREATE TABLE IF NOT EXISTS telemetry_track_metadata (
        track_id TEXT PRIMARY KEY, release_year INTEGER NOT NULL DEFAULT 0, genre TEXT NOT NULL DEFAULT '')`,
      `CREATE TABLE IF NOT EXISTS telemetry_artist_metadata (
        artist_key TEXT PRIMARY KEY, country_code TEXT NOT NULL DEFAULT '')`,
      `CREATE TABLE IF NOT EXISTS telemetry_peer_cursors (
        url TEXT PRIMARY KEY, node_id TEXT NOT NULL DEFAULT '', cursor INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '')`,
      `CREATE TABLE IF NOT EXISTS telemetry_summary_cache (
        key TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    ];
    for(const sql of statements) await db.prepare(sql).run();
    // On existing v17 databases these columns are additive; do not replace or clear the ledger.
    for(const sql of [
      "ALTER TABLE telemetry_events ADD COLUMN genre TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE telemetry_events ADD COLUMN release_year INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE telemetry_events ADD COLUMN country_code TEXT NOT NULL DEFAULT ''"
    ]) try {await db.prepare(sql).run();} catch(e) {
      if(!/duplicate column|already exists/i.test(String(e.message)))throw e;
    }
    await db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('telemetry_instance_id',?)")
      .bind(crypto.randomUUID()).run();
    // Existing Recently Listened history is partial: label it explicitly in the UI.
    // Preserve existing event UUIDs so a repeated first-load migration cannot double count.
    const instance=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
    await db.prepare(`INSERT OR IGNORE INTO telemetry_events
      (origin_id,event_id,played_at,track_id,title,artist,album,duration)
      SELECT ?,id,played_at,track_id,title,artist,album,0 FROM recent_listens
      WHERE played_at>0 AND title<>'' ORDER BY played_at DESC LIMIT 1000`).bind(instance).run();
    await db.prepare("INSERT INTO settings(key,value) VALUES('wasp_telemetry_schema','17.2') ON CONFLICT(key) DO UPDATE SET value='17.2'").run();
  })();
  schemaPromises.add(env.DB);
}

export async function recordTelemetryListen(env, event) {
  await ensureTelemetrySchema(env);
  const originId=(await env.DB.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
  if(!originId) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO telemetry_events
    (origin_id,event_id,played_at,track_id,title,artist,album,duration,genre,release_year,country_code)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(originId,text(event.id || crypto.randomUUID(),80),Number(event.played_at)||Date.now(),
      text(event.track_id,160),text(event.title),text(event.artist),text(event.album),
      Math.max(0,Math.min(86400,Number(event.duration)||0)),text(event.genre,80),
      validYear(event.release_year),validCountry(event.country_code)).run();
}

function readDateWindow(params) {
  const now=new Date(),year=Number(params.get('year') ?? now.getUTCFullYear());
  if(!Number.isInteger(year)||year<2000||year>2100)throw Error('Invalid year');
  const monthRaw=params.get('month')||'all';
  let month=monthRaw==='all'?0:Number(monthRaw);
  if(!Number.isInteger(month)||month<0||month>12)throw Error('Invalid month');
  const mode=params.get('period')||'year';
  if(!['year','month','week','all'].includes(mode))throw Error('Invalid period');
  if(mode==='year'||mode==='all'||mode==='week')month=0;
  const offset=Math.max(-720,Math.min(840,Math.trunc(Number(params.get('offset'))||0)));
  const offsetMs=offset*MINUTE;
  let start,end;
  if(mode==='all') {start=Date.UTC(2000,0,1);end=Math.floor(Date.now()/86400000)*86400000+86400000;}
  else if(mode==='week') {
    const input=params.get('start');
    const ref=input && /^\d{4}-\d{2}-\d{2}$/.test(input)?new Date(input+'T00:00:00Z'):now;
    if(!Number.isFinite(ref.getTime()))throw Error('Invalid week');
    const day=(ref.getUTCDay()+6)%7;
    start=Date.UTC(ref.getUTCFullYear(),ref.getUTCMonth(),ref.getUTCDate()-day)-offsetMs;
    end=start+7*86400000;
  } else if(mode==='month') {
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
  await ensureMetadataSchema(env);
  const db=env.DB;
  const d=readDateWindow(url.searchParams),scope=url.searchParams.get('scope')||'hive';
  const local=(await db.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value||'';
  const f=scopeSql(scope,local);
  const key=`v182:${scope}:${d.start}:${d.end}:${d.offset}`;
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
  const topArtists=await q(`SELECT artist AS name,COUNT(*) AS plays, MIN(origin_id) AS origin_id FROM telemetry_events WHERE ${clause} AND artist<>''
    GROUP BY LOWER(artist) ORDER BY plays DESC,name LIMIT 10`);
  const topAlbums=await q(`SELECT album AS name,artist,COUNT(*) AS plays, MIN(origin_id) AS origin_id FROM telemetry_events WHERE ${clause} AND album<>''
    GROUP BY LOWER(album),LOWER(artist) ORDER BY plays DESC,name LIMIT 10`);
  const topTracks=await q(`SELECT title AS name,artist,album,COUNT(*) AS plays, MIN(origin_id) AS origin_id FROM telemetry_events WHERE ${clause}
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
  // v17.0.1 visual enrichment: aggregate by artist/period before reading JS metadata.
  // These queries reuse the time index and never poll public metadata APIs on dashboard loads.
  const periodUnit=d.mode==='year'&&!d.month?'%Y-%m':'%Y-%m-%d';
  const genreSource=await q(`SELECT LOWER(e.artist) AS artist_key,
    strftime('${periodUnit}',(e.played_at+${d.offsetMs})/1000,'unixepoch') AS bucket,
    COUNT(*) AS plays, COALESCE(NULLIF(verified.value,''),NULLIF(e.genre,''),NULLIF(m.genre,''),'') AS event_genre
    FROM telemetry_events e LEFT JOIN telemetry_track_metadata m ON m.track_id=e.track_id LEFT JOIN hive_metadata verified ON verified.artist=LOWER(TRIM(e.artist)) AND verified.title=LOWER(TRIM(e.title)) AND verified.album=LOWER(TRIM(e.album)) AND verified.field='genre'
    WHERE e.played_at>=? AND e.played_at<?${f.where.replace(/origin_id/g,'e.origin_id')}
      AND e.artist<>'' GROUP BY artist_key,bucket,event_genre ORDER BY plays DESC LIMIT 2400`);
  const artistInfo=await db.prepare("SELECT name, genres FROM artist_info WHERE genres IS NOT NULL AND genres!='[]'").all().then(toRows).catch(()=>[]);
  const knownGenres=new Map();
  for(const row of artistInfo){
    try {const parsed=JSON.parse(row.genres||'[]');if(Array.isArray(parsed))
      knownGenres.set(normTag(row.name),[...new Set(parsed.map(normTag).filter(Boolean))].slice(0,3));}
    catch { /* ignore malformed artist records */ }
  }
  const verifiedArtistGenres=await db.prepare("SELECT artist,value FROM hive_metadata WHERE title='' AND album='' AND field='genre'").all().then(toRows);
  for(const r of verifiedArtistGenres)knownGenres.set(normTag(r.artist),[normTag(r.value)]);
  const tagByMonth=new Map(),tagCounts=new Map();
  for(const row of genreSource){
    const genres=row.event_genre?[normTag(row.event_genre)]:(knownGenres.get(normTag(row.artist_key))||[]);
    for(const genre of genres){
      const plays=Number(row.plays)||0;
      tagCounts.set(genre,(tagCounts.get(genre)||0)+plays);
      let buckets=tagByMonth.get(genre);if(!buckets)tagByMonth.set(genre,buckets=new Map());
      buckets.set(row.bucket,(buckets.get(row.bucket)||0)+plays);
    }
  }
  const topTags=[...tagCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,plays])=>({name,plays,
    periods:[...(tagByMonth.get(name)||new Map())].map(([label,plays])=>({label,plays})).sort((a,b)=>a.label.localeCompare(b.label))}));
  // Release years are taken from explicit event metadata, or known local ID3 tags.
  // No year is inferred from a song name, upload date, or guessed artist era.
  const decades=await q(`SELECT CASE WHEN CAST(COALESCE(CAST(albumYear.value AS INTEGER),CAST(verified.value AS INTEGER),NULLIF(e.release_year,0),m.release_year,0)/10 AS INTEGER)*10<1960 THEN 1950 ELSE CAST(COALESCE(CAST(albumYear.value AS INTEGER),CAST(verified.value AS INTEGER),NULLIF(e.release_year,0),m.release_year,0)/10 AS INTEGER)*10 END AS decade,
       COUNT(*) AS plays,COUNT(DISTINCT LOWER(e.artist)) AS artists,
       COUNT(DISTINCT LOWER(e.album)||'~'||LOWER(e.artist)) AS albums,
       COUNT(DISTINCT LOWER(e.title)||'~'||LOWER(e.artist)) AS tracks
     FROM telemetry_events e LEFT JOIN telemetry_track_metadata m ON e.track_id=m.track_id LEFT JOIN hive_metadata verified ON verified.artist=LOWER(TRIM(e.artist)) AND verified.title=LOWER(TRIM(e.title)) AND verified.album=LOWER(TRIM(e.album)) AND verified.field='release_year' LEFT JOIN hive_metadata albumYear ON albumYear.artist=LOWER(TRIM(e.artist)) AND albumYear.title='' AND albumYear.album=LOWER(TRIM(e.album)) AND albumYear.field='release_year' AND e.album<>''
     WHERE e.played_at>=? AND e.played_at<?${f.where.replace(/origin_id/g,'e.origin_id')}
       AND COALESCE(CAST(albumYear.value AS INTEGER),CAST(verified.value AS INTEGER),NULLIF(e.release_year,0),m.release_year,0)>=1850
     GROUP BY decade ORDER BY decade`);
  const decadesTop=await q(`WITH album_counts AS (SELECT CASE WHEN CAST(COALESCE(CAST(albumYear.value AS INTEGER),CAST(verified.value AS INTEGER),NULLIF(e.release_year,0),m.release_year,0)/10 AS INTEGER)*10<1960 THEN 1950 ELSE CAST(COALESCE(CAST(albumYear.value AS INTEGER),CAST(verified.value AS INTEGER),NULLIF(e.release_year,0),m.release_year,0)/10 AS INTEGER)*10 END AS decade,
    MIN(e.album) AS album,MIN(e.artist) AS artist,MIN(e.origin_id) AS origin_id,COUNT(*) AS plays FROM telemetry_events e
    LEFT JOIN telemetry_track_metadata m ON e.track_id=m.track_id LEFT JOIN hive_metadata verified ON verified.artist=LOWER(TRIM(e.artist)) AND verified.title=LOWER(TRIM(e.title)) AND verified.album=LOWER(TRIM(e.album)) AND verified.field='release_year' LEFT JOIN hive_metadata albumYear ON albumYear.artist=LOWER(TRIM(e.artist)) AND albumYear.title='' AND albumYear.album=LOWER(TRIM(e.album)) AND albumYear.field='release_year' AND e.album<>''
    WHERE e.played_at>=? AND e.played_at<?${f.where.replace(/origin_id/g,'e.origin_id')}
    AND COALESCE(CAST(albumYear.value AS INTEGER),CAST(verified.value AS INTEGER),NULLIF(e.release_year,0),m.release_year,0)>=1850 AND e.album<>''
    GROUP BY decade,LOWER(TRIM(e.album)),LOWER(TRIM(e.artist))), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY decade ORDER BY plays DESC,LOWER(album),LOWER(artist)) AS rn FROM album_counts) SELECT * FROM ranked WHERE rn=1`);
  for(const drow of decades){const best=decadesTop.find(r=>Number(r.decade)===Number(drow.decade));
    drow.topAlbum=best?.album||'';drow.topArtist=best?.artist||'';drow.topAlbumOrigin=best?.origin_id||'';drow.topAlbumPlays=Number(best?.plays||0);}
  // One grouped scan, ranked inside SQLite: each country gets its highest-played
  // artist and that artist's highest-played album for this same scope/date window.
  const countries=await q(`WITH album_counts AS (
    SELECT COALESCE(NULLIF(verified.value,''),NULLIF(e.country_code,''),a.country_code,'') AS code,
      LOWER(TRIM(e.artist)) AS artist_key,LOWER(TRIM(e.album)) AS album_key,
      MIN(e.artist) AS artist,MIN(e.album) AS album,MIN(e.origin_id) AS origin_id,COUNT(*) AS plays
    FROM telemetry_events e LEFT JOIN telemetry_artist_metadata a ON LOWER(e.artist)=a.artist_key LEFT JOIN hive_metadata verified ON verified.artist=LOWER(TRIM(e.artist)) AND verified.title='' AND verified.album='' AND verified.field='country_code'
    WHERE e.played_at>=? AND e.played_at<?${f.where.replace(/origin_id/g,'e.origin_id')}
    GROUP BY code,artist_key,album_key),
    artist_counts AS (SELECT code,artist_key,MIN(artist) AS artist,MIN(origin_id) AS origin_id,SUM(plays) AS plays FROM album_counts GROUP BY code,artist_key),
    totals AS (SELECT code,SUM(plays) AS plays,COUNT(DISTINCT NULLIF(artist_key,'')) AS artists FROM artist_counts GROUP BY code),
    artist_rank AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY code ORDER BY plays DESC,artist_key) AS rn FROM artist_counts WHERE artist_key<>''),
    album_rank AS (SELECT ac.*,ROW_NUMBER() OVER(PARTITION BY ac.code,ac.artist_key ORDER BY ac.plays DESC,ac.album_key) AS rn FROM album_counts ac JOIN artist_rank ar ON ar.code=ac.code AND ar.artist_key=ac.artist_key AND ar.rn=1 WHERE ac.album_key<>'')
    SELECT t.*,ar.artist AS topArtist,ar.plays AS topArtistPlays,ar.origin_id AS topArtistOrigin,
      al.album AS topAlbum,al.plays AS topAlbumPlays,al.origin_id AS topAlbumOrigin FROM totals t
      LEFT JOIN artist_rank ar ON ar.code=t.code AND ar.rn=1 LEFT JOIN album_rank al ON al.code=t.code AND al.rn=1
      ORDER BY t.plays DESC,t.code`);
  const verifiedCountries=countries.filter(r=>/^[A-Z]{3}$/.test(r.code));
  const unknownCountryPlays=countries.filter(r=>!/^[A-Z]{3}$/.test(r.code)).reduce((sum,r)=>sum+Number(r.plays||0),0);
  const yearsKnown=decades.reduce((sum,r)=>sum+Number(r.plays||0),0);
  const topTagKnown=genreSource.filter(r=>knownGenres.has(normTag(r.artist_key))||r.event_genre).reduce((sum,r)=>sum+Number(r.plays||0),0);
  const sourceRow=await db.prepare(`SELECT COUNT(DISTINCT origin_id) AS nodes FROM telemetry_events WHERE ${clause}`).bind(...bind).first();
  const checked=await db.prepare('SELECT MAX(synced_at) AS updated,COUNT(*) AS peers FROM telemetry_peer_cursors WHERE synced_at>0').first();
  const artworkOrigins=await db.prepare('SELECT node_id,url FROM telemetry_peer_cursors WHERE synced_at>0 LIMIT 60').all().then(toRows);
  const output={artworkOrigins,period:d.mode,year:d.year,month:d.month,start:d.start,end:d.end,scope,
    plays:Number(totalRow?.plays||0),previousPlays:Number(previous?.plays||0),
    artists:Number(totalRow?.artists||0),tracks:Number(totalRow?.tracks||0),albums:Number(totalRow?.albums||0),
    // Catalogued song duration is not playback duration. Do not claim listening hours.
    indexedDuration:Number(totalRow?.indexed_duration||0),
    topArtists,topAlbums,topTracks,series,weekdays,hours,
    topTags,taggedPlays:topTagKnown,metadataAttribution:['MusicBrainz','Last.fm','Wikidata'],decades,countries:verifiedCountries,
    yearMetadataPlays:yearsKnown,unknownCountryPlays,
    activeDays:daily.length,longestStreak,mostActiveDay:mostActive?.day||null,
    mostActiveDayPlays:Number(mostActive?.plays||0),busiestHour:busiestHour?Number(busiestHour.hour):null,
    busiestHourPlays:Number(busiestHour?.plays||0),
    repeatRate:Number(totalRow?.plays)>0?Math.max(0,1-Number(totalRow.tracks||0)/Number(totalRow.plays)):0,
    concentration:Number(totalRow?.plays)>0?Number(topArtists?.[0]?.plays||0)/Number(totalRow.plays):0,
    consistency:d.span>0?daily.length/Math.max(1,Math.floor(d.span/86400000)):0,
    nodes:Number(sourceRow?.nodes||0),
    connectedCaches:Number(checked?.peers||0),lastSynced:Number(checked?.updated||0),
    historicalCoverage:'Available from v17 confirmed plays and retained recent history; older years may be incomplete.',
    generatedAt:Date.now(),refreshMs:env.WASP_RUNTIME==='docker'?60000:FRESH_MS};
  await db.prepare(`INSERT INTO telemetry_summary_cache(key,body,expires_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at`)
    .bind(key,JSON.stringify(output),Date.now()+(env.WASP_RUNTIME==='docker'?60000:FRESH_MS)).run();
  // Cache is bounded and cleaned occasionally, never on playback.
  if(Math.random()<0.03)await db.prepare('DELETE FROM telemetry_summary_cache WHERE expires_at<?').bind(Date.now()-86400000).run();
  return output;
}

export async function telemetryFeed(env,url) {
  await ensureTelemetrySchema(env);
  const share=(await env.DB.prepare("SELECT value FROM settings WHERE key='network_share'").first())?.value==='1';
  const pref=await env.DB.prepare("SELECT value FROM settings WHERE key='telemetry_share_enabled'").first();
  if(!share || pref?.value==='0')return result({error:'Telemetry sharing disabled by this server'},403);
  const cursor=Number(url.searchParams.get('cursor')||0);
  if(!Number.isSafeInteger(cursor)||cursor<0)return result({error:'Invalid cursor'},400);
  const max=Math.max(1,Math.min(MAX_BATCH,Number(url.searchParams.get('limit'))||MAX_BATCH));
  const rows=toRows(await env.DB.prepare(`SELECT e.seq,e.origin_id,e.event_id,e.played_at,e.track_id,e.title,e.artist,e.album,e.duration,
      COALESCE(NULLIF(e.genre,''),NULLIF(m.genre,''),CASE WHEN json_valid(ai.genres) THEN json_extract(ai.genres,'$[0]') ELSE NULL END,'') AS genre,
      COALESCE(NULLIF(e.release_year,0),m.release_year,0) AS release_year,
      COALESCE(NULLIF(e.country_code,''),am.country_code,'') AS country_code
    FROM telemetry_events e LEFT JOIN telemetry_track_metadata m ON e.track_id=m.track_id
    LEFT JOIN artist_info ai ON LOWER(ai.name)=LOWER(e.artist)
    LEFT JOIN telemetry_artist_metadata am ON am.artist_key=LOWER(e.artist)
    WHERE e.seq>? ORDER BY e.seq LIMIT ?`).bind(cursor,max).all());
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
    text(row.title),text(row.artist),text(row.album),Math.max(0,Math.min(86400,Number(row.duration)||0)),
    text(row.genre,80),validYear(row.release_year),validCountry(row.country_code)];
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
      const ping=requireNoRedirect(await fetcher(new URL('/api/peer',base),{signal:AbortSignal.timeout(5000),redirect:'manual'}));
      if(!ping.ok||!(await ping.json())?.ok)continue;
      const state=await db.prepare('SELECT node_id,cursor FROM telemetry_peer_cursors WHERE url=?').bind(url).first();
      const cursor=Number(state?.cursor)||0;
      const feedUrl=new URL('/api/telemetry/feed',base);
      feedUrl.searchParams.set('cursor',String(cursor));feedUrl.searchParams.set('limit',String(MAX_BATCH));
      const response=requireNoRedirect(await fetcher(feedUrl,{signal:AbortSignal.timeout(9000),redirect:'manual'}));
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
        (origin_id,event_id,played_at,track_id,title,artist,album,duration,genre,release_year,country_code) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(...v));
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
