// v17.0.5: independent, bounded metadata cache and enrichment. Never sends credentials or listening identities.
import {readUploadedTags,readPeerFileTags,normalizeEmbeddedGenre} from './file-metadata.js';
import {countries} from './country-codes.js';
import {requireNoRedirect} from './peer-fetch.js';
const ready=new WeakSet(), DAY=86400000;
const str=(s,n=200)=>String(s??'').trim().slice(0,n), norm=s=>str(s).toLowerCase(), key=s=>str(s).replace(/[A-Z]/g,c=>c.toLowerCase());
const json=(v,status=200)=>Response.json(v,{status,headers:{'cache-control':'no-store'}});
const rows=r=>r?.results||[];
const changed=r=>Number(r?.meta?.changes||0);
const configDefaults={preferred:'musicbrainz',musicbrainz:true,lastfm:false,fallback:true,enabled:false,minutes:5,trustPeers:false,shareLastfm:false,contact:'',wikidata:true,prioritizePlayed:true,batchSize:1,preferredPeer:'',readPeerTags:false,offlineFallback:true};
export async function ensureMetadataSchema(env){
 if(ready.has(env.DB))return;
 await (async()=>{if(await setting(env.DB,'hive_metadata_schema')==='3')return;for(const sql of [
 `CREATE TABLE IF NOT EXISTS hive_metadata (seq INTEGER PRIMARY KEY AUTOINCREMENT, artist TEXT NOT NULL,title TEXT NOT NULL,album TEXT NOT NULL,field TEXT NOT NULL,value TEXT NOT NULL,provider TEXT NOT NULL,reference TEXT NOT NULL DEFAULT '',verified_at INTEGER NOT NULL,local_verified INTEGER NOT NULL DEFAULT 0, UNIQUE(artist,title,album,field))`,
 `CREATE TABLE IF NOT EXISTS hive_metadata_jobs (artist TEXT NOT NULL,title TEXT NOT NULL,album TEXT NOT NULL,next_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(artist,title,album))`,
 `CREATE INDEX IF NOT EXISTS idx_hive_metadata_due ON hive_metadata_jobs(next_at)`,
 `CREATE TABLE IF NOT EXISTS hive_metadata_cursors(url TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0,node_id TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '')`,
 `CREATE INDEX IF NOT EXISTS idx_hive_metadata_file_album ON hive_metadata(artist,album,value) WHERE provider='embedded' AND field='release_year' AND title<>''`,
 `CREATE TABLE IF NOT EXISTS hive_file_album_years(artist TEXT NOT NULL,album TEXT NOT NULL,year INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(artist,album))`,
 `CREATE TABLE IF NOT EXISTS hive_file_metadata_retry(track_id TEXT PRIMARY KEY,next_at INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS hive_peer_tag_attempts(artist TEXT NOT NULL,title TEXT NOT NULL,album TEXT NOT NULL,next_at INTEGER NOT NULL,PRIMARY KEY(artist,title,album))`
 ])await env.DB.prepare(sql).run();try{await env.DB.prepare('ALTER TABLE hive_metadata_jobs ADD COLUMN play_priority INTEGER NOT NULL DEFAULT 0').run();}catch(e){if(!/duplicate column|already exists/i.test(String(e.message)))throw e;}await set(env.DB,'hive_metadata_schema','3');})();ready.add(env.DB);
}
async function setting(db,key){return (await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value;}
async function set(db,key,value){await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,String(value)).run();}
export const isDockerMetadata=env=>env.WASP_RUNTIME==='docker';
export async function metadataConfig(env){let saved={};try{saved=JSON.parse(await setting(env.DB,'hive_metadata_config')||'{}')}catch{}return {...configDefaults,...saved};}
// Preserve access to credentials encrypted with a previous installation fallback.
// A newly configured dedicated key is used for subsequent saves only.
const keyMaterials=env=>[...new Set([env.METADATA_SETTINGS_KEY,env.SPOTIFY_SETTINGS_KEY,env.SCANNER_SECRET].map(x=>String(x||'')).filter(x=>x.length>=24))];
const keyMaterial=env=>keyMaterials(env)[0]||'';
async function cipherKey(material){if(!material)throw Error('Configure METADATA_SETTINGS_KEY (at least 24 characters).');return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode('WASP metadata v1\0'+material)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
const b64=a=>btoa(String.fromCharCode(...new Uint8Array(a))),un64=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));
async function credentials(env){const stored=await setting(env.DB,'hive_lastfm_encrypted');if(!stored)return {apiKey:str(env.LASTFM_API_KEY),secret:str(env.LASTFM_SHARED_SECRET),source:env.LASTFM_API_KEY?'runtime':'none'};const [iv,body]=stored.split(':');for(const material of keyMaterials(env)){try{const value=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(iv)},await cipherKey(material),un64(body))));return {...value,source:'saved',legacyKey:material!==keyMaterial(env)};}catch{}}throw Error('Saved Last.fm credentials cannot be decrypted. Restore the previous installation key or replace the saved credentials explicitly.');}
async function encryptCredentials(env,key,secret){const iv=crypto.getRandomValues(new Uint8Array(12)),body=await crypto.subtle.encrypt({name:'AES-GCM',iv},await cipherKey(keyMaterial(env)),new TextEncoder().encode(JSON.stringify({apiKey:key,secret})));return b64(iv)+':'+b64(body);}
async function credentialState(env){let cred={},credentialError='';try{cred=await credentials(env)}catch(e){credentialError=e.message;}return {apiKeyConfigured:!!cred.apiKey,secretConfigured:!!cred.secret,credentialSource:cred.source||'none',credentialError,legacyKey:!!cred.legacyKey,encryptionReady:!!keyMaterial(env)};}
const validContact=s=>/^(?:[^\s@]+@[^\s@]+\.[^\s@]+|https?:\/\/[^\s]+)$/.test(s);
function validField(field,value){if(field==='release_year'){const y=Number(value);return Number.isInteger(y)&&y>=1850&&y<=new Date().getUTCFullYear()+1?String(y):'';}if(field==='country_code')return Object.values(countries).includes(String(value))?String(value):'';return field==='genre'?str(value,80).toLowerCase():'';}
function factual(entry){return (['musicbrainz','wikidata'].includes(entry.provider) && ['release_year','country_code'].includes(entry.field))||(entry.provider==='embedded'&&!!entry.title&&['release_year','genre'].includes(entry.field));}
const isMbid=s=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(s));
function cleanReference(provider,ref){if(provider==='embedded')return ref==='audio-tag'?ref:'';if(typeof ref!=='string'||ref.length>500)return '';try{const u=new URL(ref);if(provider==='lastfm'&&u.protocol==='http:'&&u.hostname==='www.last.fm')u.protocol='https:';if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return '';if(provider==='lastfm'&&u.hostname==='www.last.fm'&&u.pathname.startsWith('/music/'))return u.href;if(provider==='musicbrainz'&&u.hostname==='musicbrainz.org'&&/^\/(recording|artist|release-group)\/[a-f0-9-]+$/i.test(u.pathname))return u.href;if(provider==='wikidata'&&u.hostname==='www.wikidata.org'&&/^\/wiki\/Q[1-9][0-9]*$/.test(u.pathname))return u.href;}catch{}return '';}
function albumConsensus(db,artist,album){return db.prepare(`INSERT INTO hive_file_album_years(artist,album,year) SELECT ?,?,CASE WHEN COUNT(DISTINCT value)=1 THEN CAST(MIN(value) AS INTEGER) ELSE 0 END FROM hive_metadata WHERE provider='embedded' AND field='release_year' AND title<>'' AND artist=? AND album=? ON CONFLICT(artist,album) DO UPDATE SET year=excluded.year`).bind(artist,album,artist,album);}
async function persistFact(db,statement,entry,artist,album){const derived=entry.field==='release_year'&&!!entry.title&&album&&album!=='unknown album';if(!derived)return changed(await statement.run());const r=await db.batch([statement,albumConsensus(db,artist,album)]);return changed(r[0]);}
async function store(env,entry,local,config){const value=validField(entry.field,entry.value),reference=cleanReference(entry.provider,entry.reference);if(!value||!reference||!['lastfm','musicbrainz','wikidata','embedded'].includes(entry.provider)||(entry.provider==='lastfm'&&entry.field!=='genre'))return 0;
 const artist=key(entry.artist),title=entry.field==='country_code'?'':key(entry.title),album=entry.field==='country_code'?'':key(entry.album);if(!artist||(!title&&!album&&entry.field==='release_year'))return 0;
 if(!local&&entry.provider!=='lastfm'){const r=env.DB.prepare('INSERT OR IGNORE INTO hive_metadata(artist,title,album,field,value,provider,reference,verified_at,local_verified) VALUES(?,?,?,?,?,?,?,?,0)').bind(artist,title,album,entry.field,value,entry.provider,reference,Date.now());return persistFact(env.DB,r,entry,artist,album);}
 const prior=await env.DB.prepare('SELECT * FROM hive_metadata WHERE artist=? AND title=? AND album=? AND field=?').bind(artist,title,album,entry.field).first();
 if(prior&&(!local||(entry.provider==='embedded'&&(prior.provider!=='embedded'||prior.value!==value||prior.local_verified))||prior.provider===config.preferred&&entry.provider!==config.preferred||prior.value===value&&prior.provider===entry.provider&&prior.local_verified&&local))return 0;
 // REPLACE assigns a new sequence only when a field is newly verified/changed. No event rows are changed.
 if(entry.provider==='lastfm'&&prior?.provider!=='lastfm'){const used=Number(await setting(env.DB,'hive_lastfm_fields_budget'))||0;if(used>=10000)return 0;await set(env.DB,'hive_lastfm_fields_budget',used+1);}
 const r=env.DB.prepare('INSERT OR REPLACE INTO hive_metadata(artist,title,album,field,value,provider,reference,verified_at,local_verified) VALUES(?,?,?,?,?,?,?,?,?)').bind(artist,title,album,entry.field,value,entry.provider,reference,Date.now(),local?1:0);return persistFact(env.DB,r,entry,artist,album);
}
const lucene=s=>'"'+str(s).replace(/[\\"]/g,'\\$&')+'"';
async function getJSON(fetcher,url,headers={}){let res;try{res=requireNoRedirect(await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{accept:'application/json',...headers}}));}catch{throw Error('Metadata provider connection failed');}if(!res.ok){const e=Error('Metadata provider HTTP '+res.status+(res.status===429?' (rate limited)':''));if(res.status===429||res.status===503){const raw=res.headers.get('retry-after'),seconds=Number(raw);e.retryAt=Date.now()+Math.max(60000,raw&&Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(raw||'')-Date.now())||0);}throw e;}let d;try{d=await res.json();}catch{throw Error('Metadata provider returned a non-JSON response (HTTP '+res.status+')');}if(!d||typeof d!=='object')throw Error('Invalid metadata provider response');if(d.error){const code=Number(d.error);throw Error('Metadata provider error'+(Number.isFinite(code)?' '+code:'')+(code===10?' (invalid API key)':code===29?' (rate limited)':''));}return d;}
const tag=x=>str((x||[]).find(t=>t?.name)?.name,80);
const credit=r=>norm((r['artist-credit']||[]).map(c=>(c.name||c.artist?.name||'')+(c.joinphrase||'')).join(''));
export async function lookupMusicbrainz(job,{fetcher=fetch,contact=''}={}){
 if(!contact)throw Error('Set MusicBrainz contact email or URL first.');
 const album=!job.title&&!!job.album,artist=!job.title&&!album,kind=album?'release-group':artist?'artist':'recording';const url=new URL('https://musicbrainz.org/ws/2/'+kind+'/');
 url.searchParams.set('query',album?'releasegroup:'+lucene(job.album)+' AND artist:'+lucene(job.artist):artist?'artist:'+lucene(job.artist):'recording:'+lucene(job.title)+' AND artist:'+lucene(job.artist)+(job.album?' AND release:'+lucene(job.album):''));url.searchParams.set('fmt','json');url.searchParams.set('limit','10');
 const data=await getJSON(fetcher,url,{'User-Agent':`WASP/18.0.4 (${contact})`});
 const matches=(data[album?'release-groups':artist?'artists':'recordings']||[]).filter(r=>isMbid(r.id)&&Number(r.score)>=(album?85:artist?85:95)&&(artist?norm(r.name)===norm(job.artist):norm(r.title)===norm(album?job.album:job.title)&&credit(r)===norm(job.artist)&&(album||!job.album||(r.releases||[]).some(x=>norm(x.title)===norm(job.album)))));
 // Exact identity required; do not pick a same-name artist/album merely by popularity.
 if(matches.length!==1)return [];const hit=matches[0],reference=`https://musicbrainz.org/${kind}/${hit.id}`,out=[];
 if(artist){const code=hit['begin-area']?.['iso-3166-1-codes']?.[0]||hit.country||hit.area?.['iso-3166-1-codes']?.[0];if(countries[code])out.push({field:'country_code',value:countries[code]});}
 else {const year=String(hit['first-release-date']||'').match(/^\d{4}/)?.[0];if(year)out.push({field:'release_year',value:year});}
 const genre=tag(hit.tags||hit.genres);if(genre)out.push({field:'genre',value:genre});return out.map(x=>({...job,...x,provider:'musicbrainz',reference}));
}
// Factual, exact-label fallback. Require one entity and one country or year;
// never infer geography from a release market, nationality alone or a listener location.
export async function lookupWikidata(job,{fetcher=fetch,contact=''}={}){
 if(!validContact(contact))throw Error('Set a valid metadata contact for Wikidata.');
 const album=!job.title&&!!job.album;if(job.title)return [];
 const headers={'User-Agent':`WASP/18.0.4 (${contact})`};
 // Jobs use normalized lowercase keys. Resolve candidate IDs using the search API,
 // then constrain the structured query to those IDs rather than scanning all labels.
 const search=new URL('https://www.wikidata.org/w/api.php');search.search=new URLSearchParams({action:'wbsearchentities',search:album?job.album:job.artist,language:'en',type:'item',limit:'10',format:'json'});
 const found=await getJSON(fetcher,search,headers);const candidates=[...new Set((found.search||[]).filter(x=>norm(x.label)===norm(album?job.album:job.artist)&&/^Q[1-9][0-9]*$/.test(x.id)).map(x=>x.id))];if(!candidates.length||candidates.length>=10)return [];
 const values=`VALUES ?item { ${candidates.map(id=>'wd:'+id).join(' ')} }`;
 const query=album?`SELECT DISTINCT ?item ?year WHERE { ${values} ?item wdt:P31/wdt:P279* wd:Q482994; wdt:P175 ?artist; wdt:P577 ?date. ?artist rdfs:label ?name. FILTER(LANG(?name)="en" && LCASE(STR(?name))=${JSON.stringify(norm(job.artist))}) BIND(YEAR(?date) AS ?year) } LIMIT 12`:
 `SELECT DISTINCT ?item ?code WHERE { ${values} { ?item wdt:P31/wdt:P279* wd:Q215380; wdt:P495 ?country. } UNION { ?item wdt:P31/wdt:P279* wd:Q215380; wdt:P740/wdt:P17 ?country. } UNION { ?item wdt:P31 wd:Q5; wdt:P106/wdt:P279* wd:Q639669; wdt:P19/wdt:P17 ?country. } ?country wdt:P297 ?code. } LIMIT 12`;
 const url=new URL('https://query.wikidata.org/sparql');url.searchParams.set('query',query);url.searchParams.set('format','json');
 const d=await getJSON(fetcher,url,{...headers,accept:'application/sparql-results+json'});const hits=d.results?.bindings||[];
 const ids=new Set(hits.map(x=>x.item?.value?.match(/\/entity\/(Q[1-9][0-9]*)$/)?.[1]));if(ids.size!==1||!candidates.includes([...ids][0])||hits.length>=12)return [];
 const vals=new Set(hits.map(x=>album?validField('release_year',x.year?.value):countries[x.code?.value]).filter(Boolean));if(vals.size!==1)return [];
 return [{...job,field:album?'release_year':'country_code',value:[...vals][0],provider:'wikidata',reference:'https://www.wikidata.org/wiki/'+[...ids][0]}];
}
export async function lookupLastfm(job,{fetcher=fetch,apiKey}={}){
 if(!apiKey)throw Error('Last.fm API key not configured');const album=!job.title&&!!job.album,artist=!job.title&&!album,url=new URL('https://ws.audioscrobbler.com/2.0/');if(album)return [];url.search=new URLSearchParams({method:artist?'artist.getInfo':'track.getInfo',api_key:apiKey,artist:job.artist,...(!artist?{track:job.title}:{}),format:'json',autocorrect:'0'});
 const d=await getJSON(fetcher,url),hit=artist?d.artist:d.track;if(!hit||norm(artist?hit.name:hit.artist?.name)!==norm(job.artist)||(!artist&&(norm(hit.name)!==norm(job.title)||(job.album&&norm(hit.album?.title)!==norm(job.album)))))return [];
 const genre=tag((artist?hit.tags:hit.toptags)?.tag);return genre?[{...job,field:'genre',value:genre,provider:'lastfm',reference:hit.url}]:[];
}
// Separate cursor feed avoids replaying listening events. Only locally verified factual fields,
// plus Last.fm fields when explicit redistribution permission was enabled, are exposed.
export async function metadataFeed(env,url){await ensureMetadataSchema(env);const c=await metadataConfig(env);if(await setting(env.DB,'network_share')!=='1'||await setting(env.DB,'telemetry_share_enabled')==='0')return json({error:'Sharing disabled'},403);
 const cursor=Number(url.searchParams.get('cursor')||0);if(!Number.isSafeInteger(cursor)||cursor<0)return json({error:'Invalid cursor'},400);
 const limit=Math.max(1,Math.min(20,Number(url.searchParams.get('limit'))||20));const result=rows(await env.DB.prepare(`SELECT seq,artist,title,album,field,value,provider,reference,verified_at FROM hive_metadata WHERE seq>? AND local_verified=1 AND ((provider IN ('musicbrainz','wikidata') AND field IN ('release_year','country_code')) OR (provider='embedded' AND title<>'' AND field IN ('release_year','genre')) OR (provider='lastfm' AND ?=1)) ORDER BY seq LIMIT ?`).bind(cursor,c.shareLastfm?1:0,Math.floor(limit)).all());return json({ok:true,protocol:1,nodeId:await setting(env.DB,'telemetry_instance_id'),cursor:result.at(-1)?.seq||cursor,entries:result});}
