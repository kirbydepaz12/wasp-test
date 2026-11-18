// v17.0.5: independent, bounded metadata cache and enrichment. Never sends credentials or listening identities.
import {countries} from './country-codes.js';
import {requireNoRedirect} from './peer-fetch.js';
const ready=new WeakMap(), DAY=86400000;
const str=(s,n=200)=>String(s??'').trim().slice(0,n), norm=s=>str(s).toLowerCase(), key=s=>str(s).replace(/[A-Z]/g,c=>c.toLowerCase());
const json=(v,status=200)=>Response.json(v,{status,headers:{'cache-control':'no-store'}});
const rows=r=>r?.results||[];
const changed=r=>Number(r?.meta?.changes||0);
const configDefaults={preferred:'musicbrainz',musicbrainz:true,lastfm:false,fallback:true,enabled:false,minutes:5,trustPeers:false,shareLastfm:false,contact:''};
export function ensureMetadataSchema(env){
 if(ready.has(env.DB))return ready.get(env.DB);
 const task=(async()=>{if(await setting(env.DB,'hive_metadata_schema')==='1')return;for(const sql of [
 `CREATE TABLE IF NOT EXISTS hive_metadata (seq INTEGER PRIMARY KEY AUTOINCREMENT, artist TEXT NOT NULL,title TEXT NOT NULL,album TEXT NOT NULL,field TEXT NOT NULL,value TEXT NOT NULL,provider TEXT NOT NULL,reference TEXT NOT NULL DEFAULT '',verified_at INTEGER NOT NULL,local_verified INTEGER NOT NULL DEFAULT 0, UNIQUE(artist,title,album,field))`,
 `CREATE TABLE IF NOT EXISTS hive_metadata_jobs (artist TEXT NOT NULL,title TEXT NOT NULL,album TEXT NOT NULL,next_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(artist,title,album))`,
 `CREATE INDEX IF NOT EXISTS idx_hive_metadata_due ON hive_metadata_jobs(next_at)`,
 `CREATE TABLE IF NOT EXISTS hive_metadata_cursors(url TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0,node_id TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '')`
 ])await env.DB.prepare(sql).run();await set(env.DB,'hive_metadata_schema','1');})().catch(e=>{ready.delete(env.DB);throw e});ready.set(env.DB,task);return task;
}
async function setting(db,key){return (await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value;}
async function set(db,key,value){await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,String(value)).run();}
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
function factual(entry){return entry.provider==='musicbrainz' && ['release_year','country_code'].includes(entry.field);}
const isMbid=s=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(s));
function cleanReference(provider,ref){if(typeof ref!=='string'||ref.length>500)return '';try{const u=new URL(ref);if(provider==='lastfm'&&u.protocol==='http:'&&u.hostname==='www.last.fm')u.protocol='https:';if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return '';if(provider==='lastfm'&&u.hostname==='www.last.fm'&&u.pathname.startsWith('/music/'))return u.href;if(provider==='musicbrainz'&&u.hostname==='musicbrainz.org'&&/^\/(recording|artist)\/[a-f0-9-]+$/i.test(u.pathname))return u.href;}catch{}return '';}
async function store(env,entry,local,config){const value=validField(entry.field,entry.value),reference=cleanReference(entry.provider,entry.reference);if(!value||!reference||!['lastfm','musicbrainz'].includes(entry.provider))return 0;
 const artist=key(entry.artist),title=entry.field==='country_code'?'':key(entry.title),album=title?key(entry.album):'';if(!artist||(!title&&entry.field==='release_year'))return 0;
 const prior=await env.DB.prepare('SELECT * FROM hive_metadata WHERE artist=? AND title=? AND album=? AND field=?').bind(artist,title,album,entry.field).first();
 if(prior&&(!local||prior.provider===config.preferred&&entry.provider!==config.preferred||prior.value===value&&prior.provider===entry.provider&&prior.local_verified&&local))return 0;
 // REPLACE assigns a new sequence only when a field is newly verified/changed. No event rows are changed.
 if(entry.provider==='lastfm'&&prior?.provider!=='lastfm'){const used=Number(await setting(env.DB,'hive_lastfm_fields_budget'))||0;if(used>=10000)return 0;await set(env.DB,'hive_lastfm_fields_budget',used+1);}
 const r=await env.DB.prepare('INSERT OR REPLACE INTO hive_metadata(artist,title,album,field,value,provider,reference,verified_at,local_verified) VALUES(?,?,?,?,?,?,?,?,?)').bind(artist,title,album,entry.field,value,entry.provider,reference,Date.now(),local?1:0).run();return changed(r);
}
const lucene=s=>'"'+str(s).replace(/[\\"]/g,'\\$&')+'"';
async function getJSON(fetcher,url,headers={}){let res;try{res=requireNoRedirect(await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{accept:'application/json',...headers}}));}catch{throw Error('Metadata provider connection failed');}if(!res.ok)throw Error('Metadata provider HTTP '+res.status+(res.status===429?' (rate limited)':''));let d;try{d=await res.json();}catch{throw Error('Metadata provider returned a non-JSON response (HTTP '+res.status+')');}if(!d||typeof d!=='object')throw Error('Invalid metadata provider response');if(d.error){const code=Number(d.error);throw Error('Metadata provider error'+(Number.isFinite(code)?' '+code:'')+(code===10?' (invalid API key)':code===29?' (rate limited)':''));}return d;}
const tag=x=>str((x||[]).find(t=>t?.name)?.name,80);
export async function lookupMusicbrainz(job,{fetcher=fetch,contact=''}={}){
 if(!contact)throw Error('Set MusicBrainz contact email or URL first.');
 const artist=!job.title,kind=artist?'artist':'recording';const url=new URL('https://musicbrainz.org/ws/2/'+kind+'/');
 url.searchParams.set('query',artist?'artist:'+lucene(job.artist):'recording:'+lucene(job.title)+' AND artist:'+lucene(job.artist)+(job.album?' AND release:'+lucene(job.album):''));url.searchParams.set('fmt','json');url.searchParams.set('limit','5');
 const data=await getJSON(fetcher,url,{'User-Agent':`WASP/17.0.6 (${contact})`});
 const matches=(data[artist?'artists':'recordings']||[]).filter(r=>isMbid(r.id)&&Number(r.score)>=95&&(artist?norm(r.name)===norm(job.artist):norm(r.title)===norm(job.title)&&norm((r['artist-credit']||[]).map(c=>(c.name||c.artist?.name||'')+(c.joinphrase||'')).join(''))===norm(job.artist)&&(!job.album||(r.releases||[]).some(x=>norm(x.title)===norm(job.album)))));
 // Ambiguous exact matches are deliberately unresolved, not guessed.
 if(matches.length!==1)return [];const hit=matches[0],reference=`https://musicbrainz.org/${kind}/${hit.id}`,out=[];
 if(artist){const code=hit.country||hit.area?.['iso-3166-1-codes']?.[0];if(countries[code])out.push({field:'country_code',value:countries[code]});}
 else {const year=String(hit['first-release-date']||'').match(/^\d{4}/)?.[0];if(year)out.push({field:'release_year',value:year});}
 const genre=tag(hit.tags);if(genre)out.push({field:'genre',value:genre});return out.map(x=>({...job,...x,provider:'musicbrainz',reference}));
}
export async function lookupLastfm(job,{fetcher=fetch,apiKey}={}){
 if(!apiKey)throw Error('Last.fm API key not configured');const artist=!job.title,url=new URL('https://ws.audioscrobbler.com/2.0/');url.search=new URLSearchParams({method:artist?'artist.getInfo':'track.getInfo',api_key:apiKey,artist:job.artist,...(!artist?{track:job.title}:{}),format:'json',autocorrect:'0'});
 const d=await getJSON(fetcher,url),hit=artist?d.artist:d.track;if(!hit||norm(artist?hit.name:hit.artist?.name)!==norm(job.artist)||(!artist&&(norm(hit.name)!==norm(job.title)||(job.album&&norm(hit.album?.title)!==norm(job.album)))))return [];
 const genre=tag((artist?hit.tags:hit.toptags)?.tag);return genre?[{...job,field:'genre',value:genre,provider:'lastfm',reference:hit.url}]:[];
}
// Separate cursor feed avoids replaying listening events. Only locally verified factual fields,
// plus Last.fm fields when explicit redistribution permission was enabled, are exposed.
export async function metadataFeed(env,url){await ensureMetadataSchema(env);const c=await metadataConfig(env);if(await setting(env.DB,'network_share')!=='1'||await setting(env.DB,'telemetry_share_enabled')==='0')return json({error:'Sharing disabled'},403);
 const cursor=Number(url.searchParams.get('cursor')||0);if(!Number.isSafeInteger(cursor)||cursor<0)return json({error:'Invalid cursor'},400);
 const result=rows(await env.DB.prepare(`SELECT seq,artist,title,album,field,value,provider,reference,verified_at FROM hive_metadata WHERE seq>? AND local_verified=1 AND ((provider='musicbrainz' AND field IN ('release_year','country_code')) OR (provider='lastfm' AND ?=1)) ORDER BY seq LIMIT 20`).bind(cursor,c.shareLastfm?1:0).all());return json({ok:true,protocol:1,nodeId:await setting(env.DB,'telemetry_instance_id'),cursor:result.at(-1)?.seq||cursor,entries:result});}
