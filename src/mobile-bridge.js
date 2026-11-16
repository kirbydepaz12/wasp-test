import {recordTelemetryListen} from "./telemetry.js";
import {readFederatedCatalogue, publicPeerOrigin} from './mobile-federation.js';
import {readMobilePlaylists} from './mobile-playlists.js';
import {makeMobileFolders, folderArtistIndex} from './mobile-folders.js';
import {recordMobilePlayback} from './mobile-live.js';
/**
 * WASP v16 staging: an opt-in read-focused Subsonic/OpenSubsonic compatibility
 * adapter. WASP's native API, player, peer protocol, and music storage remain
 * authoritative. This module never copies or alters audio on source peers.
 */
const encoder = new TextEncoder();
const dec = new TextDecoder();
const VERSION = '1.16.1';
const WASP_VERSION = '17.0.0';
const NO_STORE = {'cache-control':'private, no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer'};
const KEYS_TABLE = `CREATE TABLE IF NOT EXISTS mobile_bridge_keys (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL,
 key_hash TEXT NOT NULL UNIQUE, secret_cipher TEXT NOT NULL,
 created_at INTEGER NOT NULL, last_used INTEGER NOT NULL DEFAULT 0)`;
const clean = (x,n=200) => String(x??'').trim().slice(0,n);
const n = (x, fallback=0, max=1000) => Math.min(max,Math.max(0,x===null||x===undefined||x===''?fallback:Number.isFinite(Number(x))?Math.floor(Number(x)):fallback));
const bytesHex = b => [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const unhex = h => Uint8Array.from(h.match(/../g)||[],v=>parseInt(v,16));
const same = (a,b) => {a=String(a);b=String(b);if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;};
async function digest(s) {return bytesHex(await crypto.subtle.digest('SHA-256', encoder.encode(s)));}
// Eight cryptographically random characters in A-Z / 0-9. Roughly 41 bits.
// Short device credentials require persistent online-guess throttling (below).
// Previously issued longer credentials continue working until revoked.
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const randomSecret = () => {
  let out='';
  while(out.length<8){
    const bytes=crypto.getRandomValues(new Uint8Array(24));
    for(const value of bytes){if(value<Math.floor(256/ALPHABET.length)*ALPHABET.length)out+=ALPHABET[value%ALPHABET.length];if(out.length===8)break;}
  }
  return out;
};
const base64 = bytes => {let s='';for(const x of bytes)s+=String.fromCharCode(x);return btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');};
const from64 = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
// MD5 is ONLY a legacy Subsonic handshake compatibility calculation. Passwords
// are random app secrets, never the password used to log into WASP.
export function legacyMd5(value){
  const src=encoder.encode(value),len=src.length;
  const data=new Uint8Array(Math.ceil((len+9)/64)*64);data.set(src);data[len]=128;
  const bitLen=BigInt(len)*8n;for(let i=0;i<8;i++)data[data.length-8+i]=Number((bitLen>>BigInt(i*8))&255n);
  const S=[7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K=Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*4294967296)>>>0);
  let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
  const view=new DataView(data.buffer);
  for(let offset=0;offset<data.length;offset+=64){
    let a=a0,b=b0,c=c0,d=d0;
    for(let i=0;i<64;i++){
      let f,g;
      if(i<16){f=(b&c)|(~b&d);g=i;}
      else if(i<32){f=(d&b)|(~d&c);g=(5*i+1)%16;}
      else if(i<48){f=b^c^d;g=(3*i+5)%16;}
      else {f=c^(b|~d);g=(7*i)%16;}
      const v=(a+f+K[i]+view.getUint32(offset+g*4,true))>>>0;
      const rotate=((v<<S[i])|(v>>>(32-S[i])))>>>0;
      [a,b,c,d]=[d,(b+rotate)>>>0,b,c];
    }
    a0=(a0+a)>>>0;b0=(b0+b)>>>0;c0=(c0+c)>>>0;d0=(d0+d)>>>0;
  }
  return [a0,b0,c0,d0].map(x=>[0,8,16,24].map(s=>((x>>>s)&255).toString(16).padStart(2,'0')).join('')).join('');
}
// Server-managed bridge secret. Only the server reads this settings row; no
// endpoint ever returns its value. Optional Docker legacy fallback preserves
// credentials created under the original v16.0.0 SCANNER_SECRET deployment.
const SEED_SETTING='mobile_bridge_secret_v1';
const secretLooksValid=s=>typeof s==='string' && s.length>=32;
async function encryptionSeed(env){
  const row=await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(SEED_SETTING).first();
  if(secretLooksValid(row?.value))return row.value;
  const docker=String(env.SCANNER_SECRET||'');
  if(secretLooksValid(docker))return docker;
  // Migration-only fallback: existing v16.0.0 Cloudflare credentials keep
  // working until the operator explicitly configures WASP-managed storage.
  const legacy=String(env.MOBILE_BRIDGE_SECRET||'');
  return secretLooksValid(legacy)?legacy:'';
}
async function secretStatus(env){
  const row=await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(SEED_SETTING).first();
  if(secretLooksValid(row?.value))return {secret_ready:true,secret_source:'wasp'};
  if(secretLooksValid(String(env.SCANNER_SECRET||'')))return {secret_ready:true,secret_source:'docker'};
  if(secretLooksValid(String(env.MOBILE_BRIDGE_SECRET||'')))return {secret_ready:true,secret_source:'legacy'};
  return {secret_ready:false,secret_source:'none'};
}
async function encryptionKey(env){
  const secret=await encryptionSeed(env);
  if(!secretLooksValid(secret)) throw Error('Mobile Bridge setup required. Ask the administrator to generate a secure secret under Network → Mobile Bridge.');
  const bytes=await crypto.subtle.digest('SHA-256',encoder.encode('WASP-MOBILE-BRIDGE-v1\0'+secret));
  return crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function seal(env,secret){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('wasp-mobile-v1')},await encryptionKey(env),encoder.encode(secret));
  return 'v1:'+base64(iv)+':'+base64(new Uint8Array(data));
}
async function unseal(env,value){
  const parts=String(value||'').split(':');if(parts.length!==3||parts[0]!=='v1')return null;
  try {const b=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(parts[1]),additionalData:encoder.encode('wasp-mobile-v1')},await encryptionKey(env),from64(parts[2]));return dec.decode(b);}
  catch{return null;}
}
export async function ensureMobileSchema(DB){
  await DB.prepare(KEYS_TABLE).run();
  await DB.prepare('CREATE INDEX IF NOT EXISTS idx_mobile_bridge_keys_user ON mobile_bridge_keys(user_id)').run();
  await DB.prepare('CREATE TABLE IF NOT EXISTS mobile_scrobble_events (credential_id TEXT NOT NULL, track_id TEXT NOT NULL, reported_at INTEGER NOT NULL, PRIMARY KEY(credential_id,track_id,reported_at))').run();
  await DB.prepare('CREATE TABLE IF NOT EXISTS mobile_auth_limits (bucket TEXT PRIMARY KEY, window_started INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0)').run();
}
async function enabled(DB){
  const row=await DB.prepare("SELECT value FROM settings WHERE key='mobile_bridge_enabled'").first();
  return row?.value==='1';
}
const webJson=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8',...NO_STORE}});
export async function manageMobileBridge(req,env,role,userId){
  // Called ONLY after native WASP session authorization in src/index.js.
  await ensureMobileSchema(env.DB);
  const path=new URL(req.url).pathname,method=req.method;
  if(path==='/api/admin/mobile-bridge' && role==='admin'){
    if(method==='GET')return webJson({enabled:await enabled(env.DB),...await secretStatus(env)});
    if(method==='PUT'){
      const body=await req.json().catch(()=>({}));
      if(typeof body.enabled!=='boolean')return webJson({error:'enabled must be boolean'},400);
      await env.DB.prepare("INSERT INTO settings(key,value) VALUES('mobile_bridge_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(body.enabled?'1':'0').run();
      return webJson({enabled:body.enabled,...await secretStatus(env)});
    }
  }
  if(path==='/api/admin/mobile-bridge/secret' && role==='admin' && method==='POST'){
    const body=await req.json().catch(()=>({}));
    const current=await secretStatus(env);
    const replacing=body.action==='rotate';
    if(body.action==='migrate'){
      if(current.secret_source==='wasp')return webJson({error:'Already using a WASP-managed secret.'},409);
      if(!current.secret_ready)return webJson({error:'No legacy secret is available to migrate.'},400);
      const previous=await encryptionSeed(env);
      await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(SEED_SETTING,previous).run();
      return webJson({ok:true,enabled:await enabled(env.DB),...await secretStatus(env),revoked_all:false});
    }
    if(!['generate','import','rotate'].includes(body.action))return webJson({error:'Unknown secret setup action'},400);
    if(current.secret_ready&&!replacing)return webJson({error:'A Mobile Bridge secret already exists. Use Reset secret only if necessary.'},409);
    if(replacing && (!current.secret_ready || body.confirm!=='RESET'))return webJson({error:'Type RESET to confirm revoking all mobile credentials.'},400);
    if(body.action==='import' && current.secret_ready)return webJson({error:'An existing secret is already configured.'},409);
    let secret;
    if(body.action==='import'){
      secret=String(body.secret||'').trim();
      // Imported values must be cryptographically generated, not simple words.
      if(!/^[a-f0-9]{64,128}$/i.test(secret))return webJson({error:'Paste a securely generated 64–128 character hexadecimal secret.'},400);
    }else secret=bytesHex(crypto.getRandomValues(new Uint8Array(32)));
    // A reset is atomic: never leave old credentials around with a new key.
    const statement=env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(SEED_SETTING,secret);
    if(replacing){
      await env.DB.batch([env.DB.prepare('DELETE FROM mobile_scrobble_events'),env.DB.prepare('DELETE FROM mobile_bridge_keys'),statement]);
    }else await statement.run();
    return webJson({ok:true,enabled:await enabled(env.DB),...await secretStatus(env),revoked_all:replacing});
  }
  if(path==='/api/user/mobile-keys' && role==='user' && userId){
    if(method==='GET'){
      const rows=(await env.DB.prepare('SELECT id,label,created_at,last_used FROM mobile_bridge_keys WHERE user_id=? ORDER BY created_at DESC').bind(userId).all()).results;
      return webJson({enabled:await enabled(env.DB),secret_ready:(await secretStatus(env)).secret_ready,keys:rows});
    }
    if(method==='POST'){
      if(!await enabled(env.DB))return webJson({error:'Mobile Bridge is disabled by the server administrator.'},403);
      if(!(await secretStatus(env)).secret_ready)return webJson({error:'Mobile Bridge setup required. An administrator must generate the server secret under Network → Mobile Bridge.'},503);
      const body=await req.json().catch(()=>({})),label=clean(body.label,64);
      if(label.length<2)return webJson({error:'Give the device a name (2-64 characters).'},400);
      const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM mobile_bridge_keys WHERE user_id=?').bind(userId).first();
      if(Number(count?.n)>=10)return webJson({error:'Maximum 10 mobile credentials. Revoke an unused device first.'},409);
      const secret=randomSecret(),id=crypto.randomUUID();
      let cipher;try{cipher=await seal(env,secret);}catch(e){return webJson({error:e.message},503);}
      await env.DB.prepare('INSERT INTO mobile_bridge_keys(id,user_id,label,key_hash,secret_cipher,created_at) VALUES(?,?,?,?,?,?)')
        .bind(id,userId,label,await digest(secret),cipher,Date.now()).run();
      return webJson({id,label,secret,created_at:Date.now(),notice:'Copy this app password/API key now. It will not be shown again.'},201);
    }
  }
  const match=path.match(/^\/api\/user\/mobile-keys\/([\w-]+)$/);
  if(match && method==='DELETE' && role==='user' && userId){
    await env.DB.prepare('DELETE FROM mobile_bridge_keys WHERE id=? AND user_id=?').bind(match[1],userId).run();
    return webJson({ok:true});
  }
  return webJson({error:'Not found'},404);
}
function escapeXml(value){return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function xmlNode(name,obj){
  if(obj===undefined||obj===null)return '';
  if(Array.isArray(obj))return obj.map(x=>xmlNode(name,x)).join('');
  if(typeof obj!=='object')return `<${name}>${escapeXml(obj)}</${name}>`;
  const attrs=[],kids=[];
  for(const [key,value] of Object.entries(obj)){
    if(value===undefined||value===null)continue;
    if(typeof value==='object')kids.push(xmlNode(key,value));
    else if(name==='genre' && key==='value')kids.push(escapeXml(value));
    else attrs.push(`${key}="${escapeXml(value)}"`);
  }
  return `<${name}${attrs.length?' '+attrs.join(' '):''}>${kids.join('')}</${name}>`;
}
export function protocolResponse(payload={},error=null,format='xml'){
  const output={status:error?'failed':'ok',version:VERSION,type:'WASP',serverVersion:WASP_VERSION,openSubsonic:true};
  if(error)output.error={code:error.code||0,message:error.message||'An error occurred'};
  else Object.assign(output,payload);
  return new Response(format==='json'?JSON.stringify({'subsonic-response':output}):`<?xml version="1.0" encoding="UTF-8"?>${xmlNode('subsonic-response',output)}`,
    {status:200,headers:{'content-type':format==='json'?'application/json; charset=utf-8':'application/xml; charset=utf-8',...NO_STORE}});
}
const protoError=(code,message,format)=>protocolResponse({}, {code,message},format);
async function readParams(req,url){
  const params=new URLSearchParams(url.search);
  if(req.method==='POST'){
    if(Number(req.headers.get('content-length')||0)>16384)throw Error('Form too large');
    const type=(req.headers.get('content-type')||'').split(';')[0];
    if(type!=='application/x-www-form-urlencoded')throw Error('Expected application/x-www-form-urlencoded');
    const text=await req.text();if(text.length>16384)throw Error('Form too large');
    for(const [k,v] of new URLSearchParams(text))params.set(k,v);
  }
  return params;
}
async function authenticate(params,env,req){
  const DB=env.DB,key=clean(params.get('apiKey'),100);
  const username=clean(params.get('u'),32).toLowerCase();
  // Username and IP limit buckets are hashed before persistence; the throttle
  // never stores raw credentials, passwords, or client IP addresses.
  const address=clean(req.headers.get('cf-connecting-ip')||req.headers.get('x-real-ip')||'unknown',90);
  const bucket=await digest('mobile-limit-v1:'+(username?'u:'+username:'ip:'+address));
  const now=Date.now(),period=15*60*1000,maxFailures=12;
  let guard;
  try{guard=await DB.prepare('SELECT failures,window_started FROM mobile_auth_limits WHERE bucket=?').bind(bucket).first();}
  catch(e){
    // Existing v16 installations may receive API traffic before an admin ever
    // opens Account Settings. Install this additive table lazily on first use.
    if(!/no such table.*mobile_auth_limits/i.test(String(e?.message||'')))throw e;
    await DB.prepare('CREATE TABLE IF NOT EXISTS mobile_auth_limits (bucket TEXT PRIMARY KEY, window_started INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0)').run();
    guard=null;
  }
  if(guard && now-Number(guard.window_started)<period && Number(guard.failures)>=maxFailures)
    return {error:{code:40,message:'Too many failed mobile logins. Try again in 15 minutes.'}};
  const onFailure=async()=>{
    await DB.prepare(`INSERT INTO mobile_auth_limits(bucket,window_started,failures) VALUES(?,?,1)
      ON CONFLICT(bucket) DO UPDATE SET
      failures=CASE WHEN ?-window_started>=? THEN 1 ELSE failures+1 END,
      window_started=CASE WHEN ?-window_started>=? THEN ? ELSE window_started END`)
      .bind(bucket,now,now,period,now,period,now).run();
  };
  let row;
  if(key){
    row=await DB.prepare(`SELECT k.id,k.user_id,u.username FROM mobile_bridge_keys k JOIN user_accounts u ON u.id=k.user_id WHERE k.key_hash=?`).bind(await digest(key)).first();
  }else {
    const username=clean(params.get('u'),32);
    if(!username)return {error:{code:40,message:'Username required'}};
    const candidates=(await DB.prepare(`SELECT k.id,k.user_id,k.key_hash,k.secret_cipher,u.username FROM mobile_bridge_keys k JOIN user_accounts u ON u.id=k.user_id WHERE u.username=? COLLATE NOCASE LIMIT 10`).bind(username).all()).results;
    const p=params.get('p'),token=clean(params.get('t'),64),salt=clean(params.get('s'),128);
    if(p!==null){
      let pass=p;
      if(pass.startsWith('enc:')){
        const h=pass.slice(4);if(h.length>256||h.length%2||!/^[0-9a-f]+$/i.test(h))return {error:{code:40,message:'Invalid encoded app password'}};
        pass=dec.decode(unhex(h));
      }
      const hash=await digest(pass);
      row=candidates.find(x=>same(x.key_hash,hash));
    }else if(token && salt && /^[a-f0-9]{32}$/i.test(token)){
      for(const candidate of candidates){
        const secret=await unseal(env,candidate.secret_cipher);
        if(secret && same(legacyMd5(secret+salt),token.toLowerCase())){row=candidate;break;}
      }
    }else return {error:{code:41,message:'Use a mobile API key or app password'}};
  }
  if(!row){await onFailure();return {error:{code:40,message:'Invalid or revoked mobile credentials'}};}
  // Throttle D1 writes: no DB update on every audio range request.
  return {id:row.id,userId:row.user_id,username:row.username};
}
// IDs are stable within each WASP installation and do not contain peer URLs.
// Double FNV-1a hash avoids huge UTF-8 artist/album identifiers.
function compactId(tag,value){
  const s=encoder.encode(value);let a=2166136261,b=0x811c9dc5;
  for(const c of s){a=Math.imul(a^c,16777619)>>>0;b=Math.imul(b^(c+31),2246822519)>>>0;}
  return tag+':'+a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0');
}
function normalize(v){return clean(v,200).toLowerCase().replace(/\s+/g,' ');}
function dedupKey(t){return [normalize(t.artist),normalize(t.title),normalize(t.album),Math.round(Number(t.duration)||0)].join('\0');}
const LIMIT=6500;
const originKey=(origin,id)=>origin+'\0'+id;
const cleanGenres=arr=>Array.isArray(arr)?arr.filter(x=>typeof x==='string').map(x=>clean(x,80)).filter(Boolean).slice(0,6):[];
export async function readVirtualLibrary(DB){
  const local=(await DB.prepare(`SELECT id,title,artist,album,track_no,duration,size,plays,created_at FROM tracks ORDER BY created_at DESC LIMIT ${LIMIT}`).all()).results;
  const tracks=[],seen=new Map(),peerPlaylists=[],playlistIds=new Set(),byOrigin=new Map(),aliases=new Map();
  const federated=await readFederatedCatalogue(DB);
  const authorizedOrigins=new Set(federated.map(x=>x.origin));
  const gatewayPeers=(await DB.prepare('SELECT p.id,p.url FROM peers p JOIN peer_catalogue_cache c ON c.peer_id=p.id WHERE c.synced_at>0 ORDER BY p.added_at LIMIT 15').all()).results;
  for(const p of gatewayPeers)authorizedOrigins.add(p.url);
  const preferredSource=(t,origin,remoteId)=>({origin,remoteId,peerId:t.peerId||''});
  function add(t,opts={}){
    const sourceId=String(t?.id||'');if(!t||! /^[\w-]{1,120}$/.test(sourceId))return null;
    const origin=opts.origin||'',peerId=opts.peerId||'',sourceKey=originKey(origin,sourceId);
    const id=!origin?`l:${sourceId}`:opts.federated?`f:${compactId('o',origin)}:${sourceId}`:`p:${peerId}:${sourceId}`;
    const song={id,sourceId,peerId,origin,
      title:clean(t.title,200)||'Unknown Track',artist:clean(t.artist,200)||'Unknown Artist',album:clean(t.album,200)||'Unknown Album',
      genre:clean(t.genre,80),track:n(t.track_no??t.track,0,999),duration:Math.max(0,Number(t.duration)||0),
      size:Math.max(0,Number(t.size)||0),plays:Math.max(0,Number(t.plays)||0),created_at:Math.max(0,Number(t.created_at)||0),alternatives:[]};
    const key=dedupKey(song);
    if(seen.has(key)){
      const canonical=seen.get(key);
      if(origin && !canonical.alternatives.some(x=>x.origin===origin&&x.remoteId===sourceId) && !(canonical.origin===origin&&canonical.sourceId===sourceId))
        canonical.alternatives.push(preferredSource(song,origin,sourceId));
      byOrigin.set(sourceKey,canonical);aliases.set(id,canonical);return canonical;
    }
    seen.set(key,song);tracks.push(song);aliases.set(id,song);byOrigin.set(sourceKey,song);return song;
  }
  for(const t of local)add(t);
  function takePlaylists(rows,kind,origin,peerId,namespace){
    for(const pl of (Array.isArray(rows)?rows:[]).slice(0,MAX_PLAYLISTS)){
      if(!pl || !/^[\w-]{1,120}$/.test(String(pl.id||'')) || !Array.isArray(pl.tracks) || (kind==='users'&&!pl.is_public))continue;
      const id=namespace==='direct'?`vp:${peerId}:${pl.id}${kind==='users'?':user':''}`:
        `vf:${compactId('o',origin)}:${pl.id}${kind==='users'?':user':''}`;
      if(playlistIds.has(id))continue;
      playlistIds.add(id);
      peerPlaylists.push({id,origin,peerId,name:clean(pl.name,80)||'WASP peer playlist',
        owner:kind==='users'?clean(pl.username,80)||'WASP member':'WASP peer',created_at:Number(pl.created_at)||0,
        tracks:pl.tracks.slice(0,1500),track_sources:pl.track_sources||{},
        remoteId:String(pl.id),peerKind:kind,coverUrl:clean(pl.cover_url,600)});
    }
  }
  const MAX_PLAYLISTS=500;
  for(const p of gatewayPeers){
    const chunks=(await DB.prepare("SELECT body FROM peer_catalogue_chunks WHERE peer_id=? AND kind='tracks' ORDER BY shard").bind(p.id).all()).results;
    for(const chunk of chunks){
      let list;try{list=JSON.parse(chunk.body);}catch{continue;}
      if(Array.isArray(list))for(const t of list.slice(0,LIMIT))add(t,{origin:p.url,peerId:p.id});
    }
    for(const kind of ['playlists','users']){
      const parts=(await DB.prepare('SELECT body FROM peer_catalogue_chunks WHERE peer_id=? AND kind=? ORDER BY shard').bind(p.id,kind).all()).results;
      for(const part of parts){
        let list;try{list=JSON.parse(part.body);}catch{continue;}
        takePlaylists(list,kind,p.url,p.id,'direct');
      }
    }
  }
  for(const source of federated){
    // Federated endpoints are obtained only from already trusted gateway
    // snapshots and must use publicly routable HTTPS URLs.
    if(!publicPeerOrigin(source.origin))continue;
    for(const t of source.tracks.slice(0,LIMIT))add(t,{origin:source.origin,peerId:source.gatewayId,federated:true});
    for(const kind of ['playlists','users'])takePlaylists(source[kind],kind,source.origin,source.gatewayId,'federated');
  }
  // Genres are optional metadata. Do not invent a genre for uncategorized music.
  const genresByArtist=new Map();
  try{
    const rows=(await DB.prepare("SELECT name,genres FROM artist_info WHERE genres!='[]'").all()).results;
    for(const r of rows){let list=[];try{list=JSON.parse(r.genres);}catch{}
      if(Array.isArray(list))genresByArtist.set(normalize(r.name),cleanGenres(list));}
  }catch{} // legacy test installations without optional artist metadata
  for(const source of federated)for(const [name,list] of Object.entries(source.genres||{})){
    if(Array.isArray(list)&&list.length)genresByArtist.set(normalize(name),cleanGenres(list));
  }
  for(const t of tracks){
    if(!t.genre)t.genre=genresByArtist.get(normalize(t.artist))?.[0]||'';
  }
  const artists=new Map(),albums=new Map(),byId=new Map();
  for(const t of tracks){
    const aid=compactId('a',normalize(t.artist));
    const bid=compactId('b',normalize(t.artist)+'\0'+normalize(t.album));
    t.artistId=aid;t.albumId=bid;
    if(!artists.has(aid))artists.set(aid,{id:aid,name:t.artist,albums:new Set()});
    artists.get(aid).albums.add(bid);
    if(!albums.has(bid))albums.set(bid,{id:bid,name:t.album,artist:t.artist,artistId:aid,songs:[],created_at:0});
    const album=albums.get(bid);album.songs.push(t);album.created_at=Math.max(album.created_at,t.created_at);
    byId.set(t.id,t);
  }
  for(const [id,t] of aliases)byId.set(id,t);
  return {tracks,byId,byOrigin,authorizedOrigins,artists,albums,peerPlaylists};
}
// Short-lived isolate cache avoids rereading large v15 peer snapshots for
// every Subsonic /stream range request. No credentials are cached here.
const virtualCache=new WeakMap();
async function libraryForRequest(DB){
  const prior=virtualCache.get(DB),now=Date.now();
  if(prior && now-prior.time<10000)return prior.promise;
  const promise=readVirtualLibrary(DB);
  virtualCache.set(DB,{time:now,promise});
  try{return await promise;}catch(e){virtualCache.delete(DB);throw e;}
}
function songBase(t){return {id:t.id,parent:t.albumId,isDir:false,title:t.title,album:t.album,artist:t.artist,
  artistId:t.artistId,albumId:t.albumId,track:t.track||1,discNumber:1,duration:Math.round(t.duration),size:Math.round(t.size),
  suffix:'mp3',contentType:'audio/mpeg',type:'music',isVideo:false,coverArt:t.id,...(t.genre?{genre:t.genre}:{}),
  ...(t.created_at?{created:new Date(t.created_at).toISOString()}:{}),playCount:t.plays};}
function albumOut(a){return {id:a.id,name:a.name,artist:a.artist,artistId:a.artistId,songCount:a.songs.length,duration:Math.round(a.songs.reduce((s,t)=>s+t.duration,0)),
  ...(a.created_at?{created:new Date(a.created_at).toISOString()}:{}),coverArt:a.songs[0]?.id};}
const artistOut=a=>({id:a.id,name:a.name,albumCount:a.albums.size,coverArt:'ar:'+a.id});
const accountVoteId=userId=>'account:'+userId;
const peerReactionId=async t=>'peer-'+await digest(t.origin+'\n'+t.sourceId);
// The same physical record can have more than one peer source. Account stars
// are scoped to this server and never sent as mutations to an upstream peer.
async function readAccountStars(DB,userId,catalogue){
  const rows=(await DB.prepare(`SELECT r.track_id,p.origin,p.remote_id FROM user_song_reactions r
    LEFT JOIN peer_reaction_tracks p ON p.id=r.track_id
    WHERE r.user_id=? AND r.kind='heart' LIMIT 5000`).bind(userId).all()).results||[];
  const ids=new Set();
  for(const r of rows){
    const song=r.origin?catalogue.byOrigin.get(r.origin+'\0'+r.remote_id):catalogue.byId.get('l:'+r.track_id);
    if(song)ids.add(song.id);
  }
  return ids;
}

const listSlice=(xs,params,prefix='',limit=300)=>{
  const offset=n(params.get(prefix?prefix+'Offset':'offset'),0,100000);
  const count=n(params.get(prefix?prefix+'Count':'size'),prefix?20:10,limit);
  return xs.slice(offset,offset+count);
};
function respondForSong(catalogue,id){return catalogue.byId.get(clean(id,240));}
function mimeResponse(res,head=false){
  const headers=new Headers(NO_STORE);
  for(const k of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']){
    const value=res.headers.get(k);if(value)headers.set(k,value);
  }
  headers.set('accept-ranges','bytes');
  return new Response(head?null:res.body,{status:res.status,headers});
}
async function audio(req,env,t){
  if(!t)return new Response('Track unavailable',{status:404,headers:NO_STORE});
  // Same-origin redirect intentionally delegates folder-* files to Docker's
  // existing gateway and R2 files to the existing /audio/ handler. No app
  // secret is appended to the destination URL.
  if(!t.peerId)return Response.redirect(new URL('/audio/'+encodeURIComponent(t.sourceId),req.url),req.method==='POST'?303:307);
  if(!/^https?:\/\//.test(t.origin))return new Response('Peer unavailable',{status:502,headers:NO_STORE});
  const h=new Headers();for(const k of ['range','if-range'])if(req.headers.has(k))h.set(k,req.headers.get(k));
  const sources=[{origin:t.origin,remoteId:t.sourceId},...(t.alternatives||[])].filter(x=>x.origin);
  for(const source of sources){
    // Never forward incoming cookies, device tokens or Authorization headers.
    const peerUrl=source.origin.replace(/\/$/,'')+'/audio/'+encodeURIComponent(source.remoteId);
    let response;try{response=await fetch(peerUrl,{method:req.method==='HEAD'?'HEAD':'GET',headers:h,redirect:'manual',signal:AbortSignal.timeout(20000)});}
    catch{continue;}
    if([200,206,416].includes(response.status))return mimeResponse(response,req.method==='HEAD');
  }
  return new Response('Peer stream unavailable',{status:502,headers:NO_STORE});
}
async function art(req,env,t){
  if(!t)return new Response(null,{status:404,headers:NO_STORE});
  const path='/art/track?id='+encodeURIComponent(t.sourceId);
  if(!t.peerId)return Response.redirect(new URL(path,req.url),302);
  let response;try{response=await fetch(t.origin.replace(/\/$/,'')+path,{redirect:'manual',signal:AbortSignal.timeout(8000)});}
  catch{return new Response(null,{status:502,headers:NO_STORE});}
  if(!response.ok || !/^image\/(jpeg|png|webp|gif)$/i.test((response.headers.get('content-type')||'').split(';')[0]))
    return new Response(null,{status:404,headers:NO_STORE});
  return new Response(response.body,{headers:{...NO_STORE,'content-type':response.headers.get('content-type')}});
}
// OpenSubsonic playlist artwork: the native WASP server's covers are still
// authoritative. No third-party URLs or mobile credentials are sent to peers.
const ART_TYPES=/^image\/(?:jpeg|png|webp|gif)$/i;
function imageMime(response){return (response.headers.get('content-type')||'').split(';')[0].trim();}
async function savedPlaylistArt(env,key,head=false){
  const object=await env.MUSIC?.get(key);
  if(!object)return null;
  const headers=new Headers(NO_STORE);
  object.writeHttpMetadata?.(headers);
  const type=imageMime({headers});
  if(!ART_TYPES.test(type))return null;
  return new Response(head?null:object.body,{status:200,headers});
}
function safeRemoteCover(origin,source){
  if(!/^https?:\/\//i.test(origin||''))return null;
  let base;try{base=new URL(origin);}catch{return null;}
  if(base.username||base.password||base.search||base.hash)return null;
  const raw=String(source.coverUrl||'');
  if(raw){
    let candidate;try{candidate=new URL(raw,base);}catch{return null;}
    // Use the artwork route only; never follow an untrusted image host.
    if(/^\/art\/user-playlist\/[\w-]+$/.test(candidate.pathname) ||
       (candidate.pathname==='/art/playlist' && /^[\w-]{1,120}$/.test(candidate.searchParams.get('id')||''))){
      return new URL(candidate.pathname+candidate.search,base).href;
    }
  }
  if(source.peerKind==='playlists'&&/^[\w-]{1,120}$/.test(source.remoteId||''))
    return new URL('/art/playlist?id='+encodeURIComponent(source.remoteId),base).href;
  return null;
}
async function playlistArt(req,env,playlist){
  const source=playlist.coverSource;
  if(!source)return new Response(null,{status:404,headers:NO_STORE});
  if(source.kind==='server' && source.custom){
    const result=await savedPlaylistArt(env,'art/playlist/'+source.id,req.method==='HEAD');
    if(result)return result;
  }
  if(source.kind==='user' && source.custom){
    const result=await savedPlaylistArt(env,'art/user-playlist/'+source.id,req.method==='HEAD');
    if(result)return result;
  }
  if(source.kind==='peer'){
    const endpoint=safeRemoteCover(source.origin,source);
    if(endpoint){
      try{
        const result=await fetch(endpoint,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(8000)});
        if(result.status===200 && ART_TYPES.test(imageMime(result))){
          return new Response(req.method==='HEAD'?null:result.body,{status:200,headers:{...NO_STORE,'content-type':imageMime(result)}});
        }
      }catch{} // Image is optional; songs and peer playlist contents still work.
    }
  }
  // Covers without an uploaded image (including a webapp-generated mosaic)
  // fall back to the first playable song's existing WASP artwork.
  if(playlist.raw?.length)return art(req,env,playlist.raw[0]);
  return new Response(null,{status:404,headers:NO_STORE});
}

// Artist cover endpoint: only names present in the shared virtual catalogue
// are eligible. It accepts no remote URLs and never forwards authentication.
async function mobileArtistCover(req,env,catalogue,artistId){
  const a=catalogue.artists.get(artistId);
  if(!a)return new Response(null,{status:404,headers:NO_STORE});
  const songs=catalogue.tracks.filter(t=>t.artistId===artistId);
  const local=songs.find(t=>!t.peerId);
  if(local){
    return Response.redirect(new URL('/art/artist?name='+encodeURIComponent(a.name),req.url),302);
  }
  for(const t of songs.filter(t=>t.peerId && catalogue.authorizedOrigins.has(t.origin)).slice(0,3)){
    try{
      const upstream=t.origin.replace(/\/$/,'')+'/art/artist?name='+encodeURIComponent(a.name);
      const result=await fetch(upstream,{redirect:'manual',signal:AbortSignal.timeout(7000)});
      const mime=(result.headers.get('content-type')||'').split(';')[0].trim();
      if(result.ok && ART_TYPES.test(mime))return new Response(req.method==='HEAD'?null:result.body,{headers:{...NO_STORE,'content-type':mime}});
    }catch{}
  }
  return songs.length?art(req,env,songs[0]):new Response(null,{status:404,headers:NO_STORE});
}
export async function handleMobileArtistImage(req,env,url){
  if(!['GET','HEAD'].includes(req.method))return new Response(null,{status:405});
  if(!(await enabled(env.DB)))return new Response(null,{status:404});
  const id=clean(url.searchParams.get('id'),100);
  if(!/^a:[a-f0-9]{16}$/.test(id))return new Response(null,{status:404});
  const catalogue=await libraryForRequest(env.DB);
  return mobileArtistCover(req,env,catalogue,id);
}
export async function handleMobileRest(req,env,url,options={}){
  if(!['GET','HEAD','POST'].includes(req.method))return new Response('Method not allowed',{status:405,headers:NO_STORE});
  if(!(await enabled(env.DB)))return new Response('WASP Mobile Bridge is disabled',{status:503,headers:NO_STORE});
  let p;try{p=await readParams(req,url);}catch(e){return protoError(0,e.message,'xml');}
  const format=p.get('f')==='json'?'json':'xml';
  const action=url.pathname.replace(/^\/(?:mobile\/)?rest\//,'').replace(/\.view$/,'');
  // Return a structured protocol error instead of accidentally routing to
  // existing WASP endpoints if a mobile client requests an unknown operation.
  // This extension discovery endpoint must be accessible even without a token.
  if(action==='getOpenSubsonicExtensions')return protocolResponse({openSubsonicExtensions:[{name:'apiKeyAuthentication',versions:[1]}]},null,format);
  const auth=await authenticate(p,env,req);
  if(auth.error)return protocolResponse({},auth.error,format);
  if(action==='ping')return protocolResponse({},null,format);
  if(action==='getLicense')return protocolResponse({license:{valid:true}},null,format);
  if(action==='tokenInfo')return protocolResponse({tokenInfo:{username:auth.username}},null,format);
  let catalogue;
  try{catalogue=await libraryForRequest(env.DB);}catch{return protoError(0,'Unable to read music catalogue',format);}
  const {tracks,albums,artists}=catalogue;
  // Fetch account hearts only for browse endpoints. Audio byte-range requests
  // must not incur an extra D1 read for every seek/buffer operation.
  const browseWithStars=/^(?:getSong|getAlbum|getMusicDirectory|getStarred2?|search[23]?|getAlbumList2?|getRandomSongs|getTopSongs|getSongsByGenre|getPlaylist)$/.test(action);
  let starIds=new Set();
  if(browseWithStars)try{starIds=await readAccountStars(env.DB,auth.userId,catalogue);}catch(e){console.warn('Mobile stars unavailable',e?.message);}
  const songOut=t=>({...songBase(t),...(starIds.has(t.id)?{starred:new Date(0).toISOString()}:{})});
  const publicImage=a=>new URL('/mobile/artist-image?id='+encodeURIComponent(a.id),url).href;
  const fullArtist=a=>({...artistOut(a),artistImageUrl:publicImage(a)});
  const folderView=makeMobileFolders(catalogue);
  if(action==='getMusicFolders')return protocolResponse({musicFolders:{musicFolder:folderView.folders}},null,format);
  const scoped=folderView.roots.get(clean(p.get('musicFolderId'))) || folderView.roots.get('1');
  const visibleTracks=p.has('musicFolderId')?scoped.songs:tracks;
  const visibleArtists=new Set(visibleTracks.map(x=>x.artistId));
  const visibleAlbums=new Set(visibleTracks.map(x=>x.albumId));
  const sortedArtists=[...artists.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const sortedAlbums=[...albums.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const id=clean(p.get('id'),240);
  if(action==='getArtists'||action==='getIndexes'){
    const grouped=new Map();for(const a of sortedArtists.filter(x=>visibleArtists.has(x.id))){const letter=/^[a-z]/i.test(a.name)?a.name[0].toUpperCase():'#';
      if(!grouped.has(letter))grouped.set(letter,[]);grouped.get(letter).push(fullArtist(a));}
    const index=[...grouped].map(([name,artist])=>({name,artist}));
    return protocolResponse(action==='getArtists'?{artists:{index,ignoredArticles:'The El La Los Las'}}:{indexes:{index,ignoredArticles:'The El La Los Las'}},null,format);
  }
  if(action==='getArtist'){
    const a=artists.get(id);if(!a)return protoError(70,'Artist not found',format);
    return protocolResponse({artist:{...fullArtist(a),album:[...a.albums].map(aid=>albumOut(albums.get(aid))).sort((x,y)=>x.name.localeCompare(y.name))}},null,format);
  }
  if(action==='getAlbum'){
    const a=albums.get(id);if(!a)return protoError(70,'Album not found',format);
    return protocolResponse({album:{...albumOut(a),song:a.songs.map(songOut)}},null,format);
  }
  if(action==='getSong'){
    const song=respondForSong(catalogue,id);if(!song)return protoError(70,'Song not found',format);
    return protocolResponse({song:songOut(song)},null,format);
  }
  if(action==='getMusicDirectory'){
    const source=folderView.roots.get(id);
    if(source){
      const index=folderArtistIndex(source.songs);
      return protocolResponse({directory:{id,name:source.name,child:[...index.values()].sort((a,b)=>a.name.localeCompare(b.name))
        .map(a=>({id:`fa:${id}:${a.id}`,parent:id,title:a.name,artist:a.name,isDir:true,coverArt:a.songs[0]?.id}))}},null,format);
    }
    const virtual=folderView.parse(id);
    if(virtual){
      const folderId=virtual.folder.id;
      const index=folderArtistIndex(virtual.folder.songs,virtual.type==='fa'?virtual.id:undefined);
      if(virtual.type==='fa'){
        const artist=index.get(virtual.id);
        if(!artist)return protoError(70,'Music directory not found',format);
        return protocolResponse({directory:{id,name:artist.name,child:[...artist.albums.values()].map(album=>({
          id:`fb:${folderId}:${album.id}`,parent:id,title:album.name,artist:artist.name,isDir:true,coverArt:album.songs[0]?.id
        }))}},null,format);
      }
      const album=[...index.values()].flatMap(a=>[...a.albums.values()]).find(a=>a.id===virtual.id);
      if(!album)return protoError(70,'Music directory not found',format);
      return protocolResponse({directory:{id,name:album.name,child:album.songs.map(songOut)}},null,format);
    }
    if(artists.has(id)){
      const a=artists.get(id);return protocolResponse({directory:{id,name:a.name,child:[...a.albums].map(x=>({...albumOut(albums.get(x)),isDir:true}))}},null,format);
    }
    if(albums.has(id)){
      const a=albums.get(id);return protocolResponse({directory:{id,name:a.name,child:a.songs.map(songOut)}},null,format);
    }
    return protoError(70,'Music directory not found',format);
  }
  if(action==='getGenres'){
    const counts=new Map();
    for(const t of tracks)if(t.genre){const key=normalize(t.genre);const x=counts.get(key)||{value:t.genre,songCount:0,albumIds:new Set()};
      x.songCount++;x.albumIds.add(t.albumId);counts.set(key,x);}
    return protocolResponse({genres:{genre:[...counts.values()].sort((a,b)=>a.value.localeCompare(b.value))
      .map(({value,songCount,albumIds})=>({value,songCount,albumCount:albumIds.size}))}},null,format);
  }
  if(action==='search3'||action==='search2'||action==='search'){
    const query=normalize(p.get('query'));
    const songHits=visibleTracks.filter(t=>!query||[t.title,t.artist,t.album].some(s=>normalize(s).includes(query)));
    const artistHits=sortedArtists.filter(a=>visibleArtists.has(a.id)&&!query||normalize(a.name).includes(query));
    const albumHits=sortedAlbums.filter(a=>visibleAlbums.has(a.id)&&!query||[a.name,a.artist].some(s=>normalize(s).includes(query)));
    const result={artist:listSlice(artistHits,p,'artist',250).map(fullArtist),album:listSlice(albumHits,p,'album',250).map(albumOut),song:listSlice(songHits,p,'song',500).map(songOut)};
    const key=action==='search3'?'searchResult3':action==='search2'?'searchResult2':'searchResult';
    return protocolResponse({[key]:result},null,format);
  }
  if(['getAlbumList2','getAlbumList','getRandomSongs','getTopSongs'].includes(action)){
    if(action==='getRandomSongs'){
      return protocolResponse({randomSongs:{song:[...tracks].sort(()=>Math.random()-.5).slice(0,n(p.get('size'),30,100)).map(songOut)}},null,format);
    }
    if(action==='getTopSongs')return protocolResponse({topSongs:{song:tracks.filter(x=>normalize(x.artist)===normalize(p.get('artist'))).sort((a,b)=>b.plays-a.plays).slice(0,30).map(songOut)}},null,format);
    const type=p.get('type')||'alphabeticalByName';const rows=sortedAlbums.filter(a=>visibleAlbums.has(a.id));
    if(type==='newest'||type==='recent')rows.sort((a,b)=>b.created_at-a.created_at);
    else if(type==='frequent')rows.sort((a,b)=>b.songs.reduce((s,x)=>s+x.plays,0)-a.songs.reduce((s,x)=>s+x.plays,0));
    else if(type==='random')rows.sort(()=>Math.random()-.5);
    else if(type==='alphabeticalByArtist')rows.sort((a,b)=>a.artist.localeCompare(b.artist)||a.name.localeCompare(b.name));
    return protocolResponse({[action==='getAlbumList'?'albumList':'albumList2']:{album:listSlice(rows,p,'',500).map(albumOut)}},null,format);
  }
  if(action==='getPlaylists'||action==='getPlaylist'){
    const playlists=await readMobilePlaylists(env.DB,catalogue,auth);
    if(action==='getPlaylists')return protocolResponse({playlists:{playlist:playlists.rows.map(({raw,kind,coverSource,...metadata})=>metadata)}},null,format);
    const playlist=playlists.find(id);
    if(!playlist)return protoError(70,'Playlist not found or private',format);
    const {raw,kind,coverSource,...metadata}=playlist;
    return protocolResponse({playlist:{...metadata,entry:raw.map(songOut)}},null,format);
  }
  if(action==='getStarred2'||action==='getStarred'){
    const list=tracks.filter(t=>starIds.has(t.id)).map(songOut);
    return protocolResponse({[action==='getStarred'?'starred':'starred2']:{artist:[],album:[],song:list}},null,format);
  }
  if(action==='getNowPlaying')return protocolResponse({nowPlaying:{entry:[]}},null,format);
  if(action==='getUser'){
    const wanted=clean(p.get('username'),32);if(wanted && wanted.toLowerCase()!==auth.username.toLowerCase())return protoError(50,'Not authorized',format);
    return protocolResponse({user:{username:auth.username,email:'',scrobblingEnabled:true,adminRole:false,settingsRole:false,downloadRole:true,uploadRole:false,playlistRole:true,coverArtRole:true,commentRole:false,podcastRole:false,streamRole:true,jukeboxRole:false,shareRole:false,folder:folderView.folders.map(x=>x.id)}},null,format);
  }
  if(action==='getArtistInfo'||action==='getArtistInfo2'){
    const artist=artists.get(id);
    if(!artist)return protoError(70,'Artist not found',format);
    const publicImageUrl=publicImage(artist);
    let bio=null;
    // Use the same native WASP Wikipedia/cache implementation as the web
    // player. The callback can start a lookup when a local biography is empty.
    if(typeof options.getBiography==='function'){
      try{bio=await options.getBiography(artist.name);}catch{}
    }
    // If this server has no biography, ask at most two trusted music peers.
    // Never send mobile passwords, cookies or other request headers.
    if(!bio?.text){
      const origins=[...new Set(tracks.filter(t=>t.artistId===id&&t.origin&&
        catalogue.authorizedOrigins.has(t.origin)).map(t=>t.origin))].slice(0,2);
      for(const origin of origins){
        try{
          const endpoint=origin.replace(/\/$/,'')+'/api/bio?name='+encodeURIComponent(artist.name);
          const r=await fetch(endpoint,{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(6000)});
          if(!r.ok)continue;
          const d=await r.json();if(typeof d?.text==='string'&&d.text.trim()){bio=d;break;}
        }catch{};
      }
    }
    return protocolResponse({[action==='getArtistInfo'?'artistInfo':'artistInfo2']:{
      biography:clean(bio?.text,12000),musicBrainzId:'',
      smallImageUrl:publicImageUrl,mediumImageUrl:publicImageUrl,largeImageUrl:publicImageUrl
    }},null,format);
  }
  if(action==='getAlbumInfo'||action==='getAlbumInfo2')return protocolResponse({[action==='getAlbumInfo'?'albumInfo':'albumInfo2']:{notes:'',musicBrainzId:''}},null,format);
  if(action==='getSongsByGenre'){
    const genre=normalize(p.get('genre'));
    return protocolResponse({songsByGenre:{song:visibleTracks.filter(t=>genre&&normalize(t.genre)===genre)
      .slice(n(p.get('offset'),0,100000),n(p.get('offset'),0,100000)+n(p.get('count'),10,500)).map(songOut)}},null,format);
  }
  if(action==='getScanStatus')return protocolResponse({scanStatus:{scanning:false}},null,format);
  if(action==='getLyrics'||action==='getLyricsBySongId'){
    // Lyrics are an optional compatibility function. Do not initiate remote
    // writes on a source peer simply to discover metadata in staging.
    return protocolResponse(action==='getLyrics'?{lyrics:{artist:clean(p.get('artist')),title:clean(p.get('title'))}}:{lyricsList:{structuredLyrics:[]}},null,format);
  }
  if(action==='stream'||action==='download'){
    const track=respondForSong(catalogue,id);
    const response=await audio(req,env,track);
    // Only actual authenticated stream GETs, never HEAD or downloads. A
    // successful local redirect or remote 200/206 gives a bounded presence
    // signal even if the client never sends Subsonic playback-start scrobbles.
    // Status is approximate: Subsonic does not standardize pause/stop events.
    if(action==='stream'&&req.method==='GET'&&[200,206,307].includes(response.status)){
      try{await recordMobilePlayback(env.DB,auth,track);}catch{} // Live status must never interrupt playback.
    }
    return response;
  }
  if(action==='getCoverArt'){
    if(id.startsWith('ar:'))return mobileArtistCover(req,env,catalogue,id.slice(3));
    if(id.startsWith('pl:')){
      const playlists=await readMobilePlaylists(env.DB,catalogue,auth);
      const playlist=playlists.find(id.slice(3));
      return playlist?playlistArt(req,env,playlist):new Response(null,{status:404,headers:NO_STORE});
    }
    return art(req,env,respondForSong(catalogue,id)||albums.get(id)?.songs[0]||artists.get(id)&&albums.get([...artists.get(id).albums][0])?.songs[0]);
  }
  if(action==='scrobble'){
    // Only submitted *completed* listens count; client-side playback start is
    // not proof of listening. Peer sources are never written to by this API.
    if(['false','0'].includes(p.get('submission'))){
      // Subsonic clients may report a playback start without a confirmed play.
      // Record anonymous live presence; never increment play counts here.
      const startedTrack=respondForSong(catalogue,id);
      if(startedTrack){try{await recordMobilePlayback(env.DB,auth,startedTrack);}catch{}}
      return protocolResponse({},null,format);
    }
    const track=respondForSong(catalogue,id);
    if(!track)return protoError(70,'Song not found',format);
    const played=Date.now();
    const reported=Number(p.get('time'));
    // A client may resend a completed-listen notification after reconnecting.
    // Accept sane client-provided timestamps; otherwise dedupe the same device
    // and song within a 30-second window in staging's own database.
    const stamp=Number.isFinite(reported)&&reported>played-30*86400000&&reported<played+60000?Math.floor(reported):played;
    const recent=await env.DB.prepare('SELECT 1 FROM mobile_scrobble_events WHERE credential_id=? AND track_id=? AND reported_at>? LIMIT 1').bind(auth.id,track.id,stamp-30000).first();
    if(recent)return protocolResponse({},null,format);
    const receipt=await env.DB.prepare('INSERT OR IGNORE INTO mobile_scrobble_events(credential_id,track_id,reported_at) VALUES(?,?,?)').bind(auth.id,track.id,stamp).run();
    if(Number(receipt.meta?.changes ?? receipt.changes ?? 0)===0)return protocolResponse({},null,format);
    await env.DB.prepare(`INSERT INTO recent_listens(id,track_id,origin,remote_id,title,artist,album,played_at)
      VALUES(?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),track.sourceId,track.origin,track.peerId?track.sourceId:'',track.title,track.artist,track.album,played).run();
    // Anonymous confirmed Subsonic scrobble; no credential ID is federated.
    try{await recordTelemetryListen(env,{track_id:track.sourceId,title:track.title,artist:track.artist,album:track.album,duration:track.duration,played_at:played});}
    catch(e){console.warn('Mobile telemetry recording unavailable:',e.message);}
    if(track.peerId){await env.DB.prepare(`INSERT INTO peer_listens(origin,remote_id,plays) VALUES(?,?,1)
      ON CONFLICT(origin,remote_id) DO UPDATE SET plays=plays+1`).bind(track.origin,track.sourceId).run();}
    else await env.DB.prepare('UPDATE tracks SET plays=plays+1 WHERE id=?').bind(track.sourceId).run();
    return protocolResponse({},null,format);
  }
  if(action==='star'||action==='unstar'){
    const rawIds=p.getAll('id');
    if(!rawIds.length)return protoError(10,'Song ID required',format);
    const songs=rawIds.slice(0,40).map(x=>respondForSong(catalogue,x));
    if(songs.some(t=>!t))return protoError(70,'Song not found',format);
    const on=action==='star';
    for(const t of songs){
      const voteId=t.peerId?await peerReactionId(t):t.sourceId;
      // Include an origin-specific peer identity, but never contact the peer
      // to write a heart. The shared WASP account owns the reaction locally.
      const batch=[];
      if(t.peerId)batch.push(env.DB.prepare(`INSERT OR IGNORE INTO peer_reaction_tracks
        (id,origin,remote_id,created_at,title,artist,album,duration,cover_url)
        VALUES(?,?,?,?,?,?,?,?,?)`).bind(voteId,t.origin,t.sourceId,Date.now(),t.title,t.artist,t.album,t.duration,''));
      if(on){
        batch.push(env.DB.prepare("INSERT OR IGNORE INTO user_song_reactions(user_id,track_id,kind) VALUES(?,?,'heart')").bind(auth.userId,voteId));
        batch.push(env.DB.prepare("INSERT OR IGNORE INTO reactions(track_id,voter,kind) VALUES(?,?,'heart')").bind(voteId,accountVoteId(auth.userId)));
      }else{
        batch.push(env.DB.prepare("DELETE FROM user_song_reactions WHERE user_id=? AND track_id=? AND kind='heart'").bind(auth.userId,voteId));
        batch.push(env.DB.prepare("DELETE FROM reactions WHERE track_id=? AND voter=? AND kind='heart'").bind(voteId,accountVoteId(auth.userId)));
      }
      await env.DB.batch(batch);
    }
    return protocolResponse({},null,format);
  }
  return protoError(0,'Endpoint not supported by WASP Mobile Bridge v16 staging',format);
}