async function pullTrusted(env,c,{fetcher=fetch,pageSize=3}={}){if(!c.trustPeers)return 0;const peers=rows(await env.DB.prepare('SELECT url FROM peers ORDER BY added_at LIMIT 60').all());if(!peers.length)throw Error('No registered admin peers available for metadata.');const i=Number(await setting(env.DB,'hive_metadata_peer_offset'))||0,url=peers.find(p=>p.url===c.preferredPeer)?.url||peers[i%peers.length].url;await set(env.DB,'hive_metadata_peer_offset',(i+1)%peers.length);let count=0;
 try{const base=new URL(url);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)return 0;const prior=await env.DB.prepare('SELECT * FROM hive_metadata_cursors WHERE url=?').bind(url).first(),u=new URL('/api/telemetry/metadata/feed',base);const cursor=Number(prior?.cursor)||0;u.searchParams.set('cursor',String(cursor));u.searchParams.set('limit',String(pageSize));const data=await getJSON(fetcher,u);if(data.protocol!==1||!data.ok||!isMbid(data.nodeId)||!Array.isArray(data.entries)||data.entries.length>20||!Number.isSafeInteger(data.cursor)||data.cursor<cursor||data.entries.some((r,i)=>!Number.isSafeInteger(r.seq)||r.seq<=(i?data.entries[i-1].seq:cursor)||r.seq>data.cursor))throw Error('Invalid peer metadata feed');if(prior?.node_id&&prior.node_id!==data.nodeId){await env.DB.prepare('DELETE FROM hive_metadata_cursors WHERE url=?').bind(url).run();return 0;}
 const page=data.entries.slice(0,pageSize);for(const e of page)if(factual(e)||(c.shareLastfm&&e.provider==='lastfm'))count+=await store(env,e,false,c);
 await env.DB.prepare(`INSERT INTO hive_metadata_cursors(url,cursor,node_id,error) VALUES(?,?,?,'') ON CONFLICT(url) DO UPDATE SET cursor=excluded.cursor,node_id=excluded.node_id,error=''`).bind(url,page.length? page.at(-1).seq:data.cursor,str(data.nodeId,90)).run();
 }catch(e){await env.DB.prepare(`INSERT INTO hive_metadata_cursors(url,error) VALUES(?,?) ON CONFLICT(url) DO UPDATE SET error=excluded.error`).bind(url,str(e.message,120)).run();throw e;}return count;}