async function pullTrusted(env,c,{fetcher=fetch}={}){if(!c.trustPeers)return 0;const peers=rows(await env.DB.prepare('SELECT url FROM peers ORDER BY added_at LIMIT 60').all());if(!peers.length)return 0;const i=Number(await setting(env.DB,'hive_metadata_peer_offset'))||0,url=peers[i%peers.length].url;await set(env.DB,'hive_metadata_peer_offset',(i+1)%peers.length);let count=0;
 try{const base=new URL(url);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)return 0;const prior=await env.DB.prepare('SELECT * FROM hive_metadata_cursors WHERE url=?').bind(url).first(),u=new URL('/api/telemetry/metadata/feed',base);const cursor=Number(prior?.cursor)||0;u.searchParams.set('cursor',String(cursor));const data=await getJSON(fetcher,u);if(data.protocol!==1||!data.ok||!isMbid(data.nodeId)||!Array.isArray(data.entries)||data.entries.length>20||!Number.isSafeInteger(data.cursor)||data.cursor<cursor||data.entries.some((r,i)=>!Number.isSafeInteger(r.seq)||r.seq<=(i?data.entries[i-1].seq:cursor)||r.seq>data.cursor))throw Error('Invalid peer metadata feed');if(prior?.node_id&&prior.node_id!==data.nodeId){await env.DB.prepare('DELETE FROM hive_metadata_cursors WHERE url=?').bind(url).run();return 0;}
 for(const e of data.entries)if(factual(e)||(c.shareLastfm&&e.provider==='lastfm'))count+=await store(env,e,false,c);
 await env.DB.prepare(`INSERT INTO hive_metadata_cursors(url,cursor,node_id,error) VALUES(?,?,?,'') ON CONFLICT(url) DO UPDATE SET cursor=excluded.cursor,node_id=excluded.node_id,error=''`).bind(url,data.cursor,str(data.nodeId,90)).run();
 }catch(e){await env.DB.prepare(`INSERT INTO hive_metadata_cursors(url,error) VALUES(?,?) ON CONFLICT(url) DO UPDATE SET error=excluded.error`).bind(url,str(e.message,120)).run();}return count;}