// Completed values only; no in-flight promises ever leave their request.
// Exact track facts only in the federated feed; no filenames, paths or listening IDs.
export async function rememberFileFacts(env,track,metadata,{invalidate=true}={}){
 if(!track?.artist||!track?.title||/^unknown (artist|track)$/i.test(track.artist))return 0;
 await ensureMetadataSchema(env);let count=0;const config=await metadataConfig(env);
 for(const field of ['release_year','genre'])if(metadata[field])count+=await store(env,{artist:track.artist,title:track.title,album:track.album,field,value:field==='genre'?normalizeEmbeddedGenre(metadata[field]):metadata[field],provider:'embedded',reference:'audio-tag'},true,config);
 if(count&&invalidate){await env.DB.prepare('DELETE FROM telemetry_summary_cache').run();await env.DB.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'").run();}return count;
}
const FILE_CURSOR='hive_file_metadata_cursor_v183',FILE_PROGRESS='hive_file_metadata_progress_v183';
async function fileProgress(db){try{return JSON.parse(await setting(db,FILE_PROGRESS)||'null')||{processed:0,verified:0,errors:0};}catch{return {processed:0,verified:0,errors:0};}}
// Rowid cursor performs one upgrade pass, not a repeated full-library scan. New
// uploads/folder changes also publish their tags directly at ingestion.
async function fileBatch(env){const db=env.DB,pos=Number(await setting(db,FILE_CURSOR))||0;
 let found=rows(await db.prepare(`SELECT t.rowid AS seq,t.id,t.title,t.artist,t.album,${isDockerMetadata(env)?'t.size':'0 AS size'},m.release_year,m.genre FROM tracks t LEFT JOIN telemetry_track_metadata m ON t.id=m.track_id WHERE t.rowid>? ORDER BY t.rowid LIMIT ${isDockerMetadata(env)?40:3}`).bind(pos).all());
 const retrying=!found.length&&isDockerMetadata(env);if(retrying)found=rows(await db.prepare(`SELECT t.rowid AS seq,t.id,t.title,t.artist,t.album,t.size,m.release_year,m.genre FROM hive_file_metadata_retry r JOIN tracks t ON r.track_id=t.id LEFT JOIN telemetry_track_metadata m ON t.id=m.track_id WHERE r.next_at<=? ORDER BY r.next_at LIMIT 20`).bind(Date.now()).all());
 const progress=await fileProgress(db);let verified=0,errors=0,processed=0,last=pos;const started=Date.now(),force=isDockerMetadata(env)&&await setting(db,'hive_file_force_v183')==='1';
 for(const t of found){if(processed&&Date.now()-started>20000)break;let meta={release_year:t.release_year,genre:t.genre};try{if(isDockerMetadata(env)&&!t.id.startsWith('folder-')&&(force||!meta.release_year||!meta.genre)&&t.size){const tags=await readUploadedTags(env.MUSIC,t.id,t.size);if(tags)meta={release_year:force?(tags.release_year||meta.release_year):(meta.release_year||tags.release_year),genre:force?(tags.genre||meta.genre):(meta.genre||tags.genre)};else throw Error('Audio object not available');}
 verified+=await rememberFileFacts(env,t,meta,{invalidate:false});if(meta.release_year||meta.genre)await db.prepare(`INSERT INTO telemetry_track_metadata(track_id,release_year,genre) VALUES(?,?,?) ON CONFLICT(track_id) DO UPDATE SET release_year=CASE WHEN telemetry_track_metadata.release_year>0 THEN telemetry_track_metadata.release_year ELSE excluded.release_year END,genre=CASE WHEN telemetry_track_metadata.genre<>'' THEN telemetry_track_metadata.genre ELSE excluded.genre END`).bind(t.id,Number(meta.release_year)||0,str(meta.genre,80)).run();if(retrying)await db.prepare('DELETE FROM hive_file_metadata_retry WHERE track_id=?').bind(t.id).run();}
 catch{errors++;if(isDockerMetadata(env))await db.prepare('INSERT INTO hive_file_metadata_retry(track_id,next_at) VALUES(?,?) ON CONFLICT(track_id) DO UPDATE SET next_at=excluded.next_at').bind(t.id,Date.now()+600000).run();}processed++;if(!retrying)last=t.seq;}
 if(verified){await db.prepare('DELETE FROM telemetry_summary_cache').run();await db.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'").run();}
 if(processed&&!retrying)await set(db,FILE_CURSOR,last);if(force&&found.length===0)await set(db,'hive_file_force_v183','0');
 const remaining=Number((await db.prepare('SELECT COUNT(*) n FROM tracks WHERE rowid>?').bind(last).first())?.n)||0;const pendingRetries=isDockerMetadata(env)?Number((await db.prepare('SELECT COUNT(*) n FROM hive_file_metadata_retry r JOIN tracks t ON r.track_id=t.id').first())?.n)||0:0;
 const next={processed:(progress.processed||0)+processed,verified:(progress.verified||0)+verified,errors:(progress.errors||0)+errors,remaining,pendingRetries,state:remaining?'running':'complete'};if(processed||progress.state!==next.state)await set(db,FILE_PROGRESS,JSON.stringify(next));return next;
}
// Optional range inspection for played tracks not covered by cached facts.
// Catalogues and origins are from admin-connected peers only, never user URLs.
async function peerTagBatch(env,c,fetcher){if(!c.trustPeers||!c.readPeerTags)return {checked:0,verified:0};const db=env.DB,now=Date.now();
 const jobs=rows(await db.prepare(`SELECT DISTINCT j.artist,j.title,j.album,j.play_priority FROM hive_metadata_jobs j LEFT JOIN hive_peer_tag_attempts a USING(artist,title,album) LEFT JOIN hive_metadata y ON y.artist=j.artist AND y.title=j.title AND y.album=j.album AND y.field='release_year' LEFT JOIN hive_metadata g ON g.artist=j.artist AND g.title=j.title AND g.album=j.album AND g.field='genre' LEFT JOIN hive_file_album_years f ON f.artist=j.artist AND f.album=j.album AND f.year>0 WHERE j.title<>'' AND (y.value IS NULL OR g.value IS NULL) AND COALESCE(a.next_at,0)<=? ORDER BY j.play_priority DESC,j.artist,j.title LIMIT 20`).bind(now).all());
 if(!jobs.length)return {checked:0,verified:0,pending:false};let checked=0,verified=0,error='';
 for(const job of jobs){error='';
 try{const candidates=rows(await db.prepare(`SELECT p.url,json_extract(t.value,'$.id') AS id FROM peer_catalogue_chunks c JOIN peers p ON p.id=c.peer_id JOIN json_each(c.body) t WHERE c.kind='tracks' AND LOWER(TRIM(json_extract(t.value,'$.artist')))=? AND LOWER(TRIM(json_extract(t.value,'$.title')))=? AND LOWER(TRIM(COALESCE(json_extract(t.value,'$.album'),'')))=? ORDER BY (p.url=?) DESC,p.added_at LIMIT 3`).bind(job.artist,job.title,job.album,c.preferredPeer).all());
 for(const candidate of candidates){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(candidate.id||''))continue;const base=new URL(candidate.url);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)continue;checked++;const tags=await readPeerFileTags(fetcher,new URL('/audio/'+encodeURIComponent(candidate.id),base));verified+=await rememberFileFacts(env,job,tags);if(verified||checked>=1)break;}
 }catch(e){error=str(e.message,120);}
 await db.prepare(`INSERT INTO hive_peer_tag_attempts(artist,title,album,next_at) VALUES(?,?,?,?) ON CONFLICT(artist,title,album) DO UPDATE SET next_at=excluded.next_at`).bind(job.artist,job.title,job.album,now+(error?30*60000:checked?30*DAY:DAY)).run();if(checked||error)break;}return {checked,verified,error,pending:!!checked||!!error||jobs.length===20};
}
const SCAN_KEY='hive_metadata_scan_v182';
async function scanState(db){try{return JSON.parse(await setting(db,SCAN_KEY)||'null')||{state:'idle'};}catch{return {state:'idle'};}}
async function writeScan(db,v){await set(db,SCAN_KEY,JSON.stringify(v));}
export async function metadataScanControl(env,action){
 if(!isDockerMetadata(env))return {error:'Continuous scanning is available on Docker only.'};
 await ensureMetadataSchema(env);const db=env.DB,s=await scanState(db),now=Date.now();
 if(action==='start'){
   if(s.state==='running')return s;
   if(s.state==='paused'){const next={...s,state:'running',updated:now};await writeScan(db,next);return next;}

   const next={state:'running',id:crypto.randomUUID(),started:now,updated:now,processed:0,verified:0,errors:0,discovered:0,phase:'discovering',remaining:0};
   // One explicit rescan retries unresolved factual metadata; matched fields remain intact.
   await db.prepare(`UPDATE hive_metadata_jobs SET next_at=0 WHERE ((title='' AND album='') AND NOT EXISTS(SELECT 1 FROM hive_metadata m WHERE m.artist=hive_metadata_jobs.artist AND m.title='' AND m.album='' AND m.field='country_code')) OR ((title='' AND album<>'') AND NOT EXISTS(SELECT 1 FROM hive_metadata m WHERE m.artist=hive_metadata_jobs.artist AND m.title='' AND m.album=hive_metadata_jobs.album AND m.field='release_year'))`).run();
   await writeScan(db,next);return next;
 }
 if(action==='pause'||action==='stop'){const next={...s,state:action==='pause'?'paused':'stopped',updated:now};await writeScan(db,next);return next;}
 return {error:'Invalid scanner action'};
}
// Docker-only sidecar. The database is never stored in D1 or exposed publicly.
async function offlineCall(env,action,body,fetcher=fetch){
 if(!isDockerMetadata(env)||!env.SCANNER_SECRET)throw Error('Offline metadata is available on Docker only.');
 const r=await fetcher('http://127.0.0.1:8788/_internal/offline-metadata/'+action,{method:body===undefined?'GET':'POST',headers:{'x-scanner-secret':env.SCANNER_SECRET,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(10000)});
 const d=await r.json();if(!r.ok)throw Error(d.error||'Offline metadata gateway unavailable');return d;
}
async function offlineStatus(env,fetcher){if(!isDockerMetadata(env)||!env.SCANNER_SECRET)return null;try{return await offlineCall(env,'status',undefined,fetcher);}catch{return null;}}
const OFFLINE_STATE='hive_offline_progress_v184';
async function offlineProgress(db){try{return JSON.parse(await setting(db,OFFLINE_STATE)||'null')||{};}catch{return {};}}
export async function offlineFactsBatch(env,c,status,{fetcher=fetch}={}){
 const db=env.DB,generation=status?.installed?.version;if(!generation)return {pending:false};
 let p=await offlineProgress(db);if(p.version!==generation)p={version:generation,cursor:0,checked:0,matched:0};
 const jobs=rows(await db.prepare(`SELECT j.rowid AS row_id,j.artist,j.title,j.album,CASE WHEN j.album='' THEN 'country_code' ELSE 'release_year' END AS field,m.seq AS known,f.year AS file_year FROM hive_metadata_jobs j LEFT JOIN hive_metadata m ON m.artist=j.artist AND m.title='' AND m.album=j.album AND m.field=CASE WHEN j.album='' THEN 'country_code' ELSE 'release_year' END LEFT JOIN hive_file_album_years f ON f.artist=j.artist AND f.album=j.album WHERE j.rowid>? AND j.title='' ORDER BY j.rowid LIMIT 150`).bind(p.cursor).all());
 if(!jobs.length){await set(db,OFFLINE_STATE,JSON.stringify(p));return {pending:false,...p};}
 // Never replace existing facts, or infer an album year from conflicting embedded tags.
 const candidates=jobs.filter(j=>j.artist!=='unknown artist'&&j.album!=='unknown album'&&j.known==null&&j.file_year==null);
 const writes=[];if(candidates.length){const d=await offlineCall(env,'lookup',{jobs:candidates.map(({artist,title,album})=>({artist,title,album}))},fetcher);if(d.version!==generation||!Array.isArray(d.matches)||d.matches.length!==candidates.length)throw Error('Offline index changed; retry next batch');for(let i=0;i<candidates.length;i++){const j=candidates[i],r=d.matches[i];if(!r||r.field!==j.field)continue;const value=validField(r.field,r.value),reference=cleanReference('musicbrainz',r.reference);if(!value||!reference||!isMbid(reference.split('/').at(-1))||!reference.includes(j.album?'/release-group/':'/artist/'))continue;writes.push(db.prepare(`INSERT OR IGNORE INTO hive_metadata(artist,title,album,field,value,provider,reference,verified_at,local_verified) VALUES(?,'',?,?,?,'musicbrainz',?,?,1)`).bind(j.artist,j.album,r.field,value,reference,Date.now()));}}
 // Fact writes and cache invalidation are atomic. Cursor only advances after successful commit.
 const n=writes.length;if(n){writes.push(db.prepare('DELETE FROM telemetry_summary_cache'),db.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'"));}
 const results=n?await db.batch(writes):[];const matched=results.slice(0,n).reduce((total,r)=>total+changed(r),0);
 p={...p,cursor:jobs.at(-1).row_id,checked:p.checked+candidates.length,matched:p.matched+matched};await set(db,OFFLINE_STATE,JSON.stringify(p));return {pending:true,verified:matched,...p};
}
export async function runMetadata(env,{force=false,fetcher=fetch,continuous=false,pullOnly=false}={}){
 await ensureMetadataSchema(env);const c=await metadataConfig(env),db=env.DB,docker=isDockerMetadata(env);let scan=await scanState(db);
 const offline=docker&&(continuous||force)&&!pullOnly?await offlineStatus(env,fetcher):null;
 if(continuous&&docker&&scan.state==='complete'&&offline?.installed?.version&&(await offlineProgress(db)).version!==offline.installed.version){scan={...scan,state:'running',updated:Date.now()};await writeScan(db,scan);}
 if(continuous&&docker&&scan.state==='complete'){const ep=Number(await setting(db,'hive_metadata_discovery_v177'))||0,lp=Number(await setting(db,'hive_metadata_library_cursor_v177'))||0,fp=Number(await setting(db,FILE_CURSOR))||0;const more=await db.prepare('SELECT 1 WHERE EXISTS(SELECT 1 FROM telemetry_events WHERE seq>?) OR EXISTS(SELECT 1 FROM tracks WHERE rowid>?) OR EXISTS(SELECT 1 FROM hive_file_metadata_retry r JOIN tracks t ON r.track_id=t.id WHERE r.next_at<=?) OR EXISTS(SELECT 1 FROM hive_metadata_jobs WHERE next_at<=?)').bind(ep,Math.min(lp,fp),Date.now(),Date.now()).first();if(more){scan={...scan,state:'running',updated:Date.now()};await writeScan(db,scan);}}
 if(continuous&&(!docker||scan.state!=='running'))return {disabled:true};
 if(!force&&!continuous&&!c.enabled&&!c.trustPeers)return {disabled:true};
 if(pullOnly&&!c.trustPeers)return {error:'Enable trusted peer metadata and save settings first.'};
 if(!continuous&&docker&&scan.state==='running'&&!pullOnly)return {skipped:true,reason:'Continuous scanner is running'};
 const now=Date.now(),interval=Math.max(5,Number(c.minutes)||5)*60000;

 const lease=String(now+120000);
 const claimed=await db.prepare(`INSERT INTO settings(key,value) VALUES('hive_metadata_lease_v182',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<?`).bind(lease,now).run();
 if(!changed(claimed))return {skipped:true,reason:'Another metadata batch is running',retryAt:Number(await setting(db,'hive_metadata_lease_v182'))||now};
 try{
 if(continuous){const tags=await fileBatch(env);if(tags.remaining){const current=await scanState(db);if(current.id===scan.id)await writeScan(db,{...current,phase:'files',updated:Date.now()});return {fileScan:tags};}}
 if(!continuous&&!pullOnly){const cooldown=await db.prepare(`INSERT INTO settings(key,value) VALUES('hive_metadata_next',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<?`).bind(String(now+(force?60000:interval)),now).run();if(!changed(cooldown))return {skipped:true,reason:'Cooling down until next scheduled batch',retryAt:Number(await setting(db,'hive_metadata_next'))||now};}
 let imported=0,pullError='';const lastPull=continuous&&c.trustPeers?Number(await setting(db,'hive_metadata_local_pull_at'))||0:0;
 if(!continuous||pullOnly||(c.trustPeers&&now-lastPull>=60000))try{if(continuous)await set(db,'hive_metadata_local_pull_at',now);imported=await pullTrusted(env,c,{fetcher,pageSize:continuous||pullOnly||(!c.enabled&&c.trustPeers)?20:3});}catch(e){pullError=str(e.message,120);}
 if(!continuous&&!docker&&!pullOnly&&(force||c.enabled))await fileBatch(env);
 if(pullOnly||(!force&&!continuous&&!c.enabled)){
   if(imported){await db.prepare('DELETE FROM telemetry_summary_cache').run();await db.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'").run();}
   const outcome={imported,verified:0,processed:0,errors:pullError?1:0,at:now,...(pullError?{error:pullError}:{})};await set(db,'hive_metadata_last_run',JSON.stringify(outcome));await set(db,'hive_metadata_last_error',pullError);return outcome;
 }
 if(!offline?.installed&&!offline?.active&&continuous&&Number(scan.retryAt||0)>now){const tags=await peerTagBatch(env,c,fetcher);if(imported){await db.prepare('DELETE FROM telemetry_summary_cache').run();await db.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'").run();}return {skipped:true,reason:'Provider cooldown',retryAt:scan.retryAt,peerTags:tags};}
 const cursor=Number(await setting(db,'hive_metadata_discovery_v177'))||0;const discoveryLimit=continuous?120:30;let discovered=rows(await db.prepare('SELECT seq,artist,title,album FROM telemetry_events WHERE seq>? ORDER BY seq LIMIT ?').bind(cursor,discoveryLimit).all());let discoveryKey='hive_metadata_discovery_v177';let fromHistory=true;
 if(!discovered.length){fromHistory=false;discoveryKey='hive_metadata_library_cursor_v177';const position=Number(await setting(db,discoveryKey))||0;try{discovered=rows(await db.prepare('SELECT rowid AS seq,artist,title,album FROM tracks WHERE rowid>? ORDER BY rowid LIMIT ?').bind(position,discoveryLimit).all());}catch{discovered=[];}}
 if(discovered.length){const jobs=new Map();for(const e of discovered){for(const [artist,title,album] of [[key(e.artist),'',''],...(key(e.album)?[[key(e.artist),'',key(e.album)]]:[]),...(key(e.title)?[[key(e.artist),key(e.title),key(e.album)]]:[])]){if(!artist)continue;const k=JSON.stringify([artist,title,album]);jobs.set(k,(jobs.get(k)||0)+(fromHistory?1:0));}}
 const statements=[],items=[...jobs];for(let i=0;i<items.length;i+=20){const chunk=items.slice(i,i+20);statements.push(db.prepare(`INSERT INTO hive_metadata_jobs(artist,title,album,play_priority) VALUES ${chunk.map(()=>'(?,?,?,?)').join(',')} ON CONFLICT(artist,title,album) DO UPDATE SET play_priority=play_priority+excluded.play_priority,next_at=CASE WHEN play_priority=0 AND excluded.play_priority>0 THEN 0 ELSE next_at END`).bind(...chunk.flatMap(([k,n])=>[...JSON.parse(k),n])));}
 // Advance the cursor atomically with the queue writes so retries cannot inflate priority.
 statements.push(db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(discoveryKey,String(discovered.at(-1).seq)));await db.batch(statements);}
 // Finish offline facts before online cooldowns or slow remote audio reads.
 if(offline?.installed?.version){if(imported){await db.prepare('DELETE FROM telemetry_summary_cache').run();await db.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'").run();}const result=await offlineFactsBatch(env,c,offline,{fetcher});if(result.pending||discovered.length){const current=await scanState(db);if(continuous&&current.id===scan.id)await writeScan(db,{...current,phase:'offline',updated:Date.now(),verified:(current.verified||0)+(result.verified||0),offlineChecked:result.checked,offlineMatched:result.matched,discovered:(current.discovered||0)+discovered.length,lastError:''});return {offline:result,imported};}}
 if(offline?.active&&!offline.installed){if(continuous){const current=await scanState(db);if(current.id===scan.id)await writeScan(db,{...current,phase:'offline download',updated:Date.now()});}return {skipped:true,reason:'Waiting for offline metadata database',imported};}
 if(continuous&&(!offline?.installed||c.offlineFallback)&&Number(scan.retryAt||0)>now){const tags=await peerTagBatch(env,c,fetcher);if(imported){await db.prepare('DELETE FROM telemetry_summary_cache').run();await db.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'").run();}return {skipped:true,reason:'Provider cooldown',retryAt:scan.retryAt,peerTags:tags};}
 const peerTags=continuous?await peerTagBatch(env,c,fetcher):{verified:0,checked:0};
 if(continuous&&peerTags.pending){const current=await scanState(db);if(current.id===scan.id)await writeScan(db,{...current,phase:'peer tags',updated:Date.now(),discovered:(current.discovered||0)+discovered.length,verified:(current.verified||0)+peerTags.verified,errors:(current.errors||0)+(peerTags.error?1:0),lastError:peerTags.error||''});if(imported){await db.prepare('DELETE FROM telemetry_summary_cache').run();await db.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'").run();}return {peerTags,imported};}
 let verified=peerTags.verified,checked=0,errors=pullError?1:0,processed=0,problem=pullError,providerRetry=0;
 const limit=continuous?(offline?.installed&&!c.offlineFallback?50:Math.max(1,Math.min(50,Number(c.batchSize)||1))):Math.min(c.trustPeers?1:3,[1,2,3].includes(Number(c.batchSize))?Number(c.batchSize):1);const jobs=rows(await db.prepare(`SELECT * FROM hive_metadata_jobs WHERE next_at<=? ORDER BY ${c.prioritizePlayed?'play_priority DESC,':''} CASE WHEN title='' AND album='' THEN ${continuous?1:0} WHEN title='' THEN ${continuous?0:1} ELSE 2 END,next_at,artist,title,album LIMIT ?`).bind(now,limit).all());
 const providerLast=new Map(),limited=new Set();
 for(const job of jobs){if(processed&&Date.now()-now>20000)break;if(continuous&&(await scanState(db)).state!=='running')break;processed++;const album=!job.title&&!!job.album,artist=!job.title&&!album;
 const albumVerified=continuous&&job.title&&job.album?await db.prepare("SELECT 1 FROM hive_metadata WHERE artist=? AND title='' AND album=? AND field='release_year'").bind(job.artist,job.album).first():null;
 const fileAlbum=continuous&&job.album&&job.album!=='unknown album'?await db.prepare(`SELECT year FROM hive_file_album_years WHERE artist=? AND album=?`).bind(job.artist,job.album).first():null;
 // An unambiguous local album tag can satisfy the album job without an API.
 // Do not persist a guessed album fact; telemetry resolves it dynamically below.
 const albumKnown=!!albumVerified||Number(fileAlbum?.year)>0;
 const needed=album?(albumKnown?[]:['release_year']):artist?['country_code','genre']:job.album&&(!continuous||albumKnown)?['genre']:['genre','release_year'];
 const existing=rows(await db.prepare('SELECT field FROM hive_metadata WHERE artist=? AND title=? AND album=?').bind(job.artist,job.title,job.album).all());const missing=new Set(needed.filter(f=>!existing.some(e=>e.field===f)));
 // Factual lookups use MusicBrainz even when Last.fm is preferred, if fallback is allowed.
 const providers=offline?.installed&&!c.offlineFallback?[]:[c.preferred,...(c.fallback?[c.preferred==='lastfm'?'musicbrainz':'lastfm']:[]),...(c.fallback&&c.wikidata?['wikidata']:[])];
 let jobError=false;for(const provider of providers){if(!missing.size||(['musicbrainz','wikidata'].includes(provider)&&!validContact(c.contact))||limited.has(provider)||!c[provider]||(provider==='lastfm'&&(album||!missing.has('genre')))||(provider==='wikidata'&&(job.title||(!missing.has('release_year')&&!missing.has('country_code')))))continue;
 try{const elapsed=Date.now()-(providerLast.get(provider)||0);if(providerLast.has(provider)&&elapsed<1100)await new Promise(r=>setTimeout(r,1100-elapsed));providerLast.set(provider,Date.now());let records=provider==='musicbrainz'?await lookupMusicbrainz(job,{fetcher,contact:c.contact}):provider==='wikidata'?await lookupWikidata(job,{fetcher,contact:c.contact}):await lookupLastfm(job,{fetcher,apiKey:(await credentials(env)).apiKey});checked++;for(const r of records)if(missing.has(r.field)){const saved=await store(env,r,true,c);verified+=saved;if(saved)missing.delete(r.field);}}catch(e){errors++;jobError=true;problem=provider+': '+str(e.message,105);if(/rate limited|HTTP 429|error 29|HTTP 503/.test(problem)){limited.add(provider);if(continuous)providerRetry=Math.max(Date.now()+60000,e.retryAt||0);break;}}}
 if(providerRetry){processed--;break;}
 await db.prepare('UPDATE hive_metadata_jobs SET next_at=? WHERE artist=? AND title=? AND album=?').bind(now+(missing.size?(jobError?30*60000:DAY):30*DAY),job.artist,job.title,job.album).run();}
 await set(db,'hive_metadata_last_error',problem);
 if(verified||imported){await db.prepare('DELETE FROM telemetry_summary_cache').run();await db.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'").run();}const outcome={checked,processed,verified,imported,errors,discovered:discovered.length,at:now};await set(db,'hive_metadata_last_run',JSON.stringify(outcome));
 if(continuous){const current=await scanState(db);if(current.id===scan.id){const remaining=Number((await db.prepare('SELECT COUNT(*) n FROM hive_metadata_jobs WHERE next_at<=?').bind(Date.now()).first())?.n||0);const done=!remaining&&!discovered.length;await writeScan(db,{...current,state:current.state==='running'&&done?'complete':current.state,updated:Date.now(),phase:discovered.length?'discovering':'processing',processed:(scan.processed||0)+processed,verified:(scan.verified||0)+verified,errors:(scan.errors||0)+errors,discovered:(scan.discovered||0)+discovered.length,remaining,lastError:problem,retryAt:providerRetry});}}
 return outcome;
 }catch(e){if(continuous){const current=await scanState(db);if(current.id===scan.id)await writeScan(db,{...current,updated:Date.now(),lastError:str(e.message,180)});}throw e;}
 finally{await db.prepare("DELETE FROM settings WHERE key='hive_metadata_lease_v182' AND value=?").bind(lease).run().catch(()=>{});}
} 
// All retained HIVE plays. Same precedence as telemetry overview; one SQL aggregate,
// cached separately so opening settings repeatedly does not rescan the event ledger.
export async function metadataCoverage(env){const db=env.DB;let prior;try{prior=JSON.parse(await setting(db,'hive_metadata_coverage_v177')||'null')}catch{}if(prior&&Date.now()-prior.at<300000)return prior;
 try{const r=await db.prepare(`SELECT COUNT(*) AS total,
 SUM(CASE WHEN COALESCE(CAST(a.value AS INTEGER),CAST(t.value AS INTEGER),NULLIF(e.release_year,0),NULLIF(m.release_year,0),NULLIF(fileAlbum.year,0),0)>=1850 THEN 1 ELSE 0 END) AS years,
 SUM(CASE WHEN COALESCE(NULLIF(c.value,''),NULLIF(e.country_code,''),g.country_code,'') GLOB '[A-Z][A-Z][A-Z]' THEN 1 ELSE 0 END) AS origins
 FROM telemetry_events e LEFT JOIN telemetry_track_metadata m ON m.track_id=e.track_id
 LEFT JOIN hive_metadata a ON a.artist=LOWER(TRIM(e.artist)) AND a.title='' AND a.album=LOWER(TRIM(e.album)) AND a.field='release_year' AND e.album<>'' LEFT JOIN hive_file_album_years fileAlbum ON fileAlbum.artist=LOWER(TRIM(e.artist)) AND fileAlbum.album=LOWER(TRIM(e.album))
 LEFT JOIN hive_metadata t ON t.artist=LOWER(TRIM(e.artist)) AND t.title=LOWER(TRIM(e.title)) AND t.album=LOWER(TRIM(e.album)) AND t.field='release_year'
 LEFT JOIN hive_metadata c ON c.artist=LOWER(TRIM(e.artist)) AND c.title='' AND c.album='' AND c.field='country_code'
 LEFT JOIN telemetry_artist_metadata g ON LOWER(e.artist)=g.artist_key`).first();const data={total:Number(r?.total||0),years:Number(r?.years||0),origins:Number(r?.origins||0),at:Date.now()};await set(db,'hive_metadata_coverage_v177',JSON.stringify(data));return data;}catch(e){if(/no such table/i.test(String(e.message)))return null;throw e;}}
export async function metadataAdmin(req,env,url,{fetcher=fetch}={}){
 await ensureMetadataSchema(env);const c=await metadataConfig(env),db=env.DB,action=url.pathname.split('/').at(-1);
 if(action.startsWith('offline-')){if(!isDockerMetadata(env))return json({error:'Offline metadata is available on Docker only.'},400);try{const op=action.slice(8);if(op==='status'&&req.method==='GET')return json({...await offlineCall(env,'status',undefined,fetcher),progress:await offlineProgress(db)});if(['download','cancel'].includes(op)&&req.method==='POST')return json(await offlineCall(env,op,{},fetcher));return json({error:'Not found'},404);}catch(e){return json({error:str(e.message,180)},502);}}
 if(req.method==='GET'&&action==='metadata'){
  // Count distinct verified entities, not listening events; no upstream calls.
  const counts=await db.prepare(`SELECT COALESCE(SUM(fields),0) verified,COALESCE(SUM(CASE WHEN title<>'' THEN 1 ELSE 0 END),0) verifiedTracks,COALESCE(SUM(CASE WHEN title='' AND album='' THEN 1 ELSE 0 END),0) verifiedArtists,COALESCE(SUM(CASE WHEN title='' AND album<>'' THEN 1 ELSE 0 END),0) verifiedAlbums FROM (SELECT artist,title,album,COUNT(*) fields FROM hive_metadata GROUP BY artist,title,album)`).first();
  return json({...c,runtime:isDockerMetadata(env)?'docker':'cloudflare',scan:await scanState(db),fileScan:isDockerMetadata(env)?await fileProgress(db):null,retryAt:Number(await setting(db,'hive_metadata_next'))||0,peers:rows(await db.prepare('SELECT url,name FROM peers ORDER BY added_at LIMIT 60').all()),...await credentialState(env),lastRun:JSON.parse(await setting(db,'hive_metadata_last_run')||'null'),lastError:await setting(db,'hive_metadata_last_error')||'',verified:Number(counts?.verified||0),verifiedTracks:Number(counts?.verifiedTracks||0),verifiedArtists:Number(counts?.verifiedArtists||0),verifiedAlbums:Number(counts?.verifiedAlbums||0),coverage:await metadataCoverage(env).catch(()=>null)});
 }
 if(req.method==='PUT'&&action==='metadata'){
  const b=await req.json().catch(()=>null);if(!b||typeof b!=='object'||Array.isArray(b))return json({error:'Invalid settings payload.'},400);
  const next={...c};if(['lastfm','musicbrainz'].includes(b.preferred))next.preferred=b.preferred;
  for(const k of ['musicbrainz','lastfm','fallback','enabled','trustPeers','shareLastfm','wikidata','prioritizePlayed','readPeerTags','offlineFallback'])if(typeof b[k]==='boolean')next[k]=b[k];
  if(!isDockerMetadata(env))next.readPeerTags=false;
  if(typeof b.preferredPeer==='string'){if(b.preferredPeer&&!(await db.prepare('SELECT 1 FROM peers WHERE url=?').bind(b.preferredPeer).first()))return json({error:'Select a registered admin peer.'},400);next.preferredPeer=b.preferredPeer;}
  if((isDockerMetadata(env)?[1,2,3,5,10,20,50]:[1,2,3]).includes(Number(b.batchSize)))next.batchSize=Number(b.batchSize);
  if([5,10,15,30,60,120].includes(Number(b.minutes)))next.minutes=Number(b.minutes);
  if(typeof b.contact==='string'){next.contact=str(b.contact,160).replace(/[\r\n]/g,'');if(next.contact&&!validContact(next.contact))return json({error:'Use a valid MusicBrainz contact email or URL, or leave it blank.'},400);}
  const newKey=str(b.apiKey),newSecret=str(b.secret),replace=b.replaceCredentials===true;
  if(replace&&!newKey)return json({error:'Enter a new Last.fm API key to replace existing credentials.'},400);
  if(b.clearCredentials===true&&(newKey||newSecret))return json({error:'Choose either clear or save credentials.'},400);
  let encrypted;
  if(newKey||newSecret){
   let old={};if(!replace){try{old=await credentials(env);}catch(e){return json({error:e.message},409);}}
   const effectiveKey=newKey||old.apiKey||'';if(!effectiveKey)return json({error:'Enter a Last.fm API key before saving a shared secret.'},400);
   try{encrypted=await encryptCredentials(env,effectiveKey,newSecret||old.secret||'');}catch{return json({error:'Unable to save encrypted credentials. Configure a persistent METADATA_SETTINGS_KEY of at least 24 characters.'},400);}
  }
  const upsert=(k,v)=>db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k,v);
  const writes=[upsert('hive_metadata_config',JSON.stringify(next))];
  if(isDockerMetadata(env)&&next.offlineFallback&&!c.offlineFallback)writes.push(db.prepare('UPDATE hive_metadata_jobs SET next_at=0'));
  if(encrypted)writes.push(upsert('hive_lastfm_encrypted',encrypted));else if(b.clearCredentials===true)writes.push(db.prepare("DELETE FROM settings WHERE key='hive_lastfm_encrypted'"));
  await db.batch(writes);
  return json({ok:true,...await credentialState(env)});
 }
 if(req.method==='POST'&&action==='test'){
  try{const b=await req.json().catch(()=>({}));if(!['lastfm','musicbrainz'].includes(b.provider))return json({error:'Choose a supported provider.'},400);
   // Test current form values, if supplied; this never writes credentials.
   let source='saved',options={fetcher};
   if(b.provider==='lastfm'){const entered=str(b.apiKey);options.apiKey=entered||(await credentials(env)).apiKey;source=entered?'entered':'saved';if(!options.apiKey)return json({error:'Enter or save a Last.fm API key first.'},400);}
   else {options.contact=typeof b.contact==='string'?str(b.contact,160):c.contact;source=typeof b.contact==='string'&&options.contact!==c.contact?'entered':'saved';if(!validContact(options.contact))return json({error:'Enter a valid MusicBrainz contact email or URL first.'},400);}
   const key='hive_metadata_test_next_'+b.provider,now=Date.now();const claim=await db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<?`).bind(key,String(now+5000),now).run();if(!changed(claim))return json({error:'Wait a few seconds before testing again.'},429);
   // Use a known artist query; success indicates provider response, not a matched library item.
   if(b.provider==='lastfm')await lookupLastfm({artist:'Cher',title:'',album:''},options);else await lookupMusicbrainz({artist:'Cher',title:'',album:''},options);
   return json({ok:true,source});
  }catch(e){return json({error:str(e.message,180)},502);}
 }
 if(req.method==='GET'&&action==='status')return json({scan:await scanState(db),fileScan:isDockerMetadata(env)?await fileProgress(db):null,retryAt:Number(await setting(db,'hive_metadata_next'))||0,leaseUntil:Number(await setting(db,'hive_metadata_lease_v182'))||0});
 if(req.method==='POST'&&action==='rescan-files'){if(!isDockerMetadata(env))return json({error:'Docker only'},400);if((await scanState(db)).state==='running')return json({error:'Pause or stop the scanner first.'},409);await set(db,FILE_CURSOR,0);await set(db,FILE_PROGRESS,'null');await set(db,'hive_file_force_v183','1');await db.prepare('DELETE FROM hive_peer_tag_attempts').run();await set(db,'hive_folder_rescan_token',crypto.randomUUID());return json(await metadataScanControl(env,'start'));}
 if(req.method==='POST'&&['start','pause','stop'].includes(action)){const d=await metadataScanControl(env,action);return json(d,d.error?400:200);}
 if(req.method==='POST'&&action==='pull')return json(await runMetadata(env,{force:true,fetcher,pullOnly:true}));
 if(req.method==='POST'&&action==='run')return json(await runMetadata(env,{force:true,fetcher}));return json({error:'Not found'},404);
}