export async function runMetadata(env,{force=false,fetcher=fetch}={}){await ensureMetadataSchema(env);const c=await metadataConfig(env);if(!force&&!c.enabled)return {disabled:true};const now=Date.now(),interval=Math.max(5,Number(c.minutes)||5)*60000;
 const claimed=await env.DB.prepare(`INSERT INTO settings(key,value) VALUES('hive_metadata_next',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<?`).bind(String(now+(force?60000:interval)),now).run();if(!changed(claimed))return {skipped:true,reason:'Cooldown or another batch running'};
 const db=env.DB;const cursor=Number(await setting(db,'hive_metadata_discovery'))||0;let discovered=rows(await db.prepare('SELECT seq,artist,title,album FROM telemetry_events WHERE seq>? ORDER BY seq LIMIT 30').bind(cursor).all());let discoveryKey='hive_metadata_discovery';
 if(!discovered.length){discoveryKey='hive_metadata_library_cursor';const position=Number(await setting(db,discoveryKey))||0;try{discovered=rows(await db.prepare('SELECT rowid AS seq,artist,title,album FROM tracks WHERE rowid>? ORDER BY rowid LIMIT 30').bind(position).all());}catch{discovered=[];}}
 if(discovered.length){const statements=[],seen=new Set();for(const e of discovered){for(const [artist,title,album] of [[key(e.artist),'',''],[key(e.artist),key(e.title),key(e.album)]]){if(!artist)continue;const k=JSON.stringify([artist,title,album]);if(seen.has(k))continue;seen.add(k);statements.push(db.prepare('INSERT OR IGNORE INTO hive_metadata_jobs(artist,title,album) VALUES(?,?,?)').bind(artist,title,album));}}for(let i=0;i<statements.length;i+=30)await db.batch(statements.slice(i,i+30));await set(db,discoveryKey,discovered.at(-1).seq);}
 const imported=await pullTrusted(env,c,{fetcher});let verified=0,checked=0,errors=0;
 // One entity and at most one request to each provider per batch; never run from dashboard reads.
 const job=await db.prepare('SELECT * FROM hive_metadata_jobs WHERE next_at<=? ORDER BY next_at,artist,title,album LIMIT 1').bind(now).first();
 if(job){const needed=job.title?['genre','release_year']:['genre','country_code'];const existing=rows(await db.prepare('SELECT field FROM hive_metadata WHERE artist=? AND title=? AND album=?').bind(job.artist,job.title,job.album).all());const missing=new Set(needed.filter(f=>!existing.some(e=>e.field===f)));let problem='';
 const providers=[c.preferred,...(c.fallback?[c.preferred==='lastfm'?'musicbrainz':'lastfm']:[])];
 for(const provider of providers){if(!missing.size||!c[provider])continue;try{const records=provider==='musicbrainz'?await lookupMusicbrainz(job,{fetcher,contact:c.contact}):await lookupLastfm(job,{fetcher,apiKey:(await credentials(env)).apiKey});checked++;for(const r of records)if(missing.has(r.field)){const saved=await store(env,r,true,c);verified+=saved;if(saved)missing.delete(r.field);}}catch(e){errors++;problem=str(e.message,120);}}
 await db.prepare('UPDATE hive_metadata_jobs SET next_at=? WHERE artist=? AND title=? AND album=?').bind(now+(missing.size?(errors?30*60000:DAY):30*DAY),job.artist,job.title,job.album).run();await set(db,'hive_metadata_last_error',problem);}
 if(verified||imported)await db.prepare('DELETE FROM telemetry_summary_cache').run();const outcome={checked,verified,imported,errors,discovered:discovered.length,at:now};await set(db,'hive_metadata_last_run',JSON.stringify(outcome));return outcome;}
export async function metadataAdmin(req,env,url,{fetcher=fetch}={}){
 await ensureMetadataSchema(env);const c=await metadataConfig(env),db=env.DB,action=url.pathname.split('/').at(-1);
 if(req.method==='GET'&&action==='metadata'){
  // Count distinct verified entities, not listening events; no upstream calls.
  const counts=await db.prepare(`SELECT COALESCE(SUM(fields),0) verified,COALESCE(SUM(CASE WHEN title<>'' THEN 1 ELSE 0 END),0) verifiedTracks,COALESCE(SUM(CASE WHEN title='' THEN 1 ELSE 0 END),0) verifiedArtists FROM (SELECT artist,title,album,COUNT(*) fields FROM hive_metadata GROUP BY artist,title,album)`).first();
  return json({...c,...await credentialState(env),lastRun:JSON.parse(await setting(db,'hive_metadata_last_run')||'null'),lastError:await setting(db,'hive_metadata_last_error')||'',verified:Number(counts?.verified||0),verifiedTracks:Number(counts?.verifiedTracks||0),verifiedArtists:Number(counts?.verifiedArtists||0)});
 }
 if(req.method==='PUT'&&action==='metadata'){
  const b=await req.json().catch(()=>null);if(!b||typeof b!=='object'||Array.isArray(b))return json({error:'Invalid settings payload.'},400);
  const next={...c};if(['lastfm','musicbrainz'].includes(b.preferred))next.preferred=b.preferred;
  for(const k of ['musicbrainz','lastfm','fallback','enabled','trustPeers','shareLastfm'])if(typeof b[k]==='boolean')next[k]=b[k];
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
 if(req.method==='POST'&&action==='run')return json(await runMetadata(env,{force:true,fetcher}));return json({error:'Not found'},404);
}
