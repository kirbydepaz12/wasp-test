import {ensureAdminOperations, startAdminOperation, finishAdminOperation, clearAdminLog, readAdminLog, parseAdminCursor, readAdminProcesses} from './admin-operations.js';
import {metadataAdmin, metadataFeed, runMetadata, rememberFileFacts, rememberPicardFacts} from './hive-metadata.js';
import {metadataBankApi} from './metadata-bank.js';
import {RELEASE_DOCS} from "./release-docs.js";
import {requireNoRedirect} from './peer-fetch.js';
import {ensureHiveRequests,publishHiveRequest,reconcileLocalRequestEvents,syncHiveRequests,
  hiveRequestFeed,hiveRequestsForDisplay,dismissHiveRequests,originStatus,reviewRemoteRequest,remoteRequestRow} from "./hive-requests.js";
import {recordTelemetryListen, rememberTrackMetadata, syncTelemetryPeers, telemetryApi, ensureTelemetrySchema as ensureTelemetrySchemaForMetadata} from "./telemetry.js";
import {handleMobileRest, handleMobileArtistImage, manageMobileBridge, ensureMobileSchema} from "./mobile-bridge.js";
import {syncFederatedFromGateway, ensureFederationSchema} from "./mobile-federation.js";
import {extractEmbeddedArt, MAX_ID3_ART_READ, MAX_EMBEDDED_IMAGE} from "./embedded-art.js";
import {RELEASE_SOURCES,fetchUpstream,releaseDecision} from "./release-updates.js";
import {BUILD_COMMIT} from "./build-commit.js";
// Music app Worker: public listening + admin management.
// Storage: R2 (mp3 files + artwork, binding MUSIC) and D1 (library, playlists, reactions, admin hash, sessions, binding DB).

// Salted PBKDF2 hash of the first-time admin password. Change it from the admin page after first login.
const BUILD_VERSION = "18.1.5a";
const BUILD_LABEL = "PC Picard Metadata Pull Hotfix";
const DEFAULT_SALT = "9756e918a7545f9eec461ee48491018a";
const DEFAULT_HASH = "539db4ea2054366abc97375b551b16c115622e1a89b8f9cf75cea28345c6ba26";

const ITER = 100000; // Workers' maximum for PBKDF2
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_UPLOAD = 100 * 1024 * 1024;
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));

async function pbkdf2(pw, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: unhex(saltHex), iterations: ITER }, key, 256);
  return hex(bits);
}
async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
const clean = (v, max = 200) => String(v ?? "").trim().slice(0, max);

// v14: only public, session-independent JSON is eligible for shared caching.
// Cache API entries are regional and expire automatically. Login, account,
// private playlist, lyric requests, and admin responses are NEVER cached here.
const PUBLIC_CACHE_TTLS = Object.freeze({
  "/api/tracks": 45,
  "/api/playlists": 45,
  "/api/user-playlists": 45,
  "/api/site": 120,
  "/api/entity-reactions": 5,
  "/api/track-reaction-counts": 5,
  "/api/recent-listens": 10,
});
const CACHE_REV = "wasp-v15-0-6";
const publicRevision = url => /^[a-f0-9-]{1,40}$/i.test(url.searchParams.get("v") || "") ? url.searchParams.get("v") : "";
const cacheFor = (req, url) => req.method === "GET" && (!url.search || (url.searchParams.size===1 && !!publicRevision(url))) && PUBLIC_CACHE_TTLS[url.pathname]
  ? (typeof caches !== "undefined" && caches.default ? caches.default : null) : null;
const cachedKey = url => new Request(`${url.origin}${url.pathname}?__wasp_cache=${CACHE_REV}&v=${publicRevision(url)}`);
async function cachedPublicResponse(req, url) {
  const cache=cacheFor(req,url);
  if (!cache) return null;
  try {
    const hit=await cache.match(cachedKey(url));
    if (!hit) return null;
    const h=new Headers(hit.headers);h.set("x-wasp-cache","HIT");
    return new Response(hit.body,{status:hit.status,headers:h});
  } catch {return null;}
}
async function storePublicResponse(req,url,res,ctx) {
  const cache=cacheFor(req,url), ttl=PUBLIC_CACHE_TTLS[url.pathname];
  if (!cache || !ttl || !res.ok || res.headers.has("set-cookie")) return res;
  const h=new Headers(res.headers);
  // Browsers must revalidate; Cloudflare's edge can reuse the public JSON.
  h.set("cache-control",`public, max-age=0, s-maxage=${ttl}`);
  h.set("x-wasp-cache","MISS");
  const output=new Response(res.body,{status:res.status,statusText:res.statusText,headers:h});
  const job=cache.put(cachedKey(url),output.clone()).catch(()=>{});
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return output;
}
function invalidatePublicCache(req,url,res,ctx) {
  if(req.method === "GET" || !res.ok || typeof caches === "undefined" || !caches.default) return;
  const path=url.pathname;
  const paths=new Set();
  if(path === "/api/internal/folder-index" || path.startsWith("/api/admin/tracks/") || path === "/api/admin/upload" || path === "/api/admin/clean") paths.add("/api/tracks");
  if(path.startsWith("/api/admin/playlists") || path === "/api/admin/clean") paths.add("/api/playlists");
  if(path.startsWith("/api/user/playlists") || path === "/api/admin/clean") paths.add("/api/user-playlists");
  if(path === "/api/admin/settings" || path === "/api/admin/favicon" || path === "/api/admin/brand-image") paths.add("/api/site");
  if(path === "/api/admin/network") {
    for(const p of Object.keys(PUBLIC_CACHE_TTLS)) paths.add(p);
  }
  if(!paths.size) return;
  const jobs=[...paths].map(p=>caches.default.delete(cachedKey(new URL(p,url.origin))).catch(()=>{}));
  if(ctx?.waitUntil) ctx.waitUntil(Promise.all(jobs));
}


// CORS for peer network: when sharing is on, public library endpoints are readable by other instances.
const CORS_PEER = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type, range, x-visitor",
  "access-control-expose-headers": "content-range, content-length, accept-ranges, etag",
  "access-control-max-age": "86400",
};
async function isSharing(DB) {
  try {
    const row = await DB.prepare("SELECT value FROM settings WHERE key = 'network_share'").first();
    return row?.value === "1";
  } catch { return false; }
}
function withCors(res, share) {
  if (!share) return res;
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_PEER)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}


const COMMUNITY_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS user_peer_permissions (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS user_published_peers (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,url TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',track_count INTEGER NOT NULL DEFAULT 0,last_ok INTEGER,last_error TEXT,last_checked INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(user_id,url))",
  "CREATE INDEX IF NOT EXISTS idx_user_peers_owner ON user_published_peers(user_id)",
  "CREATE TABLE IF NOT EXISTS user_voter_tokens (user_id TEXT NOT NULL,voter TEXT NOT NULL,PRIMARY KEY(user_id,voter))",
  "CREATE TABLE IF NOT EXISTS user_publish_requests (user_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS user_publish_approval_notices (user_id TEXT PRIMARY KEY, approved_at INTEGER NOT NULL, viewed_at INTEGER NOT NULL DEFAULT 0)",
];
async function upgradeCommunitySchema(DB) {
  for (const sql of COMMUNITY_SCHEMA) await DB.prepare(sql).run();
  await DB.prepare("INSERT INTO settings(key,value) VALUES('wasp_schema_version','15.3') ON CONFLICT(key) DO UPDATE SET value='15.3'").run();
}
// Independent additive migration: do not re-run community upgrades or rewrite
// an existing library just to add short-lived anonymous streaming presence.
async function upgradeActiveStreamsSchema(DB) {
  const marker=await DB.prepare("SELECT value FROM settings WHERE key='wasp_live_streams_schema'").first();
  if(marker?.value==='2')return;
  // Preserve v15.0.7 active sessions; add a stable start timestamp so the
  // 30 newest songs are ranked by the moment a stream began, NOT its heartbeat.
  await DB.prepare(`CREATE TABLE IF NOT EXISTS active_streams (
    session_id TEXT PRIMARY KEY, origin TEXT NOT NULL DEFAULT '', track_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL, started_at INTEGER NOT NULL DEFAULT 0)`).run();
  const columns=(await DB.prepare('PRAGMA table_info(active_streams)').all()).results;
  if(!columns.some(c=>c.name==='started_at'))
    await DB.prepare('ALTER TABLE active_streams ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0').run();
  await DB.prepare('CREATE INDEX IF NOT EXISTS idx_active_streams_expiry ON active_streams(expires_at)').run();
  await DB.prepare("INSERT INTO settings(key,value) VALUES('wasp_live_streams_schema','2') ON CONFLICT(key) DO UPDATE SET value='2'").run();
}
// Renewed every 25 seconds by an *actually playing* WASP audio element.
// Expiration is intentionally short so a crashed browser cannot show as live.
const STREAM_TTL_MS = 65000;
// Explicit per-user overrides win over the global default. A missing row means
// "inherit global" so newly registered accounts receive the current default.
const PUBLISH_DEFAULT_SQL = "COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='user_publish_default'),0)";
const EFFECTIVE_PUBLISH_SQL = `COALESCE(p.enabled,${PUBLISH_DEFAULT_SQL})`;
async function globalPublishDefault(DB) {
  return Number((await DB.prepare("SELECT value FROM settings WHERE key='user_publish_default'").first())?.value||0)===1;
}
async function userMayPublish(DB,userId) {
  const row=await DB.prepare(`SELECT COALESCE((SELECT enabled FROM user_peer_permissions WHERE user_id=?),${PUBLISH_DEFAULT_SQL}) AS enabled`).bind(userId).first();
  return !!row?.enabled;
}
async function createPublishApprovalNotice(DB,userId) {
  await DB.prepare(`INSERT INTO user_publish_approval_notices(user_id,approved_at,viewed_at) VALUES(?,?,0)
    ON CONFLICT(user_id) DO UPDATE SET approved_at=excluded.approved_at,viewed_at=0`).bind(userId,Date.now()).run();
}
async function approvePublishRequest(DB,userId) {
  const pending=await DB.prepare('SELECT user_id FROM user_publish_requests WHERE user_id=?').bind(userId).first();
  if(!pending)return false;
  await DB.batch([
    DB.prepare('DELETE FROM user_publish_requests WHERE user_id=?').bind(userId),
    DB.prepare(`INSERT INTO user_publish_approval_notices(user_id,approved_at,viewed_at) VALUES(?,?,0)
      ON CONFLICT(user_id) DO UPDATE SET approved_at=excluded.approved_at,viewed_at=0`).bind(userId,Date.now()),
  ]);
  return true;
}
// User-contributed URLs must not reach Tailscale, localhost, cloud metadata, or
// Docker's internal services. Administrator-managed peers retain their own policy.
function publicWaspOrigin(input) {
  if(typeof input!=='string'||input.length>250)throw Error('Use a publicly reachable HTTPS WASP hostname.');
  let u;try{u=new URL(input.trim());}catch{throw Error('Enter a full HTTPS link.');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||
     (u.pathname!=='/'&&u.pathname!==''))throw Error('Use only the HTTPS homepage URL (without a path, port, or credentials).');
  const h=u.hostname.toLowerCase().replace(/\.$/,'');
  if(!h.includes('.')||h.length>253||!h.split('.').every(p=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))||
     /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan)$/.test(h)||
     /^\d+\.\d+\.\d+\.\d+$/.test(h)||h.includes(':')||h.endsWith('.arpa'))
    throw Error('Only public DNS hostnames are allowed for user-published peers.');
  return 'https://'+h;
}
function publicIPAddress(address) {
  if(/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const n=address.split('.').map(Number);
    if(n.some(v=>v<0||v>255))return false;
    const [a,b,c]=n;
    return a>=1&&a<224&&a!==10&&a!==127&&a!==0&&
      !(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&
      !(a===172&&b>=16&&b<=31)&&!(a===192&&(b===0||b===168||b===88&&c===99||b===0&&c===2))&&
      !(a===198&&(b===18||b===19||b===51&&c===100))&&
      !(a===203&&b===0&&c===113);
  }
  // Global-unicast IPv6 only; exclude documentation and special-use blocks.
  if(address.includes(':'))return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  return false;
}
async function publicPeerDNS(hostname) {
  // Check DNS A and AAAA answers before making a user-requested server-side
  // request. A host that resolves to private, loopback or link-local space is
  // rejected. The network administrator should additionally restrict egress;
  // DNS can change between this check and the TLS connection.
  let current=hostname;
  for(let depth=0;depth<4;depth++) {
    const answers=await Promise.all(['A','AAAA'].map(async type=>{
      const q=new URL('https://cloudflare-dns.com/dns-query');
      q.searchParams.set('name',current);q.searchParams.set('type',type);
      const r=await fetch(q.href,{redirect:'manual',headers:{accept:'application/dns-json'},signal:AbortSignal.timeout(4000)});
      if(!r.ok)return null;
      const v=await r.json().catch(()=>null);
      return v&&v.Status===0&&Array.isArray(v.Answer||[]) ? v.Answer||[] : null;
    }));
    if(answers.some(a=>!a))return false;
    const rows=answers.flat(),addresses=rows.filter(r=>r.type===1||r.type===28).map(r=>String(r.data||''));
    if(addresses.length)return addresses.every(publicIPAddress);
    const cname=rows.find(r=>r.type===5)?.data;
    if(!cname)return false;
    try {current=new URL(publicWaspOrigin('https://'+String(cname).replace(/\.$/,''))).hostname;}
    catch{return false;}
  }
  return false;
}
async function probeCommunityPeer(origin) {
  try {
    if(!(await publicPeerDNS(new URL(origin).hostname)))return {online:false,error:'Peer hostname is not publicly reachable'};
    const r=await fetch(origin+'/api/peer',{redirect:'manual',signal:AbortSignal.timeout(6000),
      headers:{accept:'application/json'}});
    if(!r.ok||r.status>=300)return {online:false,error:'Peer unavailable'};
    const size=Number(r.headers.get('content-length')||0);
    if(size>8192)return {online:false,error:'Invalid peer response'};
    const reader=r.body?.getReader(),parts=[];let total=0;
    if(!reader)return {online:false,error:'Empty peer response'};
    while(true){const {done,value}=await reader.read();if(done)break;
      total+=value.byteLength;if(total>8192){await reader.cancel().catch(()=>{});return {online:false,error:'Peer response too large'};}
      parts.push(value);
    }
    const bytes=new Uint8Array(total);let offset=0;
    for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
    let j;try{j=JSON.parse(new TextDecoder().decode(bytes));}catch{return {online:false,error:'Invalid peer response'};}
    if(j?.ok!==true||!Number.isFinite(Number(j.tracks))||Number(j.tracks)<0||Number(j.tracks)>10000000)
      return {online:false,error:'Not a sharing WASP server'};
    return {online:true,name:clean(j.name||j.title||'WASP',80),tracks:Math.floor(Number(j.tracks))};
  }catch{return {online:false,error:'Peer unreachable'};}
}
async function refreshCommunityHealth(DB,limit=60) {
  const entries=(await DB.prepare(`SELECT l.id,l.url FROM user_published_peers l
    LEFT JOIN user_peer_permissions p ON p.user_id=l.user_id WHERE ${EFFECTIVE_PUBLISH_SQL}=1
    ORDER BY l.last_checked ASC LIMIT ?`).bind(limit).all()).results;
  // Limit concurrent network fetches to avoid overwhelming the Worker and D1.
  for(let i=0;i<entries.length;i+=5) await Promise.all(entries.slice(i,i+5).map(async entry=>{
    const status=await probeCommunityPeer(entry.url);
    await DB.prepare(`UPDATE user_published_peers SET name=CASE WHEN ?!='' THEN ? ELSE name END,
      track_count=CASE WHEN ? THEN ? ELSE track_count END,
      last_ok=CASE WHEN ? THEN ? ELSE last_ok END,last_error=?,last_checked=? WHERE id=?`)
      .bind(status.name||'',status.name||'',status.online?1:0,status.tracks||0,status.online?1:0,Date.now(),
        status.online?null:status.error,Date.now(),entry.id).run();
  }));
}
async function knownPeer(DB,origin) {
  return !!((await DB.prepare('SELECT 1 FROM peers WHERE url=?').bind(origin).first()) ||
    (await DB.prepare(`SELECT 1 FROM user_published_peers l LEFT JOIN user_peer_permissions p
      ON p.user_id=l.user_id WHERE ${EFFECTIVE_PUBLISH_SQL}=1 AND l.url=? AND l.last_error IS NULL AND l.last_ok IS NOT NULL LIMIT 1`).bind(origin).first()));
}
// Browser and Mobile Bridge use the same stable account vote identity.
const accountReactionVoter = info => 'account:'+info.user_id;
async function recordSignedInVoter(DB,info,voter) {
  if(info?.role==='user'&&info.user_id)
    await DB.prepare('INSERT OR IGNORE INTO user_voter_tokens(user_id,voter) VALUES(?,?)').bind(info.user_id,voter).run();
}

const initialized = new WeakSet();
async function init(env) {
  if(initialized.has(env.DB))return;
  await (async () => {
    const q = (s) => env.DB.prepare(s);
    // v14: migration work is one-time. A new Worker isolate checks one indexed
    // settings row instead of trying dozens of CREATE/ALTER statements.
    let marker;
    try {marker=await q("SELECT value FROM settings WHERE key = 'wasp_schema_version'").first();}
    catch {await q("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)").run();}
    // v15.0.1 repair: repair both v14.0.3 and installations already marked v15.
    // v15 repair: v14.0.3 incorrectly passed two SQL strings to prepare().
    // The second (peer_catalogue_chunks) was silently discarded, while the
    // schema marker was still advanced. Always repair real tables independently
    // even for already-upgraded v14.3 installations; never reset user data.
    const additive = [
      "CREATE TABLE IF NOT EXISTS peer_listens(origin TEXT NOT NULL,remote_id TEXT NOT NULL,plays INTEGER NOT NULL DEFAULT 0,synced_plays INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(origin,remote_id))",
      "CREATE TABLE IF NOT EXISTS peer_catalogue_cache (peer_id TEXT PRIMARY KEY, tracks TEXT NOT NULL DEFAULT '[]', playlists TEXT NOT NULL DEFAULT '[]', users TEXT NOT NULL DEFAULT '[]', revision TEXT NOT NULL DEFAULT '', synced_at INTEGER NOT NULL DEFAULT 0)",
      "CREATE TABLE IF NOT EXISTS peer_catalogue_chunks (peer_id TEXT NOT NULL,kind TEXT NOT NULL,shard INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(peer_id,kind,shard))",
            "CREATE TABLE IF NOT EXISTS recent_listens (id TEXT PRIMARY KEY, track_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT '', remote_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '', cover_url TEXT NOT NULL DEFAULT '', played_at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_recent_listens_time ON recent_listens(played_at DESC)",
      "CREATE TABLE IF NOT EXISTS file_fingerprints (track_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, mtime_ms INTEGER NOT NULL DEFAULT 0, source_path TEXT NOT NULL DEFAULT '', scanned_at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_file_fingerprints_hash ON file_fingerprints(sha256)",
    ];
    if (["14","14.2","14.3","15"].includes(marker?.value)) {
      for (const sql of additive) await q(sql).run();
      // The older schema also needs the created_at lookup index.
      await q("CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at DESC)").run();
      // Advance only after every required DDL operation succeeds.
      await upgradeCommunitySchema(env.DB);
      await upgradeActiveStreamsSchema(env.DB);
      return;
    }
    if(marker?.value === "15.3"){await upgradeActiveStreamsSchema(env.DB);return;}
    if(marker?.value === "15.2") {await upgradeCommunitySchema(env.DB);await upgradeActiveStreamsSchema(env.DB);return;}
    if(marker?.value === "15.1") {await upgradeCommunitySchema(env.DB);await upgradeActiveStreamsSchema(env.DB);return;}
    // Multiple Cloudflare isolates may start together across data centers.
    // A D1-backed lease prevents simultaneous backfills and repeated index
    // builds from multiplying the free-tier writes on initial deployment.
    const lease=String(Date.now()+90000);
    let claimed=false;
    try {
      const lock=await q(`INSERT INTO settings(key,value) VALUES('wasp_v14_migration_lease',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        WHERE CAST(settings.value AS INTEGER) < ?`).bind(lease,Date.now()).run();
      claimed=Number(lock.meta?.changes ?? lock.changes ?? 0)>0;
      if(!claimed) {
        for(let attempt=0;attempt<20;attempt++) {
          await new Promise(resolve=>setTimeout(resolve,500));
          const marker=await q("SELECT value FROM settings WHERE key = 'wasp_schema_version'").first();
          if(marker?.value === "15.3") return;
        }
        throw new Error("A WASP database migration is still running. Please retry shortly.");
      }
    } catch(e) {throw e;}
    try {
    // Another isolate may have completed the migration after our first check
    // but before this isolate acquired the released lease.
    const afterLease=await q("SELECT value FROM settings WHERE key = 'wasp_schema_version'").first();
    if(afterLease?.value === "15.3") return;
    // Run each statement on its own. D1 batch() is atomic: one failure rolls the whole
    // batch back, so a hiccup on a new table/index during an upgrade used to take the
    // entire site down. Individual try/catch keeps the site up even if one step fails.
    const tables = [
      "CREATE TABLE IF NOT EXISTS admin (id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL)",
       "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS user_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS user_playlists (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(user_id, name))",
      "CREATE TABLE IF NOT EXISTS user_playlist_tracks (playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (playlist_id, track_id))",
      "CREATE TABLE IF NOT EXISTS playlist_hearts (playlist_id TEXT NOT NULL, voter TEXT NOT NULL, PRIMARY KEY (playlist_id, voter))",
      "CREATE TABLE IF NOT EXISTS peer_track_refs (ref TEXT PRIMARY KEY, origin TEXT NOT NULL, remote_id TEXT NOT NULL, title TEXT, artist TEXT, album TEXT, duration REAL)",
      "CREATE TABLE IF NOT EXISTS peer_listens (origin TEXT NOT NULL, remote_id TEXT NOT NULL, plays INTEGER NOT NULL DEFAULT 0, synced_plays INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(origin,remote_id))",
      "CREATE TABLE IF NOT EXISTS peer_catalogue_cache (peer_id TEXT PRIMARY KEY, tracks TEXT NOT NULL DEFAULT '[]', playlists TEXT NOT NULL DEFAULT '[]', users TEXT NOT NULL DEFAULT '[]', revision TEXT NOT NULL DEFAULT '', synced_at INTEGER NOT NULL DEFAULT 0)",
      "CREATE TABLE IF NOT EXISTS peer_catalogue_chunks (peer_id TEXT NOT NULL,kind TEXT NOT NULL,shard INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(peer_id,kind,shard))",
      "CREATE TABLE IF NOT EXISTS file_fingerprints (track_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, mtime_ms INTEGER NOT NULL DEFAULT 0, source_path TEXT NOT NULL DEFAULT '', scanned_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS recent_listens (id TEXT PRIMARY KEY, track_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT '', remote_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '', cover_url TEXT NOT NULL DEFAULT '', played_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, ts INTEGER NOT NULL)",
      `CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
        track_no INTEGER DEFAULT 0, duration REAL DEFAULT 0, size INTEGER DEFAULT 0,
        plays INTEGER DEFAULT 0, created_at INTEGER NOT NULL, hash TEXT)`,
      "CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS playlist_tracks (playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (playlist_id, track_id))",
      "CREATE TABLE IF NOT EXISTS reactions (track_id TEXT NOT NULL, voter TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (track_id, voter, kind))",
      "CREATE TABLE IF NOT EXISTS peer_reaction_tracks (id TEXT PRIMARY KEY, origin TEXT NOT NULL, remote_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(origin,remote_id))",
      "CREATE TABLE IF NOT EXISTS user_song_reactions (user_id TEXT NOT NULL, track_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(user_id, track_id, kind))",
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS spotify_credentials (id INTEGER PRIMARY KEY CHECK (id = 1), client_id TEXT NOT NULL, secret_cipher TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS entity_reactions (kind TEXT NOT NULL, entity TEXT NOT NULL, voter TEXT NOT NULL, reaction TEXT NOT NULL, PRIMARY KEY (kind, entity, voter, reaction))",
      // Non-destructive snapshot for peer playlists receiving local votes.
      "CREATE TABLE IF NOT EXISTS voted_playlist_cache (id TEXT PRIMARY KEY, origin TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'server', cover_url TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', track_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS artist_similar (name TEXT PRIMARY KEY, list TEXT NOT NULL, fetched_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS artist_info (name TEXT PRIMARY KEY, text TEXT, url TEXT, wtitle TEXT, rev TEXT, genres TEXT NOT NULL DEFAULT '[]', checked_at INTEGER NOT NULL)",
      `CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '',
        image TEXT, url TEXT, dedupe TEXT NOT NULL UNIQUE, voter TEXT NOT NULL, ip TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
        track_count INTEGER DEFAULT 0, last_ok INTEGER, last_error TEXT, added_at INTEGER NOT NULL)`,
    ];
    for (const sql of tables) {
      try { await q(sql).run(); } catch (e) { console.error("schema create failed:", e.message); }
    }
    try {
      await q("INSERT OR IGNORE INTO admin (id, salt, hash) VALUES ('admin', ?, ?)").bind(DEFAULT_SALT, DEFAULT_HASH).run();
    } catch (e) { console.error("admin seed failed:", e.message); }
    // Column upgrades (already-present columns just throw; ignore).
    try { await q("ALTER TABLE tracks ADD COLUMN hash TEXT").run(); } catch {}
    try { await q("ALTER TABLE tracks ADD COLUMN artists TEXT").run(); } catch {}
    try { await q("ALTER TABLE playlists ADD COLUMN cover_v INTEGER NOT NULL DEFAULT 0").run(); } catch {}
    try { await q("ALTER TABLE user_playlists ADD COLUMN cover_v INTEGER NOT NULL DEFAULT 0").run(); } catch {}
    try { await q("ALTER TABLE user_playlists ADD COLUMN cover_mode TEXT NOT NULL DEFAULT 'copied'").run(); } catch {}
    try { await q("ALTER TABLE peer_track_refs ADD COLUMN cover_url TEXT").run(); } catch {}
    // Non-destructive metadata cache for peer songs receiving local reactions.
    // It keeps ranking cards readable when the source peer is temporarily offline.
    for (const col of [
      "title TEXT NOT NULL DEFAULT ''", "artist TEXT NOT NULL DEFAULT ''",
      "album TEXT NOT NULL DEFAULT ''", "duration REAL NOT NULL DEFAULT 0",
      "cover_url TEXT NOT NULL DEFAULT ''"
    ]) try { await q(`ALTER TABLE peer_reaction_tracks ADD COLUMN ${col}`).run(); } catch {}

    for (const col of ["status TEXT NOT NULL DEFAULT 'active'", "done_at INTEGER", "meta TEXT", "playlist_id TEXT"])
      try { await q(`ALTER TABLE requests ADD COLUMN ${col}`).run(); } catch {}
    for (const col of ["kind TEXT", "members TEXT"])
      try { await q(`ALTER TABLE artist_info ADD COLUMN ${col}`).run(); } catch {}
    try { await q("ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'").run(); } catch {}
    try { await q("ALTER TABLE sessions ADD COLUMN user_id TEXT").run(); } catch {}
    try { await q("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_username', 'admin')").run(); } catch {}
    // WASP rebrand: update only old product defaults, never user-custom site names.
    try { await q("INSERT OR IGNORE INTO settings (key,value) VALUES ('site_name','WASP')").run(); } catch {}
    try { await q("UPDATE settings SET value = 'WASP' WHERE key = 'site_name' AND value IN ('Music','RiffVault','RiffVault 🎧')").run(); } catch {}
    try { await q("UPDATE settings SET value = 'WASP' WHERE key = 'tab_title' AND value IN ('Music','RiffVault','RiffVault 🎧')").run(); } catch {}
    // Unique index on hash: fails if the library already has duplicate file hashes.
    // Do not take the site down for that; upload logic still dedupes by checking the column.
    try { await q("CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_hash ON tracks(hash)").run(); } catch (e) {
      console.error("idx_tracks_hash skipped (likely duplicate hashes):", e.message);
    }
    try { await q("CREATE INDEX IF NOT EXISTS idx_reactions_track ON reactions(track_id)").run(); } catch {}
    // Preserve existing one-way playlist hearts in the unified local charts.
    // Namespaced voters avoid collisions with SHA-256 visitor IDs.
    try { await q("INSERT OR IGNORE INTO entity_reactions(kind,entity,voter,reaction) SELECT 'playlist', playlist_id, 'legacy:' || voter, 'heart' FROM playlist_hearts").run(); } catch {}
    // v14: materialized artist membership, indexed by exact normalized artist
    // and album. Built non-destructively from the existing catalogue, preserving
    // multi-artist collaboration names and existing tracks without rewrites.
    await q("CREATE TABLE IF NOT EXISTS track_artist_map (track_id TEXT NOT NULL, artist_key TEXT NOT NULL, album TEXT NOT NULL DEFAULT '', PRIMARY KEY(track_id, artist_key))").run();
    await q("CREATE INDEX IF NOT EXISTS idx_track_artist_lookup ON track_artist_map(artist_key, album)").run();
    await q("CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album)").run();
    await q("CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at DESC)").run();
    await q("CREATE INDEX IF NOT EXISTS idx_file_fingerprints_hash ON file_fingerprints(sha256)").run();
    await q("CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_added ON playlist_tracks(playlist_id,added_at)").run();
    await q("CREATE INDEX IF NOT EXISTS idx_user_playlist_tracks_playlist_added ON user_playlist_tracks(playlist_id,added_at)").run();
    if(afterLease?.value !== "14") await rebuildArtistMap(env.DB);
    // Only set the marker after all essential work succeeds; partial migrations
    // safely retry on the next cold start rather than hiding a missing index.
    await upgradeCommunitySchema(env.DB);
    await upgradeActiveStreamsSchema(env.DB);
    } finally {
      if(claimed) await q("DELETE FROM settings WHERE key='wasp_v14_migration_lease' AND value=?").bind(lease).run().catch(()=>{});
    }
  })();
  initialized.add(env.DB);
}

function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
async function session(req, env) {
  const t = getCookie(req, "sid");
  if (!t) return null;
  const h = await sha256(t);
  const row = await env.DB.prepare("SELECT token FROM sessions WHERE token = ? AND expires > ?").bind(h, Date.now()).first();
  return row ? h : null;
}
async function sessionInfo(req, env) {
  const token = await session(req, env);
  if (!token) return null;
  return await env.DB.prepare("SELECT token, role, user_id FROM sessions WHERE token = ? AND expires > ?").bind(token, Date.now()).first();
}
const cookie = (v, age, secure = true) => `sid=${v}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${age}`;

async function serveAudio(req, env, id) {
  const rangeHeader = req.headers.get("range");
  const obj = await env.MUSIC.get(id, rangeHeader ? { range: req.headers } : undefined);
  if (!obj) return new Response("Not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("content-type", "audio/mpeg");
  h.set("etag", obj.httpEtag);
  h.set("accept-ranges", "bytes");
  h.set("cache-control", "public, max-age=86400");
  let status = 200;
  if (rangeHeader && obj.range) {
    const r = obj.range;
    const offset = r.offset ?? obj.size - r.suffix;
    const length = r.length ?? obj.size - offset;
    h.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set("content-length", String(length));
    status = 206;
  } else {
    h.set("content-length", String(obj.size));
  }
  return new Response(req.method === "HEAD" ? null : obj.body, { status, headers: h });
}

// ---------- site settings (name, browser tab, icon, front-page ad) ----------
async function siteSettings(DB) {
  const rows = (await DB.prepare("SELECT key, value FROM settings").all()).results;
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    name: s.site_name || "WASP", title: s.tab_title || "", favicon: Number(s.favicon_v) || 0,
    show_brand_icon: s.show_brand_icon === "1",
    brand_mode: s.brand_mode === "image" ? "image" : "text",
    brand_v: Number(s.brand_v) || 0,
    sidebar: {enabled:s.sidebar_enabled==="1",bbcode:Object.prototype.hasOwnProperty.call(s,"sidebar_bbcode")?s.sidebar_bbcode:null,html:s.sidebar_html||""},
    ad: { enabled: s.ad_enabled === "1", html: s.ad_html || "", height: Number(s.ad_height) || 340 },
  };
}
async function serveFavicon(env) {
  const obj = await env.MUSIC.get("site/favicon");
  if (!obj) return new Response(null, { status: 404, headers: { "cache-control": "public, max-age=60" } });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("cache-control", "public, max-age=86400");
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox"); // an uploaded SVG can never run scripts
  return new Response(obj.body, { headers: h });
}

// ---------- artists ----------
// A song can have several artists ("The Interrupters, Rancid"). They are split on ; / , feat. ft. featuring vs,
// except for the names below, which really contain those characters. Add your own to KEEP if a name gets split wrongly
// (or fix a single song with Edit in the admin page). "&" and "and" are never split because they are usually part of a band name.
const KEEP = ["AC/DC", "Tyler, The Creator", "Earth, Wind & Fire", "Emerson, Lake & Palmer", "Peter, Paul and Mary",
  "Blood, Sweat & Tears", "Crosby, Stills, Nash & Young", "Crosby, Stills & Nash"];
const uniq = (list) => { const out = []; for (const p of list) if (p && !out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p); return out; };
function splitArtists(raw) {
  let s = String(raw ?? "").replace(/\0/g, ";");
  const hold = [];
  for (const k of KEEP) {
    s = s.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"), "gi"), (m) => { hold.push(m); return `\u0001${hold.length - 1}\u0001`; });
  }
  s = s.replace(/\(\s*(?:feat\.?|ft\.?|featuring)\s+([^)]*)\)/gi, ";$1");
  const parts = s.split(/\s*(?:[;\/,]|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+vs\.?\s+)\s*/i)
    .map((p) => p.replace(/\u0001(\d+)\u0001/g, (_, i) => hold[+i]).trim().slice(0, 200));
  const out = uniq(parts).slice(0, 8);
  return out.length ? out : [clean(raw) || "Unknown Artist"];
}
// typed by the admin: a ";" means "exactly these artists"
function artistsFromInput(str) {
  str = clean(str);
  if (str.includes(";")) { const a = uniq(str.split(";").map((x) => x.trim().slice(0, 200))).slice(0, 8); if (a.length) return a; }
  return splitArtists(str);
}
function artistsOfRow(r) {
  if (r.artists) { try { const a = Array.isArray(r.artists)?r.artists:JSON.parse(r.artists); if (Array.isArray(a) && a.length) return a; } catch {} }
  return splitArtists(r.artist);
}
function artistIndexStatements(DB, row) {
  const names=[...new Set(artistsOfRow(row).map(normArtist).filter(Boolean))];
  const statements=[DB.prepare("DELETE FROM track_artist_map WHERE track_id = ?").bind(row.id)];
  for(const key of names) statements.push(DB.prepare("INSERT OR REPLACE INTO track_artist_map(track_id,artist_key,album) VALUES (?,?,?)").bind(row.id,key,row.album || ""));
  return statements;
}
async function rebuildArtistMap(DB) {
  const {results}=await DB.prepare("SELECT id,artist,artists,album FROM tracks").all();
  // No changes to tracks and no deletions of music/playlist content.
  await DB.prepare("DELETE FROM track_artist_map").run();
  const values=[];
  for(const row of results) for(const key of new Set(artistsOfRow(row).map(normArtist).filter(Boolean))) {
    values.push([row.id,key,row.album||""]);
  }
  // Cloudflare D1 permits at most 100 bound parameters per statement.
  // Each artist mapping has three values; 30 rows = 90 bound parameters.
  // Use conservative batches to avoid production startup failures.
  const BATCH_ROWS=30;
  for(let i=0;i<values.length;i+=BATCH_ROWS) {
    const items=values.slice(i,i+BATCH_ROWS);
    await DB.prepare(`INSERT OR REPLACE INTO track_artist_map(track_id,artist_key,album) VALUES ${items.map(()=>"(?,?,?)").join(",")}`)
      .bind(...items.flat()).run();
  }
}
async function libraryHasArtist(DB, name, album = null) {
  const key=normArtist(name);
  if(!key) return false;
  const sql="SELECT 1 FROM track_artist_map WHERE artist_key = ?" + (album===null ? "" : " AND album = ?") + " LIMIT 1";
  return !!(await (album===null ? DB.prepare(sql).bind(key) : DB.prepare(sql).bind(key,album)).first());
}

// ---------- artwork ----------
// Artist/album/track artwork prefers existing custom covers, then online Deezer
// images; a missing/unavailable online result falls back to original MP3 APIC
// artwork (on R2 or, through Docker gateway, the read-only /music folder).
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const RETRY_MS = 7 * 24 * 3600 * 1000;
async function artKey(kind, artist, album = "") {
  return `art/${kind}/${(await sha256(norm(artist) + "|" + norm(album))).slice(0, 24)}`;
}
const similar = (a, b) => { a = norm(a); b = norm(b); return a && b && (a.includes(b) || b.includes(a)); };
async function deezerImage(kind, artist, album, title) {
  const bare = (s) => s.replace(/"/g, "");
  const q = kind === "album" ? `artist:"${bare(artist)}" album:"${bare(album)}"`
    : kind === "track" ? `artist:"${bare(artist)}" track:"${bare(title)}"` : artist;
  const res = await fetch(`${DZ}/search/${kind}?limit=10&q=${encodeURIComponent(q)}`, {
    headers: { "user-agent": "music-app" },
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error("deezer unavailable"); // rate limit etc: don't cache a miss
  if (kind === "artist") {
    const hit = pickDeezerArtist(data.data, artist);
    return hit && hit.picture_big && !hit.picture_big.includes("/artist//") ? hit.picture_big : null;
  }
  for (const r of data.data || []) {
    if (kind === "album" && normArtist(r.artist?.name) === normArtist(artist) && similar(r.title, album) && r.cover_big) return r.cover_big;
    if (kind === "track" && normArtist(r.artist?.name) === normArtist(artist) && similar(r.title, title) && r.album?.cover_big) return r.album.cover_big;
  }
  return null;
}
const noArt = (cache) => new Response(null, { status: 404, headers: { "cache-control": cache } });
// R2 keeps the original MP3 bytes. This bounded range reader recovers APIC
// frames from older uploads that never received a separate artwork object.
// It never rewrites the audio, and deliberately ignores Docker folder IDs:
// their images are served by the local gateway instead of Cloudflare R2.
async function r2Bytes(obj, limit) {
  if (!obj) return null;
  const bytes = new Uint8Array(await (typeof obj.arrayBuffer === "function"
    ? obj.arrayBuffer() : new Response(obj.body).arrayBuffer()));
  return bytes.length <= limit ? bytes : null;
}
async function embeddedPictureForTrack(env, id) {
  if (!/^[\w-]{1,64}$/.test(id) || id.startsWith("folder-")) return null;
  const key = `art/track/${id}`;
  const saved = await env.MUSIC.get(key);
  if (saved && ["embedded", "custom"].includes(saved.customMetadata?.source)) {
    const bytes = await r2Bytes(saved, MAX_EMBEDDED_IMAGE);
    if (bytes?.length) return { bytes, type: saved.httpMetadata?.contentType || "image/jpeg" };
  }
  // A separate miss marker avoids rereading a coverless MP3 for every album
  // tile. Older art/track "none" markers are NOT trusted: they predate APIC
  // extraction and may have hidden a real embedded cover.
  const missKey = `art/apic-miss/${id}`;
  const miss = await env.MUSIC.get(missKey);
  if (miss && Date.now() - Number(miss.customMetadata?.at || 0) < RETRY_MS) return null;
  const rememberMiss = () => env.MUSIC.put(missKey, "", {customMetadata:{source:"none",at:String(Date.now())}});
  try {
    const h = await r2Bytes(await env.MUSIC.get(id, { range: { offset: 0, length: 10 } }), 10);
    if (!h) return null; // a missing object is not proof that a file lacks art
    if (h.length < 10 || String.fromCharCode(...h.slice(0, 3)) !== "ID3") {await rememberMiss();return null;}
    const size = ((h[6]&127)<<21)|((h[7]&127)<<14)|((h[8]&127)<<7)|(h[9]&127);
    if (size <= 0 || size + 10 > MAX_ID3_ART_READ) {await rememberMiss();return null;}
    const data = await r2Bytes(await env.MUSIC.get(id, { range: { offset: 0, length: size + 10 } }), size + 10);
    if (!data) return null;
    const cover = extractEmbeddedArt(data);
    if (!cover) {await rememberMiss();return null;}
    await env.MUSIC.put(key, cover.bytes, {
      httpMetadata: { contentType: cover.type },
      customMetadata: { source: "embedded", at: String(Date.now()) },
    });
    return cover;
  } catch (error) {
    console.warn("Embedded artwork unavailable for track", id, error?.message);
    return null;
  }
}
async function embeddedFallbackForArt(env, kind, artist, album, id) {
  const candidates = [];
  if (kind === "track" && id) candidates.push(id);
  // The artist map also handles tracks credited to several artists. Limit
  // each lookup to avoid scanning a whole library on a cache miss.
  if (artist && !/^unknown/i.test(artist)) {
    const query = `SELECT t.id FROM track_artist_map a JOIN tracks t ON t.id=a.track_id
      WHERE a.artist_key = ? ${kind === "artist" ? "" : "AND t.album = ?"}
      ORDER BY t.created_at DESC LIMIT 16`;
    const args = kind === "artist" ? [normArtist(artist)] : [normArtist(artist), album];
    try {
      const rows = (await env.DB.prepare(query).bind(...args).all()).results;
      for (const row of rows || []) if (!candidates.includes(row.id)) candidates.push(row.id);
    } catch (error) { console.warn("Embedded artwork candidates unavailable", error?.message); }
  }
  for (const candidate of candidates) {
    const art = await embeddedPictureForTrack(env, candidate);
    if (art) return art;
  }
  return null;
}
async function serveArt(env, url) {
  const kind = url.pathname.slice(5); // album | artist | track | playlist
  const p = url.searchParams;
  if (kind === "playlist") {
    const id = clean(p.get("id"), 64);
    const obj = /^[\w-]+$/.test(id) ? await env.MUSIC.get(`art/playlist/${id}`) : null;
    if (!obj) return noArt("public, max-age=300");
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set("cache-control", "public, max-age=86400");
    return new Response(obj.body, { headers: h });
  }
  let artist, album = "", title = "", key, id = "";
  if (kind === "track") {
    id = clean(p.get("id"), 64);
    const t = /^[\w-]+$/.test(id) && await env.DB.prepare("SELECT artist, artists, title, album FROM tracks WHERE id = ?").bind(id).first();
    if (!t) return noArt("public, max-age=300");
    artist = artistsOfRow(t)[0]; title = t.title; album = t.album; key = `art/track/${id}`;
  } else {
    artist = clean(p.get(kind === "artist" ? "name" : "artist"));
    album = kind === "album" ? clean(p.get("album")) : "";
    if (!artist || /^unknown/i.test(artist) || (kind === "album" && (!album || /^unknown/i.test(album)))) return noArt("public, max-age=300");
    // Only look up things that exist in the library, so strangers can't trigger arbitrary lookups.
    const found = kind === "artist" ? await libraryHasArtist(env.DB, artist) : await libraryHasArtist(env.DB, artist, album);
    if (!found) return noArt("public, max-age=300");
    key = await artKey(kind, artist, album);
  }
  let obj = await env.MUSIC.get(key);
  const negativeRecent = obj?.customMetadata?.source === "none" && Date.now() - Number(obj.customMetadata.at) <= RETRY_MS;
  if (obj?.customMetadata?.source === "none") obj = null;
  if (!obj) {
    // Prefer the requested external cover, but ALWAYS attempt original MP3
    // embedded artwork when the online search is missing or unavailable.
    let src = null, onlineFailed = false;
    if (!negativeRecent && !/^unknown/i.test(artist)) {
      try { src = await deezerImage(kind, artist, album, title); }
      catch { onlineFailed = true; }
    }
    if (src) {
      try {
        const img = await fetch(src);
        const type = (img.headers.get("content-type") || "").split(";")[0];
        if (img.ok && /^image\/(jpeg|png|webp)$/.test(type)) {
          await env.MUSIC.put(key, await img.arrayBuffer(), {
            httpMetadata: { contentType: type }, customMetadata: { source: "deezer", at: String(Date.now()) },
          });
          obj = await env.MUSIC.get(key);
        } else onlineFailed = true;
      } catch { onlineFailed = true; }
    }
    if (!obj) {
      const embedded = await embeddedFallbackForArt(env, kind, artist, album, id);
      if (embedded) {
        await env.MUSIC.put(key, embedded.bytes, {
          httpMetadata: { contentType: embedded.type },
          customMetadata: { source: "embedded", at: String(Date.now()) },
        });
        obj = await env.MUSIC.get(key);
      }
    }
    if (!obj) {
      if (!negativeRecent && !onlineFailed)
        await env.MUSIC.put(key, "", { customMetadata: { source: "none", at: String(Date.now()) } });
      return noArt(onlineFailed ? "no-store" : "public, max-age=300");
    }
  }
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("cache-control", "public, max-age=3600");
  return new Response(obj.body, { headers: h });
}

// ---------- requests, suggestions, biographies ----------
let DZ = "https://api.deezer.com", WIKI = "https://en.wikipedia.org", WIKIDATA = "https://www.wikidata.org", SPOTIFY = "https://open.spotify.com", OVH = "https://api.lyrics.ovh"; // overridable with env vars for testing
const fold = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "");
// Cyrillic letters bands use as Latin lookalikes (Deezer lists the real Korn as "KoЯn").
const CYR_LOOKALIKE = {
  а: "a", А: "a", е: "e", Е: "e", о: "o", О: "o", р: "p", Р: "p", с: "c", С: "c",
  у: "y", У: "y", х: "x", Х: "x", і: "i", І: "i", ї: "i", Ї: "i", ј: "j", ѕ: "s",
  я: "r", Я: "r", в: "b", В: "b", н: "h", Н: "h", к: "k", К: "k", м: "m", М: "m", т: "t", Т: "t",
};
const foldLookalike = (s) => fold(s).replace(/[аАеЕоОрРсСуУхХіІїЇјѕяЯвВнНкКмМтТ]/g, (c) => CYR_LOOKALIKE[c] || c);
const normArtist = (s) => norm(foldLookalike(s));
const core = (s) => norm(fold(String(s ?? "").replace(/[(\[][^)\]]*[)\]]/g, " ").replace(/\s+-\s+.*$/, "")));
const same = (a, b) => { a = core(a); b = core(b); return !!a && a === b; };
const sameName = (a, b) => { a = core(a); b = core(b); return !!a && !!b && (a === b || a.startsWith(b + " ") || b.startsWith(a + " ")); };
// Prefer the Deezer artist whose name matches (incl. lookalikes) and who has the most fans — avoids tiny namesakes.
function pickDeezerArtist(list, name) {
  const want = normArtist(name);
  if (!want) return null;
  const hits = (list || []).filter((r) => r && normArtist(r.name) === want);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0));
  return hits[0];
}
const IMG_OK = /^https:\/\/([\w-]+\.)*(dzcdn\.net|scdn\.co|spotifycdn\.com|wikimedia\.org)\//;
const safeImage = (u) => (typeof u === "string" && IMG_OK.test(u) && !u.includes("/artist//") ? u : null);
const UA = { "user-agent": "music-app/1.0 (personal music site on Cloudflare Workers)", accept: "application/json" };

async function suggest(url) {
  const type = url.searchParams.get("type"), q = clean(url.searchParams.get("q"), 80);
  const ep = { song: "track", artist: "artist", album: "album" }[type];
  if (!ep || q.length < 2) return json([]);
  let d;
  try {
    const res = await fetch(`${DZ}/search/${ep}?limit=8&q=${encodeURIComponent(q)}`, { headers: UA, cf: { cacheTtl: 600, cacheEverything: true } });
    d = await res.json();
    if (!res.ok || d.error) throw new Error("deezer");
  } catch { return json({ error: "Search is unavailable right now." }, 502); }
  return json((d.data || []).map((r) => type === "song"
    ? { id: r.id, title: r.title, sub: [r.artist?.name, r.album?.title].filter(Boolean).join(" · "), image: safeImage(r.album?.cover_medium) }
    : type === "album" ? { id: r.id, title: r.title, sub: r.artist?.name || "", image: safeImage(r.cover_medium) }
    : { id: r.id, title: r.name, sub: "Artist", image: safeImage(r.picture_medium) }));
}

// Names and images in a request always come from Deezer/Spotify, looked up by id on the server, never from the visitor.
async function deezerItem(kind, id) {
  const ep = { song: "track", artist: "artist", album: "album" }[kind];
  if (!ep || !/^\d{1,15}$/.test(id)) return null;
  const r = await fetch(`${DZ}/${ep}/${id}`, { headers: UA });
  const d = await r.json();
  if (!r.ok || d.error) return null;
  if (kind === "song") return { kind, title: clean(d.title), artist: clean(d.artist?.name), album: clean(d.album?.title), image: safeImage(d.album?.cover_medium), dedupe: `song|${core(d.artist?.name)}|${core(d.title)}` };
  if (kind === "album") return { kind, title: clean(d.title), artist: clean(d.artist?.name), album: "", image: safeImage(d.cover_medium), dedupe: `album|${core(d.artist?.name)}|${core(d.title)}` };
  return { kind, title: clean(d.name), artist: "", album: "", image: safeImage(d.picture_medium), dedupe: `artist|${core(d.name)}` };
}
const BROWSER_UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", accept: "text/html,application/json" };
function findKey(o, key, depth = 0) {
  if (!o || typeof o !== "object" || depth > 9) return undefined;
  if (Object.prototype.hasOwnProperty.call(o, key)) return o[key];
  for (const v of Object.values(o)) { const r = findKey(v, key, depth + 1); if (r !== undefined) return r; }
  return undefined;
}
// Spotify's official API no longer lets apps read other people's playlists, so the song list comes from the public embed page
// (name, picture and up to ~50-100 songs). That page is not an official API and can change, so every caller must cope with a failure.
async function spotifyEmbed(id) {
  const r = await fetch(`${SPOTIFY}/embed/playlist/${id}`, { headers: BROWSER_UA });
  if (!r.ok) throw new Error("spotify unavailable");
  const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("spotify page changed");
  const data = JSON.parse(m[1]);
  const list = findKey(data, "trackList");
  if (!Array.isArray(list)) throw new Error("spotify page changed");
  const tracks = list.map((x) => ({ t: clean(x.title, 200), a: clean(String(x.subtitle || "").replace(/\u00a0/g, " "), 200) })).filter((x) => x.t).slice(0, 1500);
  const sources = (findKey(data, "coverArt") || {}).sources || [];
  const best = [...sources].sort((p, q) => (q.width || 0) - (p.width || 0))[0];
  const entity = findKey(data, "entity") || {};
  // Only a count belonging to the Spotify playlist entity is evidence of its
  // full size. Do not use a recursively-found `total`: unrelated embed data
  // (e.g. image sources) may expose that same property name.
  const countCandidates = [entity.trackCount, entity.track_count,
    entity.tracks?.totalCount, entity.tracks?.total, entity.trackList?.totalCount];
  const sourceTotal = countCandidates.map(x => Number(x))
    .find(x => Number.isSafeInteger(x) && x >= tracks.length && x <= 100000);
  return { name: clean(entity.name || entity.title, 120), image: safeImage(best && best.url), tracks,
    sourceTotal: sourceTotal ?? null };
}
function playlistMeta(tracks, sourceTotal = null) {
  const count = sourceTotal !== null && sourceTotal !== '' ? Number(sourceTotal) : NaN;
  const trusted = Number.isSafeInteger(count) && count >= tracks.length && count <= 100000;
  const reported = trusted ? count : null;
  const source_status = trusted ? (count === tracks.length ? 'verified' : 'incomplete') : 'unverified';
  // Preserve prior behavior for short unverified embed lists; at Spotify's
  // 50/100-track boundaries the administrator must explicitly acknowledge
  // that Spotify may not have revealed the entire source playlist.
  const partial = source_status === 'incomplete' || (source_status === 'unverified' && tracks.length >= 50);
  return { total: tracks.length, partial, source_total: reported, source_status, tracks };
}
async function spotifyPlaylist(raw) {
  const m = raw.trim().match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{10,40})(?:[/?#].*)?$/);
  if (!m) return { error: "Paste the full Spotify playlist link, like https://open.spotify.com/playlist/…" };
  const link = `https://open.spotify.com/playlist/${m[1]}`;
  const [o, e] = await Promise.allSettled([
    fetch(`${SPOTIFY}/oembed?url=` + encodeURIComponent(link), { headers: UA }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json() : null })),
    spotifyEmbed(m[1]),
  ]);
  if (o.status === "fulfilled" && o.value.status === 404) return { error: "Spotify couldn't find that playlist. Make sure it is public." };
  const ov = o.status === "fulfilled" && o.value.body ? o.value.body : {}, ev = e.status === "fulfilled" ? e.value : null;
  const title = clean(ov.title, 120) || (ev && ev.name) || "Spotify playlist";
  const image = safeImage(ov.thumbnail_url) || (ev && ev.image) || null;
  return { kind: "playlist", title, artist: "", album: "", image, url: link, dedupe: `playlist|${m[1]}`, meta: ev && ev.tracks.length ? playlistMeta(ev.tracks, ev.sourceTotal) : null };
}
// v17.0.2: Spotify playlist recreation is an authenticated PRIVATE user
// workflow. Missing songs enter the ordinary federated request queue one by
// one, not as a public request for the whole playlist. Imported audio is never
// downloaded or duplicated; remote tracks retain their trusted peer origin.
const SPOTIFY_IMPORT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spotify_user_imports (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,playlist_id TEXT NOT NULL,
    spotify_url TEXT NOT NULL,cover_url TEXT NOT NULL DEFAULT '',
    tracks_json TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,
    partial INTEGER NOT NULL DEFAULT 0,matched INTEGER NOT NULL DEFAULT 0,
    local_count INTEGER NOT NULL DEFAULT 0,peer_count INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'draft',
    updated_at INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(user_id,spotify_url))`,
  'CREATE INDEX IF NOT EXISTS idx_spotify_user_imports_owner ON spotify_user_imports(user_id,state)'
];
const spotifyImportReady=new WeakSet();
async function ensureSpotifyImportSchema(DB){
  if(spotifyImportReady.has(DB))return;
  await (async()=>{for(const sql of SPOTIFY_IMPORT_SCHEMA)await DB.prepare(sql).run(); for(const col of ['missing_json TEXT','source_total INTEGER','completed_partial INTEGER NOT NULL DEFAULT 0','user_supplied_count INTEGER NOT NULL DEFAULT 0']){try{await DB.prepare('ALTER TABLE spotify_user_imports ADD COLUMN '+col).run();}catch(e){if(!/duplicate column/i.test(String(e.message)))throw e;}}})()
    ;
  spotifyImportReady.add(DB);
}
// Include both admin peers and approved user-submitted peers; only saved
// catalogue snapshots are trusted for adding peer-backed entries.
async function spotifyImportCatalogue(DB){
  const local=(await DB.prepare('SELECT id,title,artist,artists,album,duration FROM tracks').all()).results
    .map(t=>({...t,origin:''}));
  let shards=[];
  try{shards=(await DB.prepare(`SELECT p.url AS origin,c.body FROM peer_catalogue_chunks c
    JOIN peers p ON p.id=c.peer_id WHERE c.kind='tracks' AND p.last_error IS NULL
    UNION ALL SELECT u.url AS origin,c.body FROM peer_catalogue_chunks c
    JOIN user_published_peers u ON u.id=c.peer_id
    LEFT JOIN user_peer_permissions a ON a.user_id=u.user_id
    WHERE c.kind='tracks' AND COALESCE(a.enabled,
      (SELECT CAST(value AS INTEGER) FROM settings WHERE key='user_publish_default'),0)=1
      AND u.last_ok IS NOT NULL AND u.last_error IS NULL`).all()).results;}catch{}
  const remote=[];
  for(const shard of shards){
    try{const entries=JSON.parse(shard.body);if(!Array.isArray(entries))continue;
      for(const row of entries.slice(0,6000))if(row?.id&&row.title){
        remote.push({...row,origin:shard.origin,remote_id:String(row.id).slice(0,100)});
      }
    }catch{}
  }
  return {local,remote};
}
async function refreshSpotifyPeerCatalogue(env,{max=4,offset=null}={}){
  const DB=env.DB;
  let approved=[];
  try{approved=(await DB.prepare(`SELECT l.id,l.url FROM user_published_peers l
    LEFT JOIN user_peer_permissions p ON p.user_id=l.user_id
    WHERE COALESCE(p.enabled,(SELECT CAST(value AS INTEGER) FROM settings WHERE key='user_publish_default'),0)=1
      AND l.last_ok IS NOT NULL AND l.last_error IS NULL ORDER BY l.created_at LIMIT 50`).all()).results;}catch{}
  const admin=(await DB.prepare('SELECT id,url FROM peers ORDER BY added_at LIMIT 50').all()).results;
  const candidates=[...admin,...approved].filter(row=>row.url);
  const pos=offset===null?(Number((await DB.prepare("SELECT value FROM settings WHERE key='spotify_peer_cursor'").first())?.value)||0):Math.max(0,offset);
  let checked=0,updated=0,reachable=0;
  for(let i=0;i<Math.min(max,offset===null?candidates.length:Math.max(0,candidates.length-pos));i++){
    const peer=candidates[(pos+i)%candidates.length];checked++;
    try{
      if(approved.some(p=>p.id===peer.id) && !(await publicPeerDNS(new URL(peer.url).hostname)))continue;
      const version=requireNoRedirect(await fetch(peer.url+'/api/catalog-version',{signal:AbortSignal.timeout(6000),redirect:'manual'}));
      if(!version.ok)continue;
      reachable++;
      const rev=clean((await version.json()).revision,80);
      const cached=await DB.prepare('SELECT revision,synced_at FROM peer_catalogue_cache WHERE peer_id=?').bind(peer.id).first();
      if(cached?.synced_at && cached.revision===rev){await DB.prepare('UPDATE peers SET last_ok=?,last_error=NULL WHERE id=? AND last_error IS NOT NULL').bind(Date.now(),peer.id).run();continue;}
      await syncPeerPhase(env,peer,'tracks');
      if(rev)await DB.prepare('UPDATE peer_catalogue_cache SET revision=? WHERE peer_id=?').bind(rev,peer.id).run();
      updated++;
    }catch{/* Disconnected peer is retried next run without deleting data. */}
  }
  if(offset===null&&candidates.length)await DB.prepare("INSERT INTO settings(key,value) VALUES('spotify_peer_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(String((pos+checked)%candidates.length)).run();
  return {checked,updated,reachable,totalPeers:candidates.length,nextOffset:offset===null?null:(pos+checked<candidates.length?pos+checked:null)};
}
function sourceMatch(song,want){
  const sought=splitArtists(want.a);
  const version=s=>norm(fold(String(s||'')));
  return !!version(want.t)&&version(song.title)===version(want.t) && artistsOfRow(song).some(a=>sought.some(b=>normArtist(a)===normArtist(b)));
}
async function createMissingSongRequests(env,requests,ownerId,{limit=4}={}){
  const DB=env.DB;let requested=0;
  const voter=await sha256('spotify-import:'+ownerId);
  const quota=await DB.prepare("SELECT SUM(CASE WHEN voter=? AND created_at>? THEN 1 ELSE 0 END) AS daily,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active FROM requests").bind(voter,Date.now()-86400000).first();
  limit=Math.max(0,Math.min(limit,10-Number(quota?.daily||0),500-Number(quota?.active||0)));
  for(const item of requests.slice(0,limit)){
    const title=clean(item.t,200),artist=clean(item.a,160);
    if(!title||!artist)continue;
    const key='song|'+core(title)+'|'+norm(artist);
    const prior=await DB.prepare("SELECT id FROM requests WHERE dedupe=? AND status='active'").bind(key).first();
    if(prior)continue;
    const id=crypto.randomUUID(),now=Date.now();
    try{
      await DB.prepare(`INSERT INTO requests
        (id,kind,title,artist,album,image,url,dedupe,voter,ip,created_at)
        VALUES(?,'song',? ,? ,'',NULL,NULL,?,?,?,?)`)
        .bind(id,title,artist,key,voter,'spotify-import',now).run();
      await publishHiveRequest(env,{id,kind:'song',title,artist,created_at:now}).catch(()=>{});
      requested++;
    }catch{/* Another request already exists; do not duplicate it. */}
  }
  return requested;
}
async function requestStoredSong(env,song,userId){
  const db=env.DB,voter=await sha256('spotify-import:'+userId);
  const key='song|'+core(song.t)+'|'+norm(song.a);
  if(await db.prepare("SELECT 1 FROM requests WHERE dedupe=? AND status='active'").bind(key).first())return {ok:true,requested:0,already_requested:true};
  const count=await db.prepare("SELECT SUM(CASE WHEN voter=? AND created_at>? THEN 1 ELSE 0 END) AS daily,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active FROM requests").bind(voter,Date.now()-86400000).first();
  if(Number(count?.daily||0)>=10||Number(count?.active||0)>=500)return {error:'Request limit reached. Try again later.'};
  const cat=await spotifyImportCatalogue(db);if([...cat.local,...cat.remote].some(t=>sourceMatch(t,song)))return {ok:true,requested:0,in_library:true};
  const requested=await createMissingSongRequests(env,[song],userId,{limit:1});return {ok:true,requested,already_requested:!requested};
}
async function insertRowsInChunks(DB,table,cols,values){
  // Internal constants only: JSON is a bound value, never SQL interpolation.
  for(let i=0;i<values.length;i+=200){const part=values.slice(i,i+200);const extract=cols.map((_,j)=>`json_extract(value,'$[${j}]')`).join(',');
    await DB.prepare(`INSERT OR IGNORE INTO ${table}(${cols.join(',')}) SELECT ${extract} FROM json_each(?)`).bind(JSON.stringify(part)).run();}
}
async function refreshSpotifyUserImport(env,imp,{fetchPeers=false,requestMissing=true}={}){
  const DB=env.DB;
  if(fetchPeers)await refreshSpotifyPeerCatalogue(env,{max:8});
  const songs=JSON.parse(imp.tracks_json||'[]');
  const {local,remote}=await spotifyImportCatalogue(DB);
  const add=[],missing=[];let own=0,others=0;const localIndex=titleIndex(local),remoteIndex=titleIndex(remote);
  for(const [index,target] of songs.entries()){
    const key=core(target.t);let hit=(localIndex.get(key)||[]).find(row=>sourceMatch(row,target)),source='local';
    if(!hit){hit=(remoteIndex.get(key)||[]).find(row=>sourceMatch(row,target));source='peer';}
    if(!hit){missing.push(target);continue;}
    const reference=source==='local'?hit.id:'peer:'+await sha256(hit.origin+'\n'+hit.remote_id);
    if(source==='local')own++;else others++;
    add.push({ref:reference,hit,source,index,target});
  }
  // Preserve Spotify ordering through monotonically increasing added_at values,
  // and never overwrite the user's own manual playlist modifications.
  const now=Date.now(),refs=[],links=[];
  const songKey=t=>norm(t.t)+'|'+norm(t.a);
  let remaining=null;if(imp.state==='complete'){
    let previous=[];try{previous=JSON.parse(imp.missing_json||'[]');}catch{}
    remaining=new Set([...previous,...(imp.newly_discovered||[])].map(songKey));
  }
  for(const item of add){
    if(remaining&&!remaining.has(songKey(item.target)))continue;
    if(item.source==='peer'){
      const t=item.hit;refs.push([item.ref,t.origin,t.remote_id,clean(t.title,200),clean(t.artist,200),clean(t.album,200),Number(t.duration)||0,clean(t.cover_url,500)]);
    }
    links.push([imp.playlist_id,item.ref,Number(imp.created_at)+item.index]);
  }
  await insertRowsInChunks(DB,'peer_track_refs',['ref','origin','remote_id','title','artist','album','duration','cover_url'],refs);
  await insertRowsInChunks(DB,'user_playlist_tracks',['playlist_id','track_id','added_at'],links);
  const pendingMissing=remaining?missing.filter(t=>remaining.has(songKey(t))):missing;
  if(requestMissing&&imp.state==='draft'&&pendingMissing.length)await createMissingSongRequests(env,pendingMissing,imp.user_id);
  await DB.prepare(`UPDATE spotify_user_imports
    SET matched=?,local_count=?,peer_count=?,missing=?,missing_json=?,updated_at=? WHERE id=?`)
    .bind(add.length,own,others,pendingMissing.length,JSON.stringify(pendingMissing),now,imp.id).run();
  return {id:imp.id,playlist_id:imp.playlist_id,matched:add.length,local:own,peer:others,
    missing:pendingMissing.length,missing_songs:pendingMissing,total:imp.total,source_total:imp.source_total??null,partial:!!imp.partial,state:imp.state};
}
async function extendSpotifyImport(env,imp){
  const id=String(imp.spotify_url).match(/^https:\/\/open\.spotify\.com\/playlist\/([A-Za-z0-9]{10,40})$/)?.[1];
  if(!id)return imp;
  try{const e=await spotifyEmbed(id);const m=playlistMeta(e.tracks,e.sourceTotal??imp.source_total);const old=JSON.parse(imp.tracks_json||'[]');
    if(m.tracks.length<old.length || !old.every((v,i)=>core(v.t)===core(m.tracks[i].t)&&norm(v.a)===norm(m.tracks[i].a)))return imp;
    const next={...imp,tracks_json:JSON.stringify(m.tracks),total:m.total,partial:m.partial?1:0,source_total:m.source_total??imp.source_total,newly_discovered:m.tracks.slice(old.length)};
    let missing=JSON.parse(imp.missing_json||'[]');if(imp.state==='complete')missing.push(...next.newly_discovered);next.missing_json=JSON.stringify(missing);
    await env.DB.prepare('UPDATE spotify_user_imports SET tracks_json=?,total=?,partial=?,source_total=?,missing_json=? WHERE id=?').bind(next.tracks_json,next.total,next.partial,next.source_total,next.missing_json,imp.id).run();return next;
  }catch{return imp;}
}
async function refreshActiveSpotifyImports(env,{max=6,fetchPeers=false}={}){
  await ensureSpotifyImportSchema(env.DB);
  const imports=(await env.DB.prepare(`SELECT * FROM spotify_user_imports WHERE state='draft'
    ORDER BY updated_at ASC LIMIT ?`).bind(max).all()).results;
  if(!imports.length)return {checked:0};
  if(fetchPeers)await refreshSpotifyPeerCatalogue(env,{max:2});
  let checked=0;
  for(const imp of imports){try{await refreshSpotifyUserImport(env,imp,{requestMissing:false});checked++;}catch{}}
  return {checked};
}
async function saveSpotifyImportedCover(env,playlistId,source){
  if(!source||!safeImage(source))return;
  const r=requireNoRedirect(await fetch(source,{signal:AbortSignal.timeout(9000),redirect:'manual'}));
  if(!r.ok||!/^image\/(jpeg|png|webp)/i.test(r.headers.get('content-type')||''))return;
  const bytes=await r.arrayBuffer();if(!bytes.byteLength||bytes.byteLength>3*1024*1024)return;
  const type=(r.headers.get('content-type')||'image/jpeg').split(';')[0];
  await env.MUSIC.put('art/user-playlist/'+playlistId,bytes,{httpMetadata:{contentType:type}});
  await env.DB.prepare("UPDATE user_playlists SET cover_v=?,cover_mode='copied' WHERE id=?").bind(Date.now(),playlistId).run();
}

// Private Spotify credentials saved by an administrator. The client secret is
// AES-GCM encrypted with an installation key that lives outside D1:
// SPOTIFY_SETTINGS_KEY, or the existing persistent Docker SCANNER_SECRET.
// No secret is returned to a browser or stored in the site's public settings.
function spotifySettingsKey(env) {
  return String(env.SPOTIFY_SETTINGS_KEY || env.SCANNER_SECRET || "").trim();
}
async function spotifyCipherKey(env) {
  const passphrase = spotifySettingsKey(env);
  if (passphrase.length < 24) throw new Error("Credential encryption requires SPOTIFY_SETTINGS_KEY (or the Docker installation secret). Set it on the server before saving.");
  const material = await crypto.subtle.digest("SHA-256", enc.encode("WASP-SPOTIFY-SETTINGS-v1\0" + passphrase));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
function bytesTo64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function bytesFrom64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}
async function encryptSpotifySecret(env, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await spotifyCipherKey(env);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("wasp-spotify-v1") }, key, enc.encode(secret));
  return "v1:" + bytesTo64(iv) + ":" + bytesTo64(ciphertext);
}
async function decryptSpotifySecret(env, cipher) {
  const parts = String(cipher).split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unknown encrypted Spotify credentials format.");
  const key = await spotifyCipherKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesFrom64(parts[1]), additionalData: enc.encode("wasp-spotify-v1") }, key, bytesFrom64(parts[2]));
  return new TextDecoder().decode(plain);
}
async function spotifySavedConfig(env) {
  return env.DB.prepare("SELECT client_id, secret_cipher, updated_at FROM spotify_credentials WHERE id = 1").first();
}
async function spotifyCredentials(env) {
  const saved = await spotifySavedConfig(env);
  if (saved) return { id: saved.client_id, secret: await decryptSpotifySecret(env, saved.secret_cipher), source: "admin" };
  return { id: String(env.SPOTIFY_CLIENT_ID || "").trim(), secret: String(env.SPOTIFY_CLIENT_SECRET || "").trim(), source: "environment" };
}
function spotifyConfigResponse(saved, env, locked = false) {
  const eid = String(env.SPOTIFY_CLIENT_ID || "").trim(), es = String(env.SPOTIFY_CLIENT_SECRET || "").trim();
  return {
    client_id: saved?.client_id || eid,
    secret_configured: !!saved || !!(eid && es),
    saved_in_admin: !!saved,
    source: saved ? "admin" : (eid && es ? "environment" : "none"),
    updated_at: saved?.updated_at || null,
    storage_ready: spotifySettingsKey(env).length >= 24,
    locked,
  };
}
// Optional Spotify Web API playlist search. Credentials are server-side secrets.
let spotifyAuthCache={id:"",token:"",expires:0};
async function spotifySearchPlaylists(env, q) {
  let id, secret;
  try { ({ id, secret } = await spotifyCredentials(env)); }
  catch { return json({error:"Saved Spotify credentials could not be unlocked. Ask the administrator to check the server encryption key."},503); }
  if (!id || !secret) return json({error:"Spotify playlist search is not configured. An administrator can add credentials under Admin → Requests → Spotify settings. You can still paste a playlist link."},503);
  const cacheKey = id + ":" + await sha256(secret);
  if (spotifyAuthCache.id!==cacheKey || spotifyAuthCache.expires<Date.now()) {
    const token=await fetch("https://accounts.spotify.com/api/token",{method:"POST",
      headers:{authorization:"Basic "+btoa(id+":"+secret),"content-type":"application/x-www-form-urlencoded"},
      body:"grant_type=client_credentials",signal:AbortSignal.timeout(10000)});
    if(!token.ok)return json({error:"Spotify rejected the configured credentials. Please check the Spotify app and permissions."},502);
    const payload=await token.json();
    if(!payload.access_token)return json({error:"Spotify did not provide a valid access token."},502);
    spotifyAuthCache={id:cacheKey,token:payload.access_token,expires:Date.now()+(Math.max(60,Number(payload.expires_in)||3600)-30)*1000};
  }
  const target="https://api.spotify.com/v1/search?"+new URLSearchParams({q,type:"playlist",limit:"10"});
  const r=await fetch(target,{headers:{authorization:"Bearer "+spotifyAuthCache.token,accept:"application/json"},signal:AbortSignal.timeout(10000)});
  if(!r.ok)return json({error:r.status===429?"Spotify search rate limit reached. Try again later.":"Spotify search is unavailable for these credentials (HTTP "+r.status+"). You can still paste a playlist link."},502);
  const results=await r.json();
  const playlists=(results.playlists?.items||[]).filter(x=>x&&/^[A-Za-z0-9]{10,40}$/.test(x.id||""));
  return json(playlists.map(x=>({id:x.id,title:clean(x.name,120),
    sub:[x.owner?.display_name||x.owner?.id, Number.isFinite(x.items?.total)?x.items.total+" songs":null].filter(Boolean).join(" · "),
    image: safeImage(x.images?.[0]?.url),url:"https://open.spotify.com/playlist/"+x.id})));
}
// which Spotify songs are already in the library? lib = rows of tracks
function matchPlaylist(lib, tracks) {
  const byTitle = new Map();
  for (const r of lib) { const k = core(r.title); if (k) { if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(r); } }
  const matched = [], missing = [];
  for (const x of tracks) {
    const want = splitArtists(x.a);
    const hit = (byTitle.get(core(x.t)) || []).find((r) => artistsOfRow(r).some((a) => want.some((w) => sameName(a, w))));
    if (hit) matched.push(hit.id); else missing.push(x);
  }
  return { matched, missing };
}
const libraryRows = async (DB) => (await DB.prepare("SELECT id, title, artist, artists FROM tracks").all()).results;
// Count both local tracks and trusted peer-catalogue matches without
// duplicating content. An exact match is required; a matching playlist name
// by itself never proves all its songs are available.
function titleIndex(list){const out=new Map();for(const row of list){const key=core(row.title);if(!out.has(key))out.set(key,[]);out.get(key).push(row);}return out;}
// Reviewed, explicit cross-peer song matching (not automatic fuzzy replacement).
import { suggestRequestCandidates, safeManualMatches, requestSongKey } from './request-playlist-match.js';
function requestActiveTracks(meta){const skipped=new Set(meta?.skipped_indices||[]);return (meta?.tracks||[]).map((song,i)=>({...song,request_index:i})).filter(x=>!skipped.has(x.request_index));}
function stableRequestSelections(before,next){
  const old=before?.tracks||[];if(old.length!==next.length)return false;
  return old.every((x,i)=>requestSongKey(x)===requestSongKey(next[i]));
}
async function matchPlaylistHIVE(env,requested,{register=false,catalogue=null,manual_matches={}}={}){
  const {local,remote}=catalogue||await spotifyImportCatalogue(env.DB);
  const localIndex=titleIndex(local),remoteIndex=titleIndex(remote);
  const matched=[],missing=[],refs=[];let localCount=0,peerCount=0;
  for(const [i,song] of requested.entries()){
    const choice=manual_matches[String(song.request_index??i)];
    const explicit=choice&&[...local,...remote].find(r=>String(r.origin||'')===choice.origin&&String(r.remote_id||r.id)===choice.id);
    const key=core(song.t);let hit=explicit||(localIndex.get(key)||[]).find(r=>sourceMatch(r,song)),isRemote=!!explicit?.origin;
    if(!hit){hit=(remoteIndex.get(key)||[]).find(r=>sourceMatch(r,song));isRemote=true;}
    if(!hit){missing.push({...song,request_index:song.request_index??i});continue;}
    if(isRemote){
      peerCount++;
      const ref=register?'peer:'+await sha256(hit.origin+'\n'+hit.remote_id):'peer-match:'+hit.remote_id;
      if(register)refs.push([ref,hit.origin,hit.remote_id,clean(hit.title),clean(hit.artist),clean(hit.album),Number(hit.duration)||0,clean(hit.cover_url,500)]);
      matched.push(ref);
    }else {localCount++;matched.push(hit.id);}
  }
  if(register)await insertRowsInChunks(env.DB,'peer_track_refs',['ref','origin','remote_id','title','artist','album','duration','cover_url'],refs);
  return {matched,missing,local_count:localCount,peer_count:peerCount};
}
async function reconcileHIVERequests(env){
  const db=env.DB;
  const offset=Number((await db.prepare("SELECT value FROM settings WHERE key='hive_match_offset'").first())?.value)||0;
  const total=Number((await db.prepare("SELECT COUNT(*) n FROM requests WHERE status='active' AND kind IN ('song','playlist')").first())?.n||0);
  const candidates=total?(await db.prepare("SELECT * FROM requests WHERE status='active' AND kind IN ('song','playlist') ORDER BY created_at,id LIMIT 1 OFFSET ?").bind(offset%total).all()).results:[];
  if(total)await db.prepare("INSERT INTO settings(key,value) VALUES('hive_match_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String((offset+1)%total)).run();
  if(!candidates.length)return {checked:0,completed:0};
  const {local,remote}=await spotifyImportCatalogue(env.DB);
  let completed=0;
  for(const req of candidates){
    if(req.kind==='song'){
      const q={t:req.title,a:req.artist};
      if(![...local,...remote].some(t=>sourceMatch(t,q)))continue;
      await markDone(env.DB,req.id);
      await publishHiveRequest(env,req,'done').catch(()=>{});completed++;
    }else if(req.meta){
      let meta;try{meta=JSON.parse(req.meta);}catch{continue;}
      if(!Array.isArray(meta.tracks)||!meta.tracks.length)continue;
      const result=await matchPlaylistHIVE(env,requestActiveTracks(meta),{catalogue:{local,remote},manual_matches:safeManualMatches(meta)});
      const next={...meta,matched:result.matched.length,matched_local:result.local_count,matched_peer:result.peer_count,matched_missing:result.missing,availability_checked_at:Date.now()};
      await env.DB.prepare('UPDATE requests SET meta=? WHERE id=?').bind(JSON.stringify(next),req.id).run();
      // Do not auto-close a request just because one peer reports a partial
      // Spotify catalogue. Ownership & explicit admin completion are preserved.
    }
  }
  return {checked:candidates.length,completed};
}

async function markDone(DB, id, playlistId = null) {
  await DB.prepare("UPDATE requests SET status = 'done', done_at = ?, playlist_id = COALESCE(?, playlist_id), dedupe = dedupe || '|done|' || id WHERE id = ? AND status = 'active'").bind(Date.now(), playlistId, id).run();
}
// the playlist picture from Spotify becomes the playlist's own picture (unless the admin already chose one)
async function coverFromRequest(env, playlistId, image) {
  const pl = await env.DB.prepare("SELECT cover_v FROM playlists WHERE id = ?").bind(playlistId).first();
  if (!image || !safeImage(image) || (pl && pl.cover_v)) return;
  const r = await fetch(image, { headers: UA });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !/^image\/(jpeg|png|webp)/.test(type)) return;
  const buf = await r.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 5 * 1024 * 1024) return;
  await env.MUSIC.put(`art/playlist/${playlistId}`, buf, { httpMetadata: { contentType: type.split(";")[0] }, customMetadata: { source: "custom", at: String(Date.now()) } });
  await env.DB.prepare("UPDATE playlists SET cover_v = ? WHERE id = ?").bind(Date.now(), playlistId).run();
}
// A playlist request is done: put it in the Playlists tab (with the songs we have, in Spotify's order) and give it Spotify's picture.
async function completePlaylistRequest(env, r, ids) {
  const DB = env.DB, now = Date.now();
  let pl = await DB.prepare("SELECT id FROM playlists WHERE name = ?").bind(r.title).first();
  if (!pl) { pl = { id: crypto.randomUUID() }; await DB.prepare("INSERT INTO playlists (id, name, created_at) VALUES (?,?,?)").bind(pl.id, r.title, now).run(); }
  await insertRowsInChunks(DB,'playlist_tracks',['playlist_id','track_id','added_at'],ids.map((tid,i)=>[pl.id,tid,now+i]));
  await coverFromRequest(env, pl.id, r.image).catch(() => {});
  await markDone(DB, r.id, pl.id);
  await publishHiveRequest(env,r,'done').catch(()=>{});
  return pl.id;
}
// After songs are added: refresh how many songs of each requested playlist we have, and finish the ones that are complete.
async function rematchPlaylists(env) {
  // Playlist requests are incrementally rechecked by the scheduled matcher.
  // Do not scan every playlist and all tracks on every individual upload.
  return {scheduled:true};
}

async function inLibrary(DB, it) {
  if (it.kind === "playlist") return (await DB.prepare("SELECT name FROM playlists").all()).results.some((p) => norm(p.name) === norm(it.title));
  const lib = (await DB.prepare("SELECT artist, artists, title, album FROM tracks").all()).results;
  if(it.kind==='song')return lib.some(t=>sourceMatch(t,{t:it.title,a:it.artist}));
  const by = (t, name) => artistsOfRow(t).some((a) => sameName(a, name));
  return lib.some((t) => it.kind === "song" ? same(t.title, it.title) && by(t, it.artist)
    : it.kind === "album" ? t.album && same(t.album, it.title) && by(t, it.artist) : by(t, it.title));
}
// A newly added song takes any matching requests (song, its album, its artist) out of the queue.
async function fulfil(env, t) {
  const { results } = await env.DB.prepare("SELECT * FROM requests WHERE kind = 'song' AND status = 'active'").all();
  const by = (name) => t.artists.some((a) => sameName(a, name));
  const done = results.filter((r) => r.kind === 'song' && sourceMatch({title:t.title,artist:t.artist,artists:t.artists},{t:r.title,a:r.artist}));
  for (const r of done){ await markDone(env.DB, r.id);await publishHiveRequest(env,r,'done').catch(()=>{}); }
  await rematchPlaylists(env); // a requested playlist may now be complete
  await refreshActiveSpotifyImports(env,{max:1}).catch(()=>{});
}

const MUSICY = /\b(band|musician|singer|rapper|songwriter|group|duo|trio|quartet|dj|composer|vocalist|guitarist|producer|artist|metal|rock|pop|hip hop)\b/i;
const wcf = { cacheTtl: 300, cacheEverything: true }; // Wikimedia answers are reused for 5 minutes at the edge
async function wikiSummary(title) {
  const r = await fetch(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(String(title).replace(/ /g, "_"))}`, { headers: UA, cf: wcf });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("wikipedia unavailable");
  return r.json();
}
function fromSummary(d) {
  let text = String(d.extract || "").replace(/\s+/g, " ").trim();
  if (text.length > 520) {
    const cut = text.slice(0, 520), i = cut.lastIndexOf(". ");
    text = i > 200 ? cut.slice(0, i + 1) : cut.replace(/\s+\S*$/, "") + "…";
  }
  return { text, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(d.title).replace(/ /g, "_"))}`, wtitle: String(d.title), rev: String(d.revision || ""), qid: d.wikibase_item || "", desc: String(d.description || "") };
}
function pickSummary(d, name) {
  if (!d || d.type !== "standard" || !d.extract) return null;
  const base = String(d.title || "").replace(/\s*\(.*\)\s*$/, "");
  if (!sameName(base, name) || !MUSICY.test(`${d.description || ""} ${d.extract.slice(0, 300)}`)) return null;
  return fromSummary(d);
}
// Genres come from Wikidata ("genre" property P136) for the artist's Wikipedia page.
async function wikidataGenres(qid) {
  if (!/^Q\d+$/.test(qid || "")) return [];
  const c = await fetch(`${WIKIDATA}/w/api.php?action=wbgetclaims&entity=${qid}&property=P136&format=json`, { headers: UA, cf: wcf });
  if (!c.ok) throw new Error("wikidata unavailable");
  const ids = ((await c.json()).claims?.P136 || []).filter((x) => x.rank !== "deprecated").map((x) => x.mainsnak?.datavalue?.value?.id).filter(Boolean).slice(0, 6);
  if (!ids.length) return [];
  const l = await fetch(`${WIKIDATA}/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=labels&languages=en&format=json`, { headers: UA, cf: wcf });
  if (!l.ok) throw new Error("wikidata unavailable");
  const ents = (await l.json()).entities || {};
  return uniq(ids.map((id) => ents[id]?.labels?.en?.value).filter(Boolean));
}
// The intro of the article (section 0) holds the infobox: is it a band or one person, who is in it now, and its genres.
async function wikiInfobox(title) {
  const r = await fetch(`${WIKI}/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&section=0&redirects=1&format=json&formatversion=2`, { headers: UA, cf: wcf });
  if (!r.ok) throw new Error("wikipedia unavailable");
  return String((await r.json())?.parse?.wikitext || "");
}
function infoboxFields(text) {
  const m = text.match(/\{\{\s*Infobox (?:musical artist|musician|band)\b/i);
  if (!m) return null;
  let depth = 0, end = text.length;
  for (let p = m.index; p < text.length - 1; p++) {
    if (text.startsWith("{{", p)) { depth++; p++; }
    else if (text.startsWith("}}", p)) { depth--; p++; if (depth === 0) { end = p - 1; break; } }
  }
  const body = text.slice(m.index + 2, end);
  const parts = []; let cur = "", b = 0, t = 0;
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "[[") { b++; cur += two; i++; } else if (two === "]]") { b--; cur += two; i++; }
    else if (two === "{{") { t++; cur += two; i++; } else if (two === "}}") { t--; cur += two; i++; }
    else if (body[i] === "|" && b <= 0 && t <= 0) { parts.push(cur); cur = ""; }
    else cur += body[i];
  }
  parts.push(cur);
  const f = {};
  for (const p of parts.slice(1)) { const eq = p.indexOf("="); if (eq > 0) f[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim(); }
  return f;
}
// names (with a link and a role when there is one) out of a field such as {{hlist|[[A]]|[[B]] (drums)}} or a "* [[A]]" list
function wikiPeople(value) {
  const links = [];
  let v = String(value || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, target, shown) => { links.push({ target: target.trim(), shown: (shown || "").trim() }); return `\u0001${links.length - 1}\u0001`; });
  v = v.replace(/\{\{\s*(?:hlist|plainlist|flatlist|ubl|unbulleted list|bulleted list|collapsible list|nowrap|small)\s*\|/gi, "\n").replace(/\{\{[^{}]*\}\}/g, " ").replace(/[{}]/g, "\n");
  const out = [];
  for (let tok of v.split(/\n|\||<br\s*\/?>|(?:^|\s)\*\s*/i)) {
    tok = tok.replace(/^[\s*#:;]+/, "").replace(/<[^>]+>/g, "").replace(/'{2,}/g, "").trim();
    if (!tok || tok.includes("=")) continue;
    const roleDash = tok.split(/\s[–—-]\s/);
    let namePart = roleDash[0], role = roleDash.slice(1).join(", ").trim();
    const par = namePart.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    if (par) { namePart = par[1]; role = role || par[2].trim(); }
    let link = null;
    namePart = namePart.replace(/\u0001(\d+)\u0001/g, (_, i) => { link = link || links[+i]; return links[+i].shown || links[+i].target.replace(/\s*\([^)]*\)\s*$/, ""); }).trim();
    namePart = namePart.replace(/^[,;\s]+|[,;\s]+$/g, "");
    if (!namePart || namePart.length > 60 || !/\p{L}/u.test(namePart) || /^(?:file|image|category):/i.test(namePart)) continue;
    out.push({ name: namePart, role: role.slice(0, 60), url: link && !/^(?:file|image|category):/i.test(link.target) ? `https://en.wikipedia.org/wiki/${encodeURIComponent(link.target.replace(/ /g, "_"))}` : null });
  }
  const seen = new Set();
  return out.filter((p) => { const k = p.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 16);
}
function parseInfobox(wikitext, description) {
  const f = infoboxFields(wikitext || "");
  const bg = f ? String(f.background || "").toLowerCase() : "";
  let kind = /group_or_band|classical_ensemble/.test(bg) ? "band" : /solo_singer|non_vocal_instrumentalist/.test(bg) ? "solo" : "";
  if (!kind) kind = /\b(band|group|duo|trio|quartet|quintet|collective|ensemble)\b/i.test(description || "") ? "band" : /\b(singer|rapper|musician|songwriter|dj|composer|producer|guitarist|vocalist|pianist|drummer)\b/i.test(description || "") ? "solo" : "";
  const members = kind === "band" && f ? wikiPeople(f.current_members || f.members || "") : [];
  const genres = f && f.genre ? wikiPeople(f.genre).map((g) => g.name.toLowerCase()).slice(0, 5) : [];
  return { kind, members, genres };
}
const withGenres = async (hit) => {
  const [g, box] = await Promise.all([wikidataGenres(hit.qid).catch(() => []), wikiInfobox(hit.wtitle).catch(() => null)]);
  const info = parseInfobox(box, hit.desc);
  return { ...hit, genres: g.length ? g : info.genres, kind: info.kind, members: info.members };
};
// Looks for the artist's page. The likely page names are asked for all at once, which is much faster than searching.
async function wikiLookup(name) {
  const res = await Promise.allSettled([name, `${name} (band)`, `${name} (musician)`, `${name} (singer)`, `${name} (rapper)`].map(wikiSummary));
  for (const r of res) if (r.status === "fulfilled") { const hit = pickSummary(r.value, name); if (hit) return withGenres(hit); }
  if (res.some((r) => r.status === "rejected")) throw new Error("wikipedia unavailable"); // not "no page": try again later
  const s = await fetch(`${WIKI}/w/api.php?action=query&list=search&srlimit=3&format=json&srsearch=${encodeURIComponent(`${name} (band OR musician OR singer OR rapper)`)}`, { headers: UA, cf: wcf });
  if (!s.ok) throw new Error("wikipedia unavailable");
  for (const h of (await s.json())?.query?.search || []) { const hit = pickSummary(await wikiSummary(h.title), name); if (hit) return withGenres(hit); }
  return null;
}
async function deezerPicture(name) {
  const r = await fetch(`${DZ}/search/artist?limit=10&q=${encodeURIComponent(name)}`, { headers: UA, cf: { cacheTtl: 600, cacheEverything: true } });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error("deezer unavailable");
  const hit = pickDeezerArtist(d.data, name);
  return hit ? safeImage(hit.picture_medium) : null;
}
// image: a URL, null = looked and found nothing, missing = not looked yet (e.g. a service was down)
async function enrichMembers(env, name, row) {
  let members = []; try { members = JSON.parse(row.members || "[]"); } catch {}
  const todo = members.filter((m) => !("image" in m)).slice(0, 12);
  if (!todo.length) return members;
  await Promise.allSettled(todo.map(async (m) => {
    let image = null, looked = true;
    if (m.url) {
      try { const s = await wikiSummary(decodeURIComponent(m.url.split("/wiki/")[1] || "")); image = safeImage(s && s.thumbnail && s.thumbnail.source); } catch { looked = false; }
    }
    if (!image && looked) { try { image = await deezerPicture(m.name); } catch { looked = false; } }
    if (looked) m.image = image;
  }));
  await env.DB.prepare("UPDATE artist_info SET members = ? WHERE name = ?").bind(JSON.stringify(members), name).run();
  return members;
}
const parseGenres = (r) => { try { const a = JSON.parse(r?.genres || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
async function infoSave(DB, name, d) {
  await DB.prepare(`INSERT INTO artist_info (name, text, url, wtitle, rev, genres, kind, members, checked_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET text = excluded.text, url = excluded.url, wtitle = excluded.wtitle, rev = excluded.rev, genres = excluded.genres, kind = excluded.kind, members = excluded.members, checked_at = excluded.checked_at`)
    .bind(name, d ? d.text : null, d ? d.url : null, d ? d.wtitle : null, d ? d.rev : null, JSON.stringify(d ? d.genres : []), d ? d.kind || "" : "", JSON.stringify(d ? d.members || [] : []), Date.now()).run();
}
// Brings the saved copy up to date. Nothing is written when Wikipedia has not changed. Returns added | updated | unchanged | none.
async function refreshInfo(env, name, row) {
  const DB = env.DB;
  if (!row || !row.wtitle) { // nothing useful saved yet: look the artist up
    const d = await wikiLookup(name);
    await infoSave(DB, name, d);
    return d ? "added" : "none";
  }
  const s = await wikiSummary(row.wtitle);
  if (!s || !s.extract) return "unchanged";
  const cur = fromSummary(s), old = parseGenres(row);
  const same = cur.rev ? cur.rev === row.rev : cur.text === row.text; // Wikipedia's revision number says if the page changed
  const legacy = row.members == null; // saved before lineups existed: read the infobox once
  if (same && old.length && !legacy) return "unchanged";
  const [gw, box] = await Promise.all([wikidataGenres(cur.qid).catch(() => []), wikiInfobox(cur.wtitle).catch(() => null)]);
  if (same && legacy && box === null) return "unchanged"; // could not read it now: try again next time
  const info = parseInfobox(box, cur.desc);
  const genres = gw.length ? gw : info.genres.length ? info.genres : old;
  let oldM = []; try { oldM = JSON.parse(row.members || "[]"); } catch {}
  const next = { ...cur, genres, kind: info.kind, members: info.members.map((m) => { const o = oldM.find((x) => x.name === m.name && "image" in x); return o ? { ...m, image: o.image } : m; }) };
  const plain = (list) => JSON.stringify(list.map(({ name, role, url }) => ({ name, role, url }))); // pictures do not count as a change
  const identical = next.text === row.text && JSON.stringify(genres) === JSON.stringify(old) && next.kind === (row.kind || "") && plain(next.members) === plain(oldM);
  if (identical) { // edited elsewhere on the page: only remember the new revision
    if (cur.rev !== row.rev) await DB.prepare("UPDATE artist_info SET rev = ? WHERE name = ?").bind(cur.rev, name).run();
    return "unchanged";
  }
  await infoSave(DB, name, next);
  return "updated";
}
// The saved copy is returned straight away; Wikipedia is checked in the background and the copy is only rewritten if the page changed.
async function serveBio(env, url, ctx) {
  const name = clean(url.searchParams.get("name"));
  const none = () => json({ error: "none" }, 404, { "cache-control": "public, max-age=300" });
  if (!name || /^unknown/i.test(name) || !(await libraryHasArtist(env.DB, name))) return none();
  const get = () => env.DB.prepare("SELECT * FROM artist_info WHERE name = ?").bind(name).first();
  let row = await get();
  if (row && row.wtitle) { const job = refreshInfo(env, name, row).catch(() => {}); if (ctx) ctx.waitUntil(job); }
  else if (!row || Date.now() - row.checked_at > RETRY_MS) {
    try { await refreshInfo(env, name, row); } catch { return json({ error: "unavailable" }, 502); }
    row = await get();
  }
  const genres = parseGenres(row);
  if (!row || (!row.text && !genres.length)) return none();
  let members = []; try { members = JSON.parse(row.members || "[]"); } catch {}
  return json({ text: row.text, url: row.url, source: "Wikipedia", genres, kind: row.kind || null, members }, 200, { "cache-control": "no-cache" });
}

// ---------- similar artists ----------
async function deezerRelated(name) {
  const find = await fetch(`${DZ}/search/artist?limit=10&q=${encodeURIComponent(name)}`, { headers: UA, cf: { cacheTtl: 600, cacheEverything: true } });
  const fd = await find.json();
  if (!find.ok || fd.error) throw new Error("deezer unavailable");
  const hit = pickDeezerArtist(fd.data, name);
  if (!hit) return [];
  const rel = await fetch(`${DZ}/artist/${hit.id}/related?limit=30`, { headers: UA, cf: { cacheTtl: 600, cacheEverything: true } });
  const rd = await rel.json();
  if (!rel.ok || rd.error) throw new Error("deezer unavailable");
  const self = normArtist(name);
  return (rd.data || []).map((x) => ({ name: clean(x.name), image: safeImage(x.picture_medium) })).filter((x) => x.name && normArtist(x.name) !== self).slice(0, 30);
}
async function serveSimilar(env, url) {
  const name = clean(url.searchParams.get("name"));
  const none = () => json({ error: "none" }, 404, { "cache-control": "public, max-age=300" });
  if (!name || /^unknown/i.test(name) || !(await libraryHasArtist(env.DB, name))) return none();
  const row = await env.DB.prepare("SELECT list, fetched_at FROM artist_similar WHERE name = ?").bind(name).first();
  let saved = null; try { saved = row ? JSON.parse(row.list) : null; } catch {}
  const ttl = saved && saved.length ? 30 * 86400000 : 3 * 86400000;
  if (saved && Date.now() - row.fetched_at < ttl) return json({ artists: saved }, 200, { "cache-control": "public, max-age=300" });
  let list;
  try { list = await deezerRelated(name); } catch { return saved ? json({ artists: saved }) : json({ error: "unavailable" }, 502); }
  await env.DB.prepare("INSERT INTO artist_similar (name, list, fetched_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET list = excluded.list, fetched_at = excluded.fetched_at").bind(name, JSON.stringify(list), Date.now()).run();
  return json({ artists: list }, 200, { "cache-control": "public, max-age=300" });
}

// ---------- lyrics: LRCLIB (time-synced when available) and lyrics.ovh (plain text), asked at the same time ----------
let LRC = "https://lrclib.net";
function parseLrc(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const txt = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const s of stamps) out.push([Math.round((+s[1] * 60 + +s[2]) * 100) / 100, txt]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
// "Song (feat. X) - Remastered" -> also try "Song"; "A / B" -> also try "A"
const titleVariants = (title) => {
  const orig = clean(title);
  const plain = orig.replace(/[(\[][^)\]]*[)\]]/g, " ").replace(/\s+-\s+.*$/, "").replace(/\s+/g, " ").trim();
  return uniq([orig, plain, orig.split(/\s+\/\s+/)[0].trim()].filter(Boolean)).slice(0, 3);
};
const lyricsUsable = (d) => d && (d.instrumental || d.syncedLyrics || d.plainLyrics);
// returns { synced, plain, instrumental } | null (not found); throws only when the service could not be reached at all
async function lrclibChain(t, signal) {
  const get = async (path) => { const r = await fetch(`${LRC}${path}`, { headers: UA, signal }); if (r.status === 404) return null; if (!r.ok) throw new Error("lrclib unavailable"); return r.json(); };
  const gap = (d) => (t.duration && d.duration ? Math.abs(d.duration - t.duration) : 0);
  const best = (list) => { const l = (list || []).filter(lyricsUsable).sort((x, y) => gap(x) - gap(y)); return l.length && (!t.duration || gap(l[0]) <= 8) ? l[0] : null; };
  const out = (d) => ({ synced: d.syncedLyrics ? parseLrc(d.syncedLyrics) : null, plain: d.plainLyrics || null, instrumental: !!d.instrumental, source: "LRCLIB" });
  let asked = 0, errors = 0;
  const attempt = async (fn) => { asked++; try { const d = await fn(); return d ? out(d) : null; } catch { errors++; return null; } };
  const titles = titleVariants(t.title), artist = t.artists[0];
  const exact = new URLSearchParams({ track_name: titles[0], artist_name: artist });
  if (t.album) exact.set("album_name", t.album);
  if (t.duration) exact.set("duration", String(Math.round(t.duration)));
  let hit = await attempt(async () => { const d = await get(`/api/get?${exact}`); return lyricsUsable(d) ? d : null; });
  for (const ti of titles) {
    if (hit && (hit.synced || hit.plain)) break;
    hit = await attempt(async () => best(await get(`/api/search?${new URLSearchParams({ track_name: ti, artist_name: artist })}`))) || hit;
  }
  if (!(hit && (hit.synced || hit.plain))) hit = await attempt(async () => best(await get(`/api/search?${new URLSearchParams({ q: `${artist} ${titles[1] || titles[0]}` })}`))) || hit;
  if (!hit && errors === asked) throw new Error("lrclib unavailable");
  return hit;
}
const lyricsText = (x) => String(x || "").replace(/\r\n?/g, "\n").replace(/^Paroles de la chanson[^\n]*\n+/i, "").trim();
async function ovhChain(t, signal) {
  const combos = [];
  for (const a of t.artists.slice(0, 3)) for (const ti of titleVariants(t.title)) combos.push([a, ti]);
  let asked = 0, errors = 0;
  for (const [a, ti] of combos.slice(0, 5)) {
    asked++;
    try {
      const r = await fetch(`${OVH}/v1/${encodeURIComponent(a)}/${encodeURIComponent(ti)}`, { headers: UA, signal });
      if (r.ok) { const txt = lyricsText((await r.json()).lyrics); if (txt.length > 10) return { synced: null, plain: txt, instrumental: false, source: "lyrics.ovh" }; }
      else if (r.status >= 500) errors++;
    } catch { errors++; if (signal.aborted) break; }
  }
  if (asked && errors === asked) throw new Error("lyrics.ovh unavailable");
  return null;
}
async function serveLyrics(env, url) {
  const id = clean(url.searchParams.get("id"), 64);
  const t = /^[\w-]+$/.test(id) && await env.DB.prepare("SELECT title, artist, artists, album, duration FROM tracks WHERE id = ?").bind(id).first();
  if (!t) return json({ error: "none" }, 404);
  const key = `lyrics2/${id}`;
  let rec = null;
  const obj = await env.MUSIC.get(key);
  if (obj) { try { rec = await obj.json(); } catch {} }
  if (rec?.none && Date.now() - rec.at > RETRY_MS) rec = null;
  if (!rec) {
    const song = { title: t.title, artists: artistsOfRow(t), album: t.album, duration: t.duration };
    const [lr, ov] = await Promise.allSettled([lrclibChain(song, AbortSignal.timeout(9000)), ovhChain(song, AbortSignal.timeout(9000))]);
    const a = lr.status === "fulfilled" ? lr.value : null, b = ov.status === "fulfilled" ? ov.value : null;
    // synced lyrics are best; otherwise any plain lyrics
    const found = a && a.synced ? a : a && a.plain ? a : b && b.plain ? b : a && a.instrumental ? a : null;
    if (!found) {
      if (lr.status === "rejected" && ov.status === "rejected") return json({ error: "unavailable" }, 502); // could not reach either: do not remember a miss
      if (lr.status === "rejected" || ov.status === "rejected") return json({ error: "none" }, 404, { "cache-control": "no-store" });
      rec = { none: true, at: Date.now() };
    } else rec = { synced: found.synced && found.synced.length ? found.synced : null, plain: found.plain, instrumental: found.instrumental, source: found.source, at: Date.now() };
    await env.MUSIC.put(key, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
  }
  if (rec.none) return json({ error: "none" }, 404, { "cache-control": "public, max-age=300" });
  return json({ synced: rec.synced, plain: rec.plain, instrumental: rec.instrumental, source: rec.source }, 200, { "cache-control": "public, max-age=3600" });
}

const routingDemandCache=new WeakMap();
const TRACK_COLS = `t.id, t.title, t.artist, t.artists, t.album, t.track_no, t.duration, t.plays, t.created_at,
  COALESCE(SUM(r.kind = 'heart'), 0) AS hearts, COALESCE(SUM(r.kind = 'like'), 0) AS likes, COALESCE(SUM(r.kind = 'dislike'), 0) AS dislikes`;

async function touchCatalogue(DB) {
  // A single indexed row makes new uploads and playlists discoverable across
  // Cloudflare POPs without relying on a local cache purge in one data center.
  await DB.prepare("INSERT INTO settings(key,value) VALUES('catalog_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(crypto.randomUUID()).run();
}
function changesCatalogue(path) {
  return path === "/api/internal/folder-index" || path === "/api/admin/upload" ||
    path === "/api/admin/clean" || path.startsWith("/api/admin/tracks/") ||
    path==="/api/admin/metadata-bank/apply" || path==="/api/admin/metadata-bank/undo" ||
    path.startsWith("/api/admin/playlists") || (path.startsWith("/api/admin/requests/") && ! ["/api/admin/requests/housekeeping","/api/admin/requests/review"].includes(path)) ||
    path.startsWith("/api/user/playlists");
}
async function catalogueVersion(DB) {
  const row=await DB.prepare("SELECT value FROM settings WHERE key='catalog_revision'").first();
  return row?.value || "0";
}

const CRON_TYPES = ["peers","artwork","biography","hash","telemetry"];
const TELEMETRY_INTERVALS = [5,10,15,30,60,120];
const CRON_DEFAULT_JOB = {enabled:false,frequency:"daily",time:"02:00",weekday:0,monthday:1,sync_catalogue:false};
function cronConfigDefault() {
  return {timezone:"Asia/Manila",jobs:Object.fromEntries(CRON_TYPES.map(x=>[x,x==="telemetry"?{enabled:true,minutes:5}:{...CRON_DEFAULT_JOB}]))};
}
function validateCronConfig(value) {
  if(!value || typeof value!=="object" || typeof value.timezone!=="string" || value.timezone.length>80)throw Error("Invalid timezone");
  try {new Intl.DateTimeFormat("en-US",{timeZone:value.timezone}).format(new Date());}catch{throw Error("Timezone is not supported");}
  const cfg={timezone:value.timezone,jobs:{}};
  for(const kind of CRON_TYPES){
    const source=value.jobs?.[kind]||{},frequency=source.frequency||"daily";
    if(kind==="telemetry"){
      const minutes=Number(source.minutes??5);
      if(!TELEMETRY_INTERVALS.includes(minutes))throw Error("Invalid telemetry sync interval");
      cfg.jobs.telemetry={enabled:source.enabled!==false,minutes};
      continue;
    }
    if(!["daily","weekly","monthly"].includes(frequency))throw Error("Invalid frequency for "+kind);
    const time=String(source.time||"00:00"),weekday=Number(source.weekday??0),monthday=Number(source.monthday??1);
    if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)||!Number.isInteger(weekday)||weekday<0||weekday>6||!Number.isInteger(monthday)||monthday<1||monthday>30)throw Error("Invalid schedule for "+kind);
    cfg.jobs[kind]={enabled:source.enabled===true,frequency,time,weekday,monthday,...(kind==="peers"?{sync_catalogue:source.sync_catalogue===true}:{})};
  }
  return cfg;
}
async function getCronConfig(DB){
  const row=await DB.prepare("SELECT value FROM settings WHERE key='cron_config'").first();
  if(!row)return cronConfigDefault();
  try{return validateCronConfig(JSON.parse(row.value));}catch{return cronConfigDefault();}
}
function cronLocalDate(date,timezone) {
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return {year:p.year,month:p.month,day:Number(p.day),weekday:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday),hm:p.hour+":"+p.minute};
}
function shouldRunCron(job,local){
  if(!job?.enabled)return false;
  if(job.frequency==="daily")return job.time===local.hm;
  if(local.hm!=="00:00")return false;
  return job.frequency==="weekly"?job.weekday===local.weekday:job.monthday===local.day;
}
async function warmArtistMetadata(env,row,kind){
  const artists=artistsOfRow(row).slice(0,2);
  for(const name of artists){
    if(!name||/^unknown/i.test(name))continue;
    if(kind==="biography"){
      // Existing refresh machinery avoids repeating an unchanged Wikipedia lookup.
      try{await serveBio(env,new URL("https://wasp.invalid/api/bio?name="+encodeURIComponent(name)),null);}catch{}
    }else{
      try{await serveArt(env,new URL("https://wasp.invalid/art/artist?name="+encodeURIComponent(name)));}catch{}
      if(row.album)try{await serveArt(env,new URL("https://wasp.invalid/art/album?artist="+encodeURIComponent(name)+"&album="+encodeURIComponent(row.album)));}catch{}
    }
  }
}
// Metadata-only peer sync. Audio objects remain exclusively on the source server.
// Each phase is bounded and independently committed so the admin interface can
// show real, completed stages instead of a simulated progress animation.
const SYNC_PHASES=Object.freeze({tracks:["/api/tracks","tracks",6000],playlists:["/api/playlists","playlists",500],users:["/api/user-playlists","users",500]});
async function syncPeerPhase(env,peer,phase){
  const spec=SYNC_PHASES[phase];if(!spec)throw Error("Invalid sync stage");
  // A unique query string opts out of v14 edge-cached catalogue responses.
  const target=peer.url+spec[0]+"?sync="+crypto.randomUUID();
  const response=requireNoRedirect(await fetch(target,{redirect:"manual",headers:{accept:"application/json","cache-control":"no-cache"},signal:AbortSignal.timeout(25000)}));
  if(!response.ok)throw Error("Peer " + phase + " returned HTTP " + response.status);
  const raw=await response.text();
  if(raw.length>8000000)throw Error("Peer metadata exceeds the sync size limit");
  let data;try{data=JSON.parse(raw);}catch{throw Error("Peer metadata is not valid JSON");}
  if(!Array.isArray(data)||data.length>spec[2])throw Error("Peer returned an invalid " + phase + " catalogue");
  // Chunk the snapshot so each D1 row stays comfortably below its 2 MB limit.
  // Never fetch audio or images; these are metadata JSON fragments only.
  const chunks=[];let segment=[],size=2;
  for(const item of data){
    const part=JSON.stringify(item),bytes=new TextEncoder().encode(part).byteLength;
    if(bytes>240000)throw Error("One peer metadata item exceeds the supported size");
    if(segment.length && size+bytes+1>240000){chunks.push(JSON.stringify(segment));segment=[];size=2;}
    segment.push(item);size+=bytes+1;
  }
  if(segment.length)chunks.push(JSON.stringify(segment));
  await env.DB.prepare("INSERT OR IGNORE INTO peer_catalogue_cache(peer_id) VALUES(?)").bind(peer.id).run();
  const statements=[env.DB.prepare("DELETE FROM peer_catalogue_chunks WHERE peer_id=? AND kind=?").bind(peer.id,phase)];
  for(let i=0;i<chunks.length;i++)statements.push(env.DB.prepare("INSERT INTO peer_catalogue_chunks(peer_id,kind,shard,body) VALUES(?,?,?,?)").bind(peer.id,phase,i,chunks[i]));
  statements.push(env.DB.prepare("UPDATE peer_catalogue_cache SET synced_at=? WHERE peer_id=?").bind(Date.now(),peer.id));
  await env.DB.batch(statements);
  if(phase==="tracks")await env.DB.prepare("UPDATE peers SET track_count=?,last_ok=?,last_error=NULL WHERE id=?")
    .bind(data.length,Date.now(),peer.id).run();
  return {phase,count:data.length};
}
async function snapshotPeerRevision(env,peer){
  let revision="";
  try {
    const r=await fetch(peer.url+"/api/catalog-version?sync="+crypto.randomUUID(),{
      signal:AbortSignal.timeout(6000),headers:{accept:"application/json"}});
    if(r.ok)revision=clean((await r.json()).revision,80);
  }catch{}
  if(revision)await env.DB.prepare("UPDATE peer_catalogue_cache SET revision=? WHERE peer_id=?").bind(revision,peer.id).run();
  return revision;
}
async function syncPeerAll(env,peer){
  const counts={};for(const phase of Object.keys(SYNC_PHASES)){
    const result=await syncPeerPhase(env,peer,phase);counts[phase]=result.count;
  }
  counts.revision=await snapshotPeerRevision(env,peer);
  // Optional one-hop Mobile Bridge federation. Native WASP peer sync must
  // succeed regardless of a remote second-hop source being unavailable.
  if((await env.DB.prepare("SELECT value FROM settings WHERE key='mobile_bridge_enabled'").first())?.value==='1'){
    try{counts.federation=await syncFederatedFromGateway(env,peer);}catch(e){counts.federation={sources:0,errors:[e.message]};}
  }
  await touchCatalogue(env.DB);
  await refreshActiveSpotifyImports(env,{max:1}).catch(()=>{});
  await reconcileHIVERequests(env).catch(()=>{});
  return counts;
}
// The client supplies a random per-play ID. Counter, recent activity and ledger
// commit together so retrying a lost response cannot double count a listen.
function playEventId(req){const id=req.headers.get('x-wasp-play-id')||'';return /^[a-f0-9-]{36}$/i.test(id)?id:crypto.randomUUID();}
async function recordListen(env,{track_id,origin='',remote_id='',title='',artist='',album='',cover_url='',duration=0},{relayed=false,eventId=crypto.randomUUID()}={}){
  const DB=env.DB,playedAt=Date.now();await ensureTelemetrySchemaForMetadata(env);
  const local=(await DB.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value;
  const guard='NOT EXISTS(SELECT 1 FROM recent_listens WHERE id=?) AND NOT EXISTS(SELECT 1 FROM telemetry_events WHERE origin_id=? AND event_id=?)';
  const counter=origin?DB.prepare(`INSERT INTO peer_listens(origin,remote_id,plays) SELECT ?,?,1 WHERE ${guard} ON CONFLICT(origin,remote_id) DO UPDATE SET plays=plays+1`).bind(origin,remote_id,eventId,local,eventId):DB.prepare(`UPDATE tracks SET plays=plays+1 WHERE id=? AND ${guard}`).bind(track_id,eventId,local,eventId);
  const recent=DB.prepare(`INSERT OR IGNORE INTO recent_listens (id,track_id,origin,remote_id,title,artist,album,cover_url,played_at) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM telemetry_events WHERE origin_id=? AND event_id=?)`).bind(eventId,clean(track_id,200),clean(origin,300),clean(remote_id,100),clean(title,200),clean(artist,200),clean(album,200),clean(cover_url,500),playedAt,local,eventId);
  const writes=[counter,recent];
  if(!relayed)writes.push(DB.prepare(`INSERT OR IGNORE INTO telemetry_events(origin_id,event_id,played_at,track_id,title,artist,album,duration) VALUES(?,?,?,?,?,?,?,?)`).bind(local,eventId,playedAt,clean(track_id,160),clean(title,200),clean(artist,200),clean(album,200),Math.max(0,Math.min(86400,Number(duration)||0))));
  const result=await DB.batch(writes);const inserted=Number(result[0]?.meta?.changes??result[0]?.changes??0)>0;
  if(inserted&&Math.random()<0.02)await DB.prepare("DELETE FROM recent_listens WHERE id IN (SELECT id FROM recent_listens ORDER BY played_at DESC LIMIT -1 OFFSET 1000)").run().catch(()=>{});
  return inserted;
}
async function runCronJob(env,kind,progress=async()=>{}){
  if(kind==="telemetry"){
    await progress(10,"Checking permitted HIVE peers");
    const result=await syncTelemetryPeers(env,{force:true});
    await progress(55,"Syncing HIVE requests");
    const requests=await syncHiveRequests(env,{force:true});
    const message=`Telemetry: ${result.imported||0} new events; ${result.checked||0} peer feeds read of ${result.totalPeers||0} eligible; ${result.errors||0} errors. Request sync: ${requests.imported||0} new events. ${result.totalPeers>10?'Bounded batch; repeat to rotate through remaining peers.':''}`;
    await progress(100,message);return {...result,requests,message};
  }
  if(kind==="hash"){
    if(!env.SCANNER_SECRET)return {error:"Only supported on Docker with scanner enabled"};
    const request=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES('hash_scan_request',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(request).run();
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES('fingerprint_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({state:'queued',total:0,scanned:0,updated_at:Date.now()})).run();
    await progress(10,"SHA-256 scan queued on Docker; status comes from scanner");
    return {queued:true,local_only:true};
  }
  if(kind==="peers"){
    await refreshCommunityHealth(env.DB,8);
    const rows=(await env.DB.prepare("SELECT id,url,track_count FROM peers ORDER BY added_at LIMIT 60").all()).results;
    let updated=0;
    const config=await getCronConfig(env.DB);
    for(const [index,row] of rows.entries()){
      await progress(10+Math.round(index/Math.max(1,rows.length)*85),`Checking peer ${index+1} of ${rows.length}`);
      try{
        const res=await fetch(row.url+"/api/peer",{signal:AbortSignal.timeout(6000),headers:{accept:"application/json"}});
        if(!res.ok)continue;
        const json=await res.json();if(!json.ok)continue;
        const count=Number(json.tracks)||0;
        if(count!==Number(row.track_count))updated++;
        await env.DB.prepare("UPDATE peers SET track_count=?,name=?,last_ok=?,last_error=NULL WHERE id=?")
          .bind(count,clean(json.name)||row.url,Date.now(),row.id).run();
        if(config.jobs.peers?.sync_catalogue)await syncPeerAll(env,row);
      }catch{/* Peer remains in registry; transient network errors never delete it. */}
    }
    const requests=await syncHiveRequests(env,{force:true});
    return {checked:rows.length,updated,requests};
  }
  const cursorKey="cron_cursor_"+kind;
  const marker=await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(cursorKey).first();
  const cursor=Number(marker?.value)||Number.MAX_SAFE_INTEGER;
  // Bounded indexed scan, never full catalogue scan per scheduled event.
  let rows=(await env.DB.prepare("SELECT id,artist,artists,album,created_at FROM tracks WHERE created_at < ? ORDER BY created_at DESC LIMIT 8").bind(cursor).all()).results;
  if(!rows.length)rows=(await env.DB.prepare("SELECT id,artist,artists,album,created_at FROM tracks ORDER BY created_at DESC LIMIT 8").all()).results;
  for(const [i,row] of rows.entries()){
    await progress(10+Math.round(i/Math.max(1,rows.length)*85),`Checking ${kind} ${i+1} of ${rows.length}`);
    await warmArtistMetadata(env,row,kind);
  }
  const next=rows.length?Math.min(...rows.map(x=>Number(x.created_at)||0)):Number.MAX_SAFE_INTEGER;
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(cursorKey,String(next)).run();
  return {checked:rows.length};
}
async function runDueCronJobs(env,when=Date.now()) {
  const config=await getCronConfig(env.DB);
  if(!CRON_TYPES.some(k=>config.jobs[k]?.enabled))return [];
  const local=cronLocalDate(new Date(when),config.timezone),results=[];
  for(const kind of CRON_TYPES){
    if(kind==="telemetry")continue;
    if(!shouldRunCron(config.jobs[kind],local))continue;
    const runKey=local.year+"-"+local.month+"-"+String(local.day).padStart(2,"0")+"-"+local.hm;
    const key="cron_last_"+kind;
    await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)").bind(key,"").run();
    const r=await env.DB.prepare("UPDATE settings SET value=? WHERE key=? AND value<>?").bind(runKey,key,runKey).run();
    if(Number(r.meta?.changes??r.changes??0)===0)continue;
    try{results.push({kind,...await runCronJob(env,kind)});}
    catch(e){console.warn("WASP cron job error:",kind,e.message);results.push({kind,error:"Job failed; see logs"});}
  }
  return results;
}

// Real manual-job status, persisted for the progress bar. No fake timed progress.
async function cronRunStatus(DB,runId){
  const row=await DB.prepare("SELECT value FROM settings WHERE key=?").bind("manual_cron_"+runId).first();
  if(!row)return null;
  try{const status=JSON.parse(row.value);
    if(['queued','running'].includes(status.state) && Date.now()-Number(status.updated_at||status.started)>120000)
      return {...status,state:'error',message:'Execution was interrupted. Review logs and run again.'};
    return status;
  }catch{return null;}
}
async function setCronRunStatus(DB,runId,state){
  await DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind("manual_cron_"+runId,JSON.stringify({...state,updated_at:Date.now()})).run();
}
async function executeManualCron(env,kind,runId){
  const started=Date.now();
  const progress=async(percent,message)=>setCronRunStatus(env.DB,runId,{kind,state:'running',progress:Math.min(99,Math.round(percent)),message,started});
  try {
    await progress(1,'Preparing '+kind);
    const result=await runCronJob(env,kind,progress);
    await setCronRunStatus(env.DB,runId,{kind,state:result?.queued?'queued':result?.error?'error':'complete',progress:result?.queued?10:100,
      message:result?.error||result?.message|| (result?.queued?'Waiting for Docker scanner':'Complete'),result,started});
  }catch(error){await setCronRunStatus(env.DB,runId,{kind,state:'error',progress:0,message:String(error.message).slice(0,160),started});}
}
async function telemetryScheduleTick(env,when=Date.now(),{skipTelemetry=false}={}){
  const minute=Math.floor(when/60000), slot=((minute%5)+5)%5;
  // Separate expensive operations across invocations. Each branch does one
  // kind of work; a catalogue deadline cannot prevent telemetry ingestion.
  if(slot===1){await ensureTelemetrySchemaForMetadata(env);return {metadata:await runMetadata(env).catch(e=>({error:String(e.message)}))};}
  if(slot===2)return {matching:await reconcileHIVERequests(env).catch(e=>({error:String(e.message)}))};
  if(slot===3)return {imports:await refreshActiveSpotifyImports(env,{max:1,fetchPeers:false}).catch(e=>({error:String(e.message)}))};
  if(slot===4){
    const queued=await env.DB.prepare("SELECT 1 FROM requests WHERE status='active' LIMIT 1").first();
    const drafts=await env.DB.prepare("SELECT 1 FROM spotify_user_imports WHERE state='draft' LIMIT 1").first().catch(()=>null);
    return {catalogues:queued||drafts?await refreshSpotifyPeerCatalogue(env,{max:1}).catch(e=>({error:String(e.message)})):{checked:0}};
  }
  const config=await getCronConfig(env.DB),job=config.jobs.telemetry,minutes=Number(job.minutes)||5;
  const telemetry=!skipTelemetry&&job?.enabled&&minute%minutes===0?await syncTelemetryPeers(env).catch(e=>({error:String(e.message)})):{disabled:true};
  const requests=await syncHiveRequests(env).catch(e=>({error:String(e.message)}));
  return {telemetry,requests};
}

// New server-local announcement data is never federated into peer catalogues.
// No module-level in-flight DB promises: Workers cannot reuse request-bound IO.
const announcementTablesReady=new WeakSet();
async function ensureAnnouncementTable(DB){
  if(announcementTablesReady.has(DB))return;
  await DB.prepare(`CREATE TABLE IF NOT EXISTS server_announcements (
    id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',opacity REAL NOT NULL DEFAULT 0.87,
    created_at INTEGER NOT NULL)`).run();
  announcementTablesReady.add(DB);
}
const announcementTypes=new Set(['info','update','maintenance','upload','warning','critical']);
async function api(req, env, url, ctx) {
  const path = url.pathname;
  const m = req.method;
  const DB = env.DB;
  let x;
  // v18.1.2 — administrator-only process monitor and audit history.
  if(path.startsWith('/api/admin/processes')){
    const info=await sessionInfo(req,env);
    if(info?.role!=='admin')return json({error:'Administrator required'},403);
    if(path==='/api/admin/processes'&&m==='GET'){
      const processes=await readAdminProcesses(DB);
      if(env.SCANNER_SECRET){
        try{const response=await fetch('http://127.0.0.1:8788/_internal/offline-metadata/status',{
          headers:{'x-scanner-secret':env.SCANNER_SECRET},signal:AbortSignal.timeout(2000)
        });
          if(response.ok){const status=await response.json();if(status.active||['checking','downloading','indexing','building-indexes'].includes(status.state)){
            processes.unshift({id:'offline-db',name:'MusicBrainz offline database update',category:'Metadata',state:status.state||'running',updated_at:status.updated||Date.now(),progress:status.progress?.percent??null,message:status.phase||status.message||'Downloading or indexing MusicBrainz'});
          }}
        }catch{}
      }
      return json({processes,observed_at:Date.now()});
    }
    if(path==='/api/admin/processes/logs'&&m==='GET'){
      const page=await readAdminLog(DB,{limit:150,...parseAdminCursor(url.searchParams.get('before'))});
      return json(page);
    }
    if(path==='/api/admin/processes/logs/clear'&&m==='DELETE'){
      const body=await req.json().catch(()=>null);
      if(body?.confirm!=='clear logs')return json({error:'Type clear logs to confirm.'},400);
      await clearAdminLog(DB,info.username||'admin');return json({ok:true});
    }
    return json({error:'Not found'},404);
  }
  // v18.1.5: remote metadata sources are defined in server secrets, not by
  // arbitrary URLs passed by the browser. All import/apply routes are admin-only.
  if(path.startsWith('/api/admin/metadata-bank/')){
    const info=await sessionInfo(req,env);
    if(info?.role!=='admin')return json({error:'Administrator required'},403);
    const response=await metadataBankApi(req,env,url,{makeArtistIndex:artistIndexStatements});
    if(response.ok&&m==='POST'&&['/api/admin/metadata-bank/apply','/api/admin/metadata-bank/undo'].includes(path)){
      try{const result=await response.clone().json();if(result.applied||result.undone)await touchCatalogue(DB);}catch{}
    }
    return response;
  }
  if(path==='/api/telemetry/metadata/feed'&&m==='GET'){await ensureTelemetrySchemaForMetadata(env);return metadataFeed(env,url);}
  if(/^\/api\/admin\/telemetry\/metadata(?:\/(?:test|run|status|start|pause|stop|pull|rescan-files|offline-status|offline-download|offline-cancel))?$/.test(path)){
    const info=await sessionInfo(req,env);if(info?.role!=='admin')return json({error:'Administrator required'},403);
    await ensureTelemetrySchemaForMetadata(env);return metadataAdmin(req,env,url);
  }
  if(path==='/api/telemetry'||path==='/api/telemetry/feed'||path==='/api/telemetry/heatmap')return telemetryApi(req,env,url);
  if(path==='/api/admin/telemetry/sync'){
    const info=await sessionInfo(req,env);
    return telemetryApi(req,env,url,{admin:info?.role==='admin'});
  }
  if(path==='/api/admin/telemetry/peers' && m==='GET'){
    const info=await sessionInfo(req,env);
    if(info?.role!=='admin')return json({error:'Administrator required'},403);
    const peers=(await DB.prepare('SELECT id,name,url,last_ok,last_error FROM peers ORDER BY added_at').all()).results;
    return json({peers:peers.map(p=>({id:p.id,name:p.name||p.url,url:p.url,last_ok:p.last_ok||null,last_error:p.last_error||null}))});
  }
  // Recalculate this server's telemetry from the retained confirmed-play ledger.
  // This is deliberately distinct from importing more plays from HIVE peers.
  if(path==='/api/admin/telemetry/recalculate' && m==='POST'){
    const info=await sessionInfo(req,env);
    if(info?.role!=='admin')return json({error:'Administrator required'},403);
    await ensureTelemetrySchemaForMetadata(env);
    await DB.batch([
      DB.prepare('DELETE FROM telemetry_summary_cache'),
      DB.prepare("DELETE FROM settings WHERE key='hive_metadata_coverage_v177'")
    ]);
    const instance=(await DB.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first())?.value||'';
    const hive=await DB.prepare('SELECT COUNT(*) AS n FROM telemetry_events').first();
    const local=await DB.prepare('SELECT COUNT(*) AS n FROM telemetry_events WHERE origin_id=?').bind(instance).first();
    return json({ok:true,localPlays:Number(local?.n)||0,hivePlays:Number(hive?.n)||0,refreshedAt:Date.now(),message:'Telemetry summaries rebuilt from retained plays. No new peer events imported.'});
  }
  if(path==='/api/admin/telemetry/pull' && m==='POST'){
    const info=await sessionInfo(req,env);
    if(info?.role!=='admin')return json({error:'Administrator required'},403);
    const body=await req.json().catch(()=>null);
    if(!Array.isArray(body?.peers)||body.peers.length<1||body.peers.length>10||body.peers.some(x=>typeof x!=='string'))
      return json({error:'Select between 1 and 10 connected peers per request.'},400);
    const urls=[...new Set(body.peers)];
    const managed=(await DB.prepare('SELECT url FROM peers').all()).results.map(x=>x.url);
    if(urls.some(x=>!managed.includes(x)))return json({error:'Only administrator-connected peers may be selected.'},400);
    const outcome=await syncTelemetryPeers(env,{force:true,selectedUrls:urls}).catch(e=>({error:String(e.message).slice(0,160)}));
    return json(outcome,outcome.error?502:200);
  }

  // Admin-only manual Cron controls. An isolated run records authentic stage progress.
  if(path==="/api/admin/crons/run" && m==="POST"){
    const info=await sessionInfo(req,env);
    if(info?.role!=="admin")return json({error:"Administrator required"},403);
    const body=await req.json().catch(()=>({})),kind=String(body.kind||"");
    if(!CRON_TYPES.includes(kind))return json({error:"Invalid job"},400);
    const runId=crypto.randomUUID();
    await setCronRunStatus(DB,runId,{kind,state:'queued',progress:0,message:'Queued',started:Date.now()});
    const work=executeManualCron(env,kind,runId);
    if(ctx?.waitUntil)ctx.waitUntil(work);
    else await work;
    return json({ok:true,runId},202);
  }
  if(path==="/api/admin/crons/run-status" && m==="GET"){
    const info=await sessionInfo(req,env);
    if(info?.role!=="admin")return json({error:"Administrator required"},403);
    const id=String(url.searchParams.get('id')||'');
    if(!/^[a-f0-9-]{36}$/.test(id))return json({error:"Invalid job ID"},400);
    const status=await cronRunStatus(DB,id);
    if(!status)return json({error:"Job not found"},404);
    if(status.kind==='hash'&&status.state==='queued'){
      const scan=await DB.prepare("SELECT value FROM settings WHERE key='fingerprint_status'").first();
      try{const v=JSON.parse(scan?.value||'{}');
        if(v.state==='running')return json({...status,state:'running',progress:v.total?Math.round(Number(v.scanned)/Number(v.total)*100):10,message:`Hashed ${v.scanned||0} of ${v.total||0} files`});
        if(v.state==='complete'||v.state==='error')return json({...status,state:v.state,progress:v.state==='complete'?100:status.progress,message:v.error||(v.state==='complete'?'SHA-256 scan complete':'SHA-256 scan failed')});
      }catch{}
    }
    return json(status);
  }
  // Public mesh feed is read-only, with origin-tagged ids and no account/IP data.
  if(path==='/api/hive/requests/feed' && m==='GET')return hiveRequestFeed(env,url);
  if(path==='/api/hive/requests/status' && m==='GET'){
    const me=await sessionInfo(req,env);
    if(me?.role!=='admin')return json({error:'Admin required'},403);
    await ensureHiveRequests(env);
    const state=(await DB.prepare('SELECT url,cursor,synced_at,last_error FROM hive_request_peer_cursors ORDER BY synced_at DESC LIMIT 60').all()).results;
    return json({peers:state});
  }
  // v18.1.1: public, server-local announcements for guests AND signed-in listeners.
  // There is no user identity, cookie, telemetry event or peer federation in this feed.
  // A two-second shared edge cache bounds D1 reads when many clients are listening.
  if(path==='/api/announcements' && m==='GET'){
    const cache=(typeof caches!=='undefined'&&caches.default)?caches.default:null;
    // The cache key is origin-local, independent of cookies and query parameters.
    const cacheKey=new Request(new URL('/api/announcements',req.url));
    if(cache){try{const hit=await cache.match(cacheKey);if(hit)return hit;}catch{}}
    await ensureAnnouncementTable(DB);
    const items=(await DB.prepare(`SELECT id,title,body,severity,opacity,created_at FROM server_announcements
      WHERE created_at>=? ORDER BY created_at DESC LIMIT 20`).bind(Date.now()-30*86400000).all()).results;
    const response=json({items},200,{'cache-control':'public, max-age=0, s-maxage=2','x-content-type-options':'nosniff'});
    if(cache){const job=cache.put(cacheKey,response.clone()).catch(()=>{});if(ctx?.waitUntil)ctx.waitUntil(job);else await job;}
    return response;
  }
  // ---------- public ----------
  if(path==="/api/catalog-version" && m==="GET") {
    return json({revision:await catalogueVersion(DB)},200,{"cache-control":"no-store"});
  }
  if(path==="/api/peer-plays" && m==="GET") {
    if(!(await isSharing(DB)))return json({error:"Library is not shared"},403);
    const rows=(await DB.prepare("SELECT origin,remote_id,(plays-synced_plays) AS plays FROM peer_listens WHERE plays>synced_plays ORDER BY plays DESC LIMIT 3000").all()).results;
    return json(rows,200,{"cache-control":"no-store"});
  }
  if(path==="/api/play-peer" && m==="POST") {
    const b=await req.json().catch(()=>({}));
    const origin=clean(b.origin,300).replace(/\/$/,""),remote=clean(b.remote_id,100);
    if(!origin||!/^[\w-]{1,100}$/.test(remote) || !(await knownPeer(DB,origin)))
      return json({error:"Unknown peer track"},400);
    let canonical=origin;
    try {
      const aliases=JSON.parse(env.PEER_ORIGIN_ALIASES||"{}");
      for(const [publicOrigin,bridgeOrigin] of Object.entries(aliases)){
        if(new URL(bridgeOrigin).origin===origin && new URL(publicOrigin).protocol==="https:")canonical=new URL(publicOrigin).origin;
      }
    }catch{}
    const eventId=playEventId(req);
    const inserted=await recordListen(env,{track_id:remote,origin:canonical,remote_id:remote,title:b.title,artist:b.artist,album:b.album,cover_url:b.cover_url,duration:b.duration},{eventId});
    // Docker can send genuine listening events directly to its configured
    // source peer via Bridge. The source already exposes an anonymous /api/play
    // counter; this is what lets main Cloudflare charts reflect Docker listens.
    // Mark a local listen as synced only after the source acknowledges it, so
    // federation sums never count the same listen twice.
    if(inserted && env.PEER_PLAY_SYNC==="1" && ctx?.waitUntil){
      ctx.waitUntil((async()=>{
        try{
          const response=await fetch(origin+"/api/play/"+encodeURIComponent(remote),{
            method:"POST",signal:AbortSignal.timeout(6000),headers:{"X-WASP-Relay-Play":"1","X-WASP-Play-Id":eventId}});
          if(response.ok)await DB.prepare("UPDATE peer_listens SET synced_plays=synced_plays+1 WHERE origin=? AND remote_id=? AND synced_plays<plays").bind(canonical,remote).run();
        }catch{/* Remains locally counted if the peer cannot be reached. */}
      })());
    }
    return json({ok:true});
  }
  // Peer discovery: other instances probe this to confirm sharing is on and get a friendly name.
  if (path === "/api/peer" && m === "GET") {
    if (!(await isSharing(DB))) return json({ error: "This library is not shared on the network." }, 403);
    const site = await siteSettings(DB);
    const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM tracks").first();
    return json({ ok: true, name: site.name, title: site.name, tracks: n || 0, version: 1 });
  }
  // List of peer base URLs this instance has added (so the front-end can pull their tracks).
  if (path === "/api/network/peers" && m === "GET") {
    const rows = (await DB.prepare("SELECT id, url, name, track_count, last_ok, last_error FROM peers ORDER BY added_at").all()).results;
    const published=(await DB.prepare(`SELECT l.url,l.name,l.track_count,l.last_ok FROM user_published_peers l
      LEFT JOIN user_peer_permissions p ON p.user_id=l.user_id
      WHERE ${EFFECTIVE_PUBLISH_SQL}=1 AND l.last_error IS NULL AND l.last_ok IS NOT NULL ORDER BY l.created_at`).all()).results;
    const known=new Set(rows.map(r=>r.url));
    for(const p of published)if(!known.has(p.url)){
      rows.push({id:'community-'+await sha256(p.url),url:p.url,name:p.name||'WASP',track_count:p.track_count,last_ok:p.last_ok,last_error:null,community:true});
      known.add(p.url);
    }
    const primary=(await DB.prepare("SELECT value FROM settings WHERE key='primary_peer_id'").first())?.value||"";
    return json(rows.map((p) => ({
      id: p.id, url: p.url, name: p.name || p.url, is_primary:!p.community && p.id===primary, community:!!p.community,
      track_count: p.track_count || 0,
      online: !!(p.last_ok && !p.last_error),
      last_ok: p.last_ok || null,
    })));
  }
  if(path==="/api/peer-catalogue" && m==="GET"){
    const rows=(await DB.prepare("SELECT c.peer_id,c.synced_at,c.revision,p.url FROM peer_catalogue_cache c JOIN peers p ON p.id=c.peer_id WHERE c.synced_at>0 ORDER BY p.added_at").all()).results;
    const shards=(await DB.prepare("SELECT peer_id,kind,shard,body FROM peer_catalogue_chunks ORDER BY peer_id,kind,shard").all()).results;
    const mapping=new Map(rows.map(row=>[row.peer_id,{peer_id:row.peer_id,origin:row.url,synced_at:row.synced_at,revision:row.revision,tracks:[],playlists:[],users:[]}]));
    for(const part of shards){const item=mapping.get(part.peer_id);if(item && ["tracks","playlists","users"].includes(part.kind)){
      item[part.kind].push(...JSON.parse(part.body));
    }}
    return json([...mapping.values()],200,{"cache-control":"no-store"});
  }
  // Anonymous live playback. A session is an ephemeral random tab ID; never
  // use cookies, account data, network addresses or user identifiers here.
  if(path==="/api/active-streams" && m==="GET"){
    const now=Date.now();
    if(url.searchParams.get('routing')==='1'){
      let cached=routingDemandCache.get(DB);
      if(!cached||cached.expires<=now){
        const r=await DB.prepare('SELECT origin,COUNT(*) AS listeners FROM active_streams WHERE expires_at>? GROUP BY origin ORDER BY listeners DESC LIMIT 120').bind(now).all();
        cached={expires:now+30000,value:{sources:r.results.map(x=>({origin:x.origin||'',listeners:Number(x.listeners)||0})),observed_at:now}};routingDemandCache.set(DB,cached);
      }
      return json(cached.value);
    }
    if(url.searchParams.get('summary')==='1'){
      // A separate aggregate provides a *complete* listener count, even when
      // the song list is capped. Never expose session IDs or account details.
      const [tally,rows,keys]=await Promise.all([
        DB.prepare('SELECT COUNT(*) AS total FROM active_streams WHERE expires_at>?').bind(now).first(),
        DB.prepare(`SELECT origin,track_id,COUNT(*) AS listeners,
          MAX(CASE WHEN started_at>0 THEN started_at ELSE expires_at-${STREAM_TTL_MS} END) AS started_at
          FROM active_streams WHERE expires_at>? GROUP BY origin,track_id
          ORDER BY started_at DESC,origin,track_id LIMIT 30`).bind(now).all(),
        // Legacy Recently listened streaming icons must still work for songs
        // outside the 30-card UI cap. Never return per-listener session IDs.
        DB.prepare(`SELECT origin,track_id FROM active_streams
          WHERE expires_at>? GROUP BY origin,track_id LIMIT 1000`).bind(now).all(),
      ]);
      return json({listener_count:Number(tally?.total)||0,tracks:rows.results,keys:keys.results},200,{"cache-control":"no-store"});
    }
    // Keep the legacy array API intact for older v15.0.7/v15.0.8 clients.
    const rows=(await DB.prepare(`SELECT origin,track_id FROM active_streams
      WHERE expires_at>? GROUP BY origin,track_id LIMIT 1000`).bind(now).all()).results;
    return json(rows,200,{"cache-control":"no-store"});
  }
  if(path==="/api/active-streams" && m==="POST"){
    const b=await req.json().catch(()=>({}));
    const sessionId=typeof b.session_id==='string'?b.session_id:'';
    if(!/^[a-f0-9-]{36}$/i.test(sessionId))return json({error:'Invalid playback session'},400);
    const action=b.action;
    if(action==='stop'){
      // Only stop this tab's currently reported track; no listener identity.
      await DB.prepare('DELETE FROM active_streams WHERE session_id=?').bind(sessionId).run();
      return json({ok:true});
    }
    if(action!=='playing')return json({error:'Unknown playback state'},400);
    const origin=clean(b.origin,300).replace(/\/$/,''),trackId=clean(b.track_id,120);
    if(!/^[\w-]{1,120}$/.test(trackId))return json({error:'Invalid track'},400);
    if(origin){
      let u;try{u=new URL(origin);}catch{return json({error:'Invalid peer origin'},400);}
      if(u.origin!==origin||!['http:','https:'].includes(u.protocol)||!(await knownPeer(DB,origin)))
        return json({error:'Unknown peer'},400);
    }else if(!(await DB.prepare('SELECT 1 FROM tracks WHERE id=?').bind(trackId).first())){
      return json({error:'Unknown track'},400);
    }
    const now=Date.now();
    await DB.prepare(`INSERT INTO active_streams(session_id,origin,track_id,expires_at,started_at)
      VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      started_at=CASE WHEN active_streams.origin=excluded.origin
        AND active_streams.track_id=excluded.track_id
        THEN active_streams.started_at ELSE excluded.started_at END,
      origin=excluded.origin,track_id=excluded.track_id,expires_at=excluded.expires_at`)
      .bind(sessionId,origin,trackId,now+STREAM_TTL_MS,now).run();
    // Low-frequency deletion, not a write on every read or heartbeat.
    if(Math.random()<0.03)await DB.prepare('DELETE FROM active_streams WHERE expires_at<?').bind(Date.now()).run();
    return json({ok:true});
  }
  if(path==="/api/recent-listens" && m==="GET"){
    const rows=(await DB.prepare("SELECT r.track_id,r.origin,r.remote_id,r.title,r.artist,r.album,r.cover_url,r.played_at,COALESCE(t.plays,p.plays,0) AS plays FROM recent_listens r LEFT JOIN tracks t ON r.origin='' AND t.id=r.track_id LEFT JOIN peer_listens p ON r.origin<>'' AND p.remote_id=r.remote_id AND p.origin=r.origin ORDER BY r.played_at DESC LIMIT 50").all()).results;
    return json(rows,200,{"cache-control":"no-store"});
  }
  // Local-only scanner authentication. This secret is never configured on the production Worker.
  if(path==="/api/internal/metadata-tick" && m==="POST") {
    if(env.WASP_RUNTIME!=='docker'||!env.SCANNER_SECRET||req.headers.get('x-scanner-secret')!==env.SCANNER_SECRET)return json({error:'Forbidden'},403);
    await ensureTelemetrySchemaForMetadata(env);return json(await runMetadata(env,{continuous:true}));
  }
  if(path==="/api/internal/cron-tick" && m==="POST") {
    if(!env.SCANNER_SECRET || req.headers.get("x-scanner-secret")!==env.SCANNER_SECRET)return json({error:"Forbidden"},403);
    // Docker installations do not execute Cloudflare scheduled handlers.
    // Reuse the same five-minute, lease-controlled HIVE sync without affecting music.
    const runs=await runDueCronJobs(env);
    // Keep the private Docker cron-tick HTTP request responsive even when a
    // remote HIVE peer is slow. The five-minute sync lease protects D1 writes.
    if(typeof ctx?.waitUntil==='function')ctx.waitUntil(telemetryScheduleTick(env).catch(()=>{}));
    else await telemetryScheduleTick(env);
    return json({ok:true,runs},200,{"cache-control":"no-store"});
  }
  if(path==='/api/internal/folder-rescan-token'&&m==='GET'){
    if(env.WASP_RUNTIME!=='docker'||!env.SCANNER_SECRET||req.headers.get('x-scanner-secret')!==env.SCANNER_SECRET)return json({error:'Forbidden'},403);
    return json({token:(await DB.prepare("SELECT value FROM settings WHERE key='hive_folder_rescan_token'").first())?.value||''});
  }
  if (path === "/api/internal/folder-index" && m === "POST") {
    if (!env.SCANNER_SECRET || req.headers.get("x-scanner-secret") !== env.SCANNER_SECRET) return json({error:"Forbidden"},403);
    const body = await req.json().catch(() => ({}));
    if (!Array.isArray(body.tracks) || body.tracks.length > 5000) return json({error:"Invalid scan"},400);
    for (const t of body.tracks) {
      if (!/^folder-[a-f0-9]{40}$/.test(t.id)) continue;
      await DB.prepare("DELETE FROM file_fingerprints WHERE track_id=? AND (size<>? OR mtime_ms<>?)").bind(t.id,Number(t.size)||0,Math.floor(Number(t.mtime)||0)).run();
      const track={id:t.id,title:clean(t.title,200)||"Unknown Track",artist:clean(t.artist,200)||"Unknown Artist",
        album:clean(t.album,200)||"Unknown Album",track_no:Number(t.track_no)||0,duration:Number(t.duration)||0,size:Number(t.size)||0};
      await DB.batch([
        DB.prepare("INSERT OR IGNORE INTO tracks (id,title,artist,album,track_no,duration,size,plays,created_at,hash) VALUES (?,?,?,?,?,?,?,0,?,NULL)")
          .bind(track.id,track.title,track.artist,track.album,track.track_no,track.duration,track.size,Date.now()),
        DB.prepare("UPDATE tracks SET title=?,artist=?,album=?,track_no=?,duration=?,size=? WHERE id=?")
          .bind(track.title,track.artist,track.album,track.track_no,track.duration,track.size,track.id),
        ...artistIndexStatements(DB,track),
      ]);
      if(t.release_year||t.genre){await rememberTrackMetadata(env,track.id,{release_year:t.release_year,genre:t.genre}).catch(()=>{});await rememberFileFacts(env,track,{release_year:t.release_year,genre:t.genre}).catch(()=>{});} if(t.artist_origins||t.original_date)await rememberPicardFacts(env,track,t).catch(()=>{});
    }
    return json({ok:true,indexed:body.tracks.length});
  }
  // Docker-only scanner API, protected by the per-installation scanner secret.
  // MP3s are read-only: only their hashes and metadata are stored in D1.
  if(path==="/api/internal/fingerprints" && m==="GET"){
    if(!env.SCANNER_SECRET || req.headers.get("x-scanner-secret")!==env.SCANNER_SECRET)return json({error:"Forbidden"},403);
    const after=clean(url.searchParams.get("after"),100);
    const rows=(await DB.prepare("SELECT track_id,sha256,size,mtime_ms FROM file_fingerprints WHERE track_id>? ORDER BY track_id LIMIT 500").bind(after).all()).results;
    return json(rows);
  }
  if(path==="/api/internal/fingerprint-index" && m==="POST"){
    if(!env.SCANNER_SECRET || req.headers.get("x-scanner-secret")!==env.SCANNER_SECRET)return json({error:"Forbidden"},403);
    const b=await req.json().catch(()=>({}));
    if(!Array.isArray(b.items)||b.items.length>100)return json({error:"Invalid fingerprint batch"},400);
    const stmts=[];
    for(const t of b.items){
      if(!/^folder-[0-9a-f]{40}$/.test(t.id)||! /^[0-9a-f]{64}$/.test(t.sha256))continue;
      const path=clean(t.path,1000);
      stmts.push(DB.prepare("INSERT INTO file_fingerprints(track_id,sha256,size,mtime_ms,source_path,scanned_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tracks WHERE id=?) ON CONFLICT(track_id) DO UPDATE SET sha256=excluded.sha256,size=excluded.size,mtime_ms=excluded.mtime_ms,source_path=excluded.source_path,scanned_at=excluded.scanned_at")
        .bind(t.id,t.sha256,Math.max(0,Number(t.size)||0),Math.max(0,Math.floor(Number(t.mtime)||0)),path,Date.now(),t.id));
    }
    if(stmts.length)await DB.batch(stmts);
    if(b.status&&typeof b.status==="object"){
      const state={state:clean(b.status.state,30),total:Number(b.status.total)||0,scanned:Number(b.status.scanned)||0,changed:Number(b.status.changed)||0,updated_at:Date.now(),error:clean(b.status.error,250)};
      await DB.prepare("INSERT INTO settings(key,value) VALUES('fingerprint_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(state)).run();
    }
    return json({ok:true,saved:stmts.length});
  }
  // Reconcile fingerprint metadata with the files currently present under
  // /music. This only removes stale DB fingerprints, never the source audio
  // or playlist records. Prevents removed/moved files being counted as
  // surviving duplicates during a later administrative cleanup.
  if(path==="/api/internal/fingerprint-prune" && m==="POST"){
    if(!env.SCANNER_SECRET || req.headers.get("x-scanner-secret")!==env.SCANNER_SECRET)return json({error:"Forbidden"},403);
    const b=await req.json().catch(()=>({}));
    if(!Array.isArray(b.ids)||b.ids.length>8||b.ids.some(id=>!/^folder-[a-f0-9]{40}$/.test(id)))return json({error:"Invalid file identifiers"},400);
    if(b.ids.length)await DB.batch(b.ids.map(id=>DB.prepare("DELETE FROM file_fingerprints WHERE track_id=?").bind(id)));
    return json({ok:true,removed:b.ids.length});
  }
  if(path==="/api/internal/hash-request" && m==="GET"){
    if(!env.SCANNER_SECRET || req.headers.get("x-scanner-secret")!==env.SCANNER_SECRET)return json({error:"Forbidden"},403);
    const id=(await DB.prepare("SELECT value FROM settings WHERE key='hash_scan_request'").first())?.value||"";
    return json({request:id});
  }
  if (path === "/api/radio/top" && m === "GET") {
    // Public, anonymous, all-time aggregate: no visitor identifiers or user
    // listening history. Cache grouped results on-server to avoid repeat D1 scans.
    await ensureTelemetrySchemaForMetadata(env);
    const key='radio_top_all_v185',now=Date.now();
    const cached=await DB.prepare('SELECT body FROM telemetry_summary_cache WHERE key=? AND expires_at>?').bind(key,now).first();
    if(cached?.body){try{return json(JSON.parse(cached.body),200,{'cache-control':'public, max-age=180'});}catch{}}
    const rows=(await DB.prepare(`SELECT MIN(title) AS name, MIN(artist) AS artist,COUNT(*) AS plays
      FROM telemetry_events WHERE title<>'' AND artist<>''
      GROUP BY LOWER(TRIM(title)),LOWER(TRIM(artist)) ORDER BY plays DESC,name LIMIT 100`).all()).results;
    await DB.prepare(`INSERT INTO telemetry_summary_cache(key,body,expires_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at`)
      .bind(key,JSON.stringify(rows),now+300000).run();
    return json(rows,200,{'cache-control':'public, max-age=180'});
  }
  if (path === "/api/tracks" && m === "GET") {
    // Provide verified file/HIVE metadata with the catalogue so the browser can
    // display years and genres and build decade radios without guessing them.
    // Older databases may not have telemetry tables yet: fall back to the exact
    // original query rather than blocking music browsing during migration.
    let results;
    try {
      results=(await DB.prepare(`SELECT ${TRACK_COLS},
        COALESCE(NULLIF(tm.release_year,0),NULLIF(fa.year,0),
          CAST(am.value AS INTEGER),CAST(yt.value AS INTEGER),0) AS release_year,
        COALESCE(NULLIF(tm.genre,''),ag.value,'') AS genre
        FROM tracks t LEFT JOIN reactions r ON r.track_id=t.id
        LEFT JOIN telemetry_track_metadata tm ON tm.track_id=t.id
        LEFT JOIN hive_file_album_years fa ON fa.artist=LOWER(TRIM(t.artist)) AND fa.album=LOWER(TRIM(t.album))
        LEFT JOIN hive_metadata am ON am.artist=LOWER(TRIM(t.artist)) AND am.title='' AND am.album=LOWER(TRIM(t.album)) AND am.field='release_year' AND t.album<>''
        LEFT JOIN hive_metadata yt ON yt.artist=LOWER(TRIM(t.artist)) AND yt.title=LOWER(TRIM(t.title)) AND yt.album=LOWER(TRIM(t.album)) AND yt.field='release_year'
        LEFT JOIN hive_metadata ag ON ag.artist=LOWER(TRIM(t.artist)) AND ag.title='' AND ag.album='' AND ag.field='genre'
        GROUP BY t.id ORDER BY t.created_at DESC`).all()).results;
    } catch {
      results=(await DB.prepare(`SELECT ${TRACK_COLS} FROM tracks t LEFT JOIN reactions r ON r.track_id=t.id GROUP BY t.id ORDER BY t.created_at DESC`).all()).results;
    }
    return json(results.map((t) => { let artists; try { artists = artistsOfRow(t); } catch { artists = [t.artist || "Unknown Artist"]; } return { ...t, artists }; }));
  }
  if (path === "/api/track-reaction-counts" && m === "GET") {
    const {results}=await DB.prepare(`SELECT track_id AS id,
      COALESCE(SUM(kind='heart'),0) AS hearts,
      COALESCE(SUM(kind='like'),0) AS likes,
      COALESCE(SUM(kind='dislike'),0) AS dislikes
      FROM reactions GROUP BY track_id`).all();
    return json(results);
  }
  if (path === "/api/playlists" && m === "GET") {
    const pls = (await DB.prepare("SELECT id, name, created_at, cover_v FROM playlists ORDER BY created_at DESC").all()).results;
    const links = (await DB.prepare("SELECT playlist_id, track_id, added_at FROM playlist_tracks ORDER BY added_at, rowid").all()).results;
    const by = {}, upd = {};
    links.forEach((l) => {
      (by[l.playlist_id] ??= []).push(l.track_id);
      upd[l.playlist_id] = Math.max(upd[l.playlist_id] || 0, l.added_at);
    });
    const refs=(await DB.prepare(`SELECT DISTINCT r.ref,r.origin,r.remote_id,r.title,r.artist,r.album,r.duration,r.cover_url
      FROM peer_track_refs r JOIN playlist_tracks l ON l.track_id=r.ref`).all()).results;
    const refMap=Object.fromEntries(refs.map(r=>[r.ref,r]));
    return json(pls.map((p) => ({ ...p,updated_at:Math.max(p.created_at,upd[p.id]||0),
      tracks:by[p.id]||[],track_sources:Object.fromEntries((by[p.id]||[]).filter(id=>refMap[id]).map(id=>[id,refMap[id]])) })));
  }
  if (path === "/api/user/peer-tracks" && m === "GET") {
    const auth = await sessionInfo(req, env);
    if (!auth || auth.role !== "user") return json({error:"Sign in required."},401);
    const {results} = await DB.prepare("SELECT DISTINCT r.ref AS id, r.origin, r.remote_id, r.title, r.artist, r.album, r.duration, r.cover_url FROM peer_track_refs r JOIN user_playlist_tracks l ON l.track_id = r.ref JOIN user_playlists p ON p.id = l.playlist_id WHERE p.user_id = ?").bind(auth.user_id).all();
    return json(results);
  }
  if (path === "/api/peer-track-ref" && m === "POST") {
    const auth = await sessionInfo(req, env);
    if (!auth || auth.role !== "user") return json({error:"Sign in required."},401);
    const b = await req.json().catch(() => ({}));
    const origin = clean(b.origin, 250).replace(/\/$/, ""), remoteId = clean(b.id, 100);
    const peer = await knownPeer(DB,origin);
    if (!peer || !/^[\w-]{1,100}$/.test(remoteId)) return json({error:"Unknown peer or track."},400);
    const ref = "peer:" + await sha256(origin + "\n" + remoteId);
    const cover = clean(b.cover_url,500);
    await DB.prepare("INSERT OR IGNORE INTO peer_track_refs (ref,origin,remote_id,title,artist,album,duration,cover_url) VALUES (?,?,?,?,?,?,?,?)")
      .bind(ref,origin,remoteId,clean(b.title),clean(b.artist),clean(b.album),Number(b.duration)||0,cover).run();
    return json({ref});
  }
  if (path === "/api/user-playlists" && m === "GET") {
    const { results } = await DB.prepare("SELECT p.id, p.name, p.user_id, u.username, p.created_at, p.is_public, p.cover_v, p.cover_mode FROM user_playlists p JOIN user_accounts u ON u.id = p.user_id WHERE p.is_public = 1 ORDER BY p.created_at DESC").all();
    const links = (await DB.prepare("SELECT playlist_id, track_id FROM user_playlist_tracks ORDER BY added_at, rowid").all()).results;
    const by = {}; for (const l of links) (by[l.playlist_id] ??= []).push(l.track_id);
    // Public playlists expose the real audio location for borrowed peer tracks.
    // Without this map, a peer:sha256 reference is meaningless on a different server.
    const peerRows=(await DB.prepare("SELECT DISTINCT r.ref, r.origin, r.remote_id, r.title, r.artist, r.album, r.duration, r.cover_url FROM peer_track_refs r JOIN user_playlist_tracks l ON l.track_id = r.ref JOIN user_playlists p ON p.id = l.playlist_id WHERE p.is_public = 1").all()).results;
    const peerMap=Object.fromEntries(peerRows.map(r=>[r.ref,r]));
    return json(results.map(p => ({ ...p, tracks: by[p.id] || [],
      cover_url:p.cover_v && p.cover_mode!=="mosaic" ? `/art/user-playlist/${p.id}?v=${p.cover_v}` : null,
      track_sources:Object.fromEntries((by[p.id]||[]).filter(id=>peerMap[id]).map(id=>[id,peerMap[id]]))
    })));
  }
  if(path==="/api/playlist-heart" && m==="POST"){
    const b=await req.json().catch(()=>({})), id=clean(b.id,220);
    if(!id)return json({error:"Playlist required."},400);
    const visitor=getCookie(req,"riffvault_heart") || crypto.randomUUID();
    const signedIn=await sessionInfo(req,env);
    if(signedIn?.role==='user'&&signedIn.user_id) {
      await recordSignedInVoter(DB,signedIn,visitor);
      await recordSignedInVoter(DB,signedIn,'legacy:'+visitor);
    }
    await DB.batch([
      DB.prepare("INSERT OR IGNORE INTO playlist_hearts (playlist_id,voter) VALUES (?,?)").bind(id,visitor),
      DB.prepare("INSERT OR IGNORE INTO entity_reactions(kind,entity,voter,reaction) VALUES ('playlist',?,?,'heart')").bind(id,'legacy:'+visitor)
    ]);
    const row=await DB.prepare("SELECT COUNT(*) AS n FROM entity_reactions WHERE kind='playlist' AND entity=? AND reaction='heart'").bind(id).first();
    return json({hearts:row.n},200,{"set-cookie":`riffvault_heart=${visitor}; Path=/; SameSite=Lax; Max-Age=31536000`});
  }
  if (path === "/api/site" && m === "GET") return json(await siteSettings(DB));
  if (path === "/api/entity-reactions" && m === "GET") {
    try {
      const { results } = await DB.prepare(`SELECT kind, entity, COALESCE(SUM(reaction = 'heart'), 0) AS hearts, COALESCE(SUM(reaction = 'like'), 0) AS likes, COALESCE(SUM(reaction = 'dislike'), 0) AS dislikes FROM entity_reactions GROUP BY kind, entity`).all();
      const out = { artist: Object.create(null), playlist: Object.create(null), playlist_meta: [] };
      for (const r of results) if (out[r.kind]) out[r.kind][r.entity] = { hearts: r.hearts, likes: r.likes, dislikes: r.dislikes };
      out.playlist_meta = (await DB.prepare("SELECT id,origin,name,kind,cover_url,username,track_count FROM voted_playlist_cache").all()).results;
      return json(out, 200, { "cache-control": "no-cache" });
    } catch {
      return json({ artist: {}, playlist: {}, playlist_meta: [] }, 200, { "cache-control": "no-cache" });
    }
  }
  if (path === "/api/react-entity" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const vid = req.headers.get("X-Visitor") || "";
    const type = b.type, key = clean(b.key, 512), kind = b.kind;
    if (!/^[\w-]{8,64}$/.test(vid) || !["artist", "playlist"].includes(type) || !key || !["heart", "like", "dislike"].includes(kind)) return json({ error: "Bad request." }, 400);
    const origin = clean(b.origin, 250).replace(/\/$/, "");
    let trustedRemote = false;
    if (origin) {
      try { const u=new URL(origin);if(!["http:","https:"].includes(u.protocol)||u.href.replace(/\/$/,"")!==origin) return json({error:"Invalid peer."},400); }
      catch { return json({error:"Invalid peer."},400); }
      trustedRemote = await knownPeer(DB,origin);
    }
    if (type === "artist") {
      const local = await libraryHasArtist(DB, key);
      // Peer-only artists can receive votes on this server, but the source
      // must be a configured peer. Voting never alters the source peer.
      if (!local && !trustedRemote) return json({ error: "Artist not found on this server or a connected peer." }, 404);
    } else {
      const managed=await DB.prepare("SELECT 1 FROM playlists WHERE id = ?").bind(key).first();
      const user=await DB.prepare("SELECT user_id,is_public FROM user_playlists WHERE id = ?").bind(key).first();
      const sessionUser=user ? await sessionInfo(req,env) : null;
      const owned=!!user && (user.is_public || (sessionUser && (sessionUser.role==='admin' || sessionUser.user_id===user.user_id)));
      const remoteId=trustedRemote && key.startsWith(origin+'|') ? key.slice(origin.length+1) : '';
      const validPeer=!!remoteId && /^[\w-]{1,128}$/.test(remoteId);
      if (!managed && !owned && !validPeer) return json({ error: "Playlist not found on this server or a connected peer." }, 404);
      if (validPeer) {
        const name=clean(b.name,180)||'Peer playlist';
        const kind=b.playlist_kind==='user'?'user':'server';
        let cover='';
        const candidate=clean(b.cover_url,1000);
        try {
          if (!candidate) throw new Error('No cover URL');
          const url=new URL(candidate,origin+'/');
          // Remote peer artwork must come from the registered source or be
          // proxied on this server; reject untrusted arbitrary destinations.
          if(url.origin===origin && ['https:','http:'].includes(url.protocol))cover=url.href.slice(0,1000);
          else if(candidate.startsWith('/_peer/'))cover=candidate.slice(0,1000);
        } catch {}
        await DB.prepare(`INSERT INTO voted_playlist_cache(id,origin,name,kind,cover_url,username,track_count,updated_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,kind=excluded.kind,cover_url=CASE WHEN excluded.cover_url!='' THEN excluded.cover_url ELSE voted_playlist_cache.cover_url END,
          username=excluded.username,track_count=excluded.track_count,updated_at=excluded.updated_at`)
          .bind(key,origin,name,kind,cover,clean(b.username,64),Math.max(0,Math.min(100000,Number(b.track_count)||0)),Date.now()).run();
      }
    }
    const voter = await sha256(vid), stmts = [];
    await recordSignedInVoter(DB,await sessionInfo(req,env),voter);
    if (b.on === true) {
      stmts.push(DB.prepare("INSERT OR IGNORE INTO entity_reactions (kind, entity, voter, reaction) VALUES (?,?,?,?)").bind(type, key, voter, kind));
      const other = kind === "like" ? "dislike" : kind === "dislike" ? "like" : null;
      if (other) stmts.push(DB.prepare("DELETE FROM entity_reactions WHERE kind = ? AND entity = ? AND voter = ? AND reaction = ?").bind(type, key, voter, other));
    } else stmts.push(DB.prepare("DELETE FROM entity_reactions WHERE kind = ? AND entity = ? AND voter = ? AND reaction = ?").bind(type, key, voter, kind));
    try {
      await DB.batch(stmts);
      return json(await DB.prepare(`SELECT COALESCE(SUM(reaction = 'heart'), 0) AS hearts, COALESCE(SUM(reaction = 'like'), 0) AS likes, COALESCE(SUM(reaction = 'dislike'), 0) AS dislikes FROM entity_reactions WHERE kind = ? AND entity = ?`).bind(type, key).first());
    } catch (e) {
      console.error('reaction persistence failed:',e);
      return json({error:'Could not save reaction. Please retry.'},500);
    }
  }
  if (path === "/api/lineup" && m === "GET") { // pictures of the band members (looked up once, then saved)
    const name = clean(url.searchParams.get("name"));
    if (!name || !(await libraryHasArtist(DB, name))) return json({ members: [] }, 404);
    const row = await DB.prepare("SELECT members FROM artist_info WHERE name = ?").bind(name).first();
    if (!row || !row.members) return json({ members: [] });
    let members; try { members = await enrichMembers(env, name, row); } catch { try { members = JSON.parse(row.members); } catch { members = []; } }
    return json({ members }, 200, { "cache-control": "no-cache" });
  }
  if (path === "/api/spotify/search-playlists" && m === "GET") {
    const q=clean(url.searchParams.get("q"),80);
    if(q.length<2)return json([]);
    try { return await spotifySearchPlaylists(env,q); }
    catch { return json({error:"Unable to reach Spotify right now. Paste a playlist link instead."},502); }
  }
  if (path === "/api/suggest" && m === "GET") return suggest(url);
  if (path === "/api/bio" && m === "GET") return serveBio(env, url, ctx);
  if (path === "/api/similar" && m === "GET") return serveSimilar(env, url);
  if (path === "/api/genres" && m === "GET") {
    const { results } = await DB.prepare("SELECT name, genres FROM artist_info WHERE wtitle IS NOT NULL AND genres != '[]'").all();
    return json(Object.fromEntries(results.map((r) => [r.name, parseGenres(r)])), 200, { "cache-control": "public, max-age=60" });
  }
  if (path === "/api/lyrics" && m === "GET") {
    if (url.searchParams.has("title") && url.searchParams.has("artist")) {
      const title = clean(url.searchParams.get("title"),160), artist = clean(url.searchParams.get("artist"),160);
      if (!title || !artist) return json({error:"Missing metadata"},400);
      const key = "lyrics-peer/" + await sha256((artist + "\n" + title).toLowerCase());
      const cached = await env.MUSIC.get(key);
      if (cached) return json(await cached.json());
      try {
        const song = {title, artists:[artist], album:clean(url.searchParams.get("album"),160), duration:Number(url.searchParams.get("duration"))||0};
        const [lr,ov] = await Promise.allSettled([lrclibChain(song, AbortSignal.timeout(7000)), ovhChain(song, AbortSignal.timeout(7000))]);
        const found = [lr,ov].find(r=>r.status === "fulfilled" && r.value && (r.value.plain || r.value.synced))?.value;
        if (!found) return json({error:"No lyrics found"},404);
        const result = {synced:found.synced||null, plain:found.plain||null, instrumental:!!found.instrumental, source:found.source};
        await env.MUSIC.put(key,JSON.stringify(result),{httpMetadata:{contentType:"application/json"}});
        return json(result);
      } catch {return json({error:"Lyrics unavailable"},502);}
    }
    return serveLyrics(env, url);
  }
  if (path === "/api/requests" && m === "GET") {
    const { results } = await DB.prepare("SELECT id, kind, title, artist, album, image, url, created_at, meta FROM requests WHERE status = 'active' ORDER BY created_at, rowid").all();
    const local=results.map(({ meta, ...r }) => {
      let m = null; try { m = meta ? JSON.parse(meta) : null; } catch {}
      return m ? { ...r, total: m.total, partial: !!m.partial, matched: m.matched ?? null, matched_local:m.matched_local??m.review?.matched_local??null,matched_peer:m.matched_peer??m.review?.matched_peer??null,availability_checked_at:m.availability_checked_at??m.review?.availability_checked_at??null } : r;
    });
    const remote=await hiveRequestsForDisplay(env);
    return json([...local,...remote].sort((a,b)=>a.created_at-b.created_at));
  }
  if (path === "/api/requests/history" && m === "GET") {
    const { results } = await DB.prepare("SELECT id, kind, title, artist, album, image, done_at, playlist_id FROM requests WHERE status = 'done' ORDER BY done_at DESC LIMIT 300").all();
    const remote=await hiveRequestsForDisplay(env,{history:true});
    return json([...results,...remote].sort((a,b)=>Number(b.done_at)-Number(a.done_at)).slice(0,300));
  }
  if (path === "/api/request" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const vid = req.headers.get("X-Visitor") || "";
    if (!/^[\w-]{8,64}$/.test(vid) || !["song", "artist", "album", "playlist"].includes(b.kind)) return json({ error: "Bad request." }, 400);
    const voter = await sha256(vid), ipH = await sha256(req.headers.get("CF-Connecting-IP") || "unknown");
    const lim = await DB.prepare(
      `SELECT COALESCE(SUM(created_at > ?1 AND voter = ?2), 0) AS v, COALESCE(SUM(created_at > ?1 AND ip = ?3), 0) AS i, COALESCE(SUM(status = 'active'), 0) AS n FROM requests`)
      .bind(Date.now() - 86400000, voter, ipH).first();
    if (lim.v >= 10 || lim.i >= 20) return json({ error: "You've made a lot of requests today. Please try again tomorrow." }, 429);
    if (lim.n >= 500) return json({ error: "The queue is full right now. Please try again later." }, 429);
    let item;
    try { item = b.kind === "playlist" ? await spotifyPlaylist(String(b.url ?? "")) : await deezerItem(b.kind, String(b.id ?? "")); }
    catch { return json({ error: "Couldn't reach the search service. Try again in a moment." }, 502); }
    if (!item) return json({ error: "We couldn't find that. Try searching again." }, 404);
    if (item.error) return json({ error: item.error }, 400);
    if (await DB.prepare("SELECT 1 FROM requests WHERE dedupe = ?").bind(item.dedupe).first())
      return json({ error: "That's already in the queue.", code: "in_queue" }, 409);
    if (['song','playlist'].includes(item.kind) && await inLibrary(DB, item)) return json({ error: "That's already in the library.", code: "in_library" }, 409);
    try {
      if(item.meta){
        const matched=await matchPlaylistHIVE(env,item.meta.tracks);
        item.meta.matched=matched.matched.length;
        item.meta.matched_local=matched.local_count;
        item.meta.matched_peer=matched.peer_count;
        item.meta.matched_missing=matched.missing;item.meta.availability_checked_at=Date.now();
      }
      await recordSignedInVoter(DB,await sessionInfo(req,env),voter);
      const newId=crypto.randomUUID(),createdAt=Date.now();
      const record={id:newId,kind:item.kind,title:item.title,artist:item.artist||'',album:item.album||'',
        image:item.image||'',url:item.url||'',created_at:createdAt,meta:item.meta?JSON.stringify(item.meta):null};
      await DB.prepare("INSERT INTO requests (id, kind, title, artist, album, image, url, dedupe, voter, ip, created_at, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(newId, item.kind, item.title, item.artist || "", item.album || "", item.image, item.url || null, item.dedupe, voter, ipH, createdAt, record.meta).run();
      try{await publishHiveRequest(env,record);}catch(e){console.warn('Request federation broadcast delayed:',e.message);}
    } catch { return json({ error: "That's already in the queue.", code: "in_queue" }, 409); }
    const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'active'").first();
    return json({ ok: true, position: n }, 201);
  }
  // v18.0.7: independent 1–5 star votes. Legacy likes/dislikes stay in the
  // database for reversibility; they are no longer displayed or written here.
  // v18.0.8: star-ranked public charts. Use aggregates only; never expose
  // voter identifiers or private user playlist IDs. Peer keys must belong to
  // an explicitly registered server. Sum of stars is the ranking score.
  if(path==='/api/stars/rankings' && m==='GET'){
    const type=clean(url.searchParams.get('type'),20);
    const least=url.searchParams.get('sort')==='least';
    if(!['track','artist','playlist'].includes(type))return json({error:'Invalid star ranking type'},400);
    const visible=type==='track'?
      `AND (EXISTS(SELECT 1 FROM tracks t WHERE t.id=target_key) OR EXISTS(SELECT 1 FROM peers p WHERE instr(target_key,p.url||'|')=1))`:
      type==='playlist'?
      `AND (EXISTS(SELECT 1 FROM playlists p WHERE p.id=target_key) OR EXISTS(SELECT 1 FROM user_playlists p WHERE p.id=target_key AND p.is_public=1) OR EXISTS(SELECT 1 FROM peers p WHERE instr(target_key,p.url||'|')=1))`:'';
    try{
      const rows=(await DB.prepare(`SELECT target_key AS key,COALESCE(SUM(stars),0) AS score,COUNT(*) AS votes,ROUND(AVG(stars),2) AS average
        FROM star_votes WHERE target_type=? ${visible} GROUP BY target_key
        ORDER BY score ${least?'ASC':'DESC'},votes ${least?'ASC':'DESC'},average ${least?'ASC':'DESC'},target_key ASC LIMIT 100`).bind(type).all()).results||[];
      return json({items:rows});
    }catch(e){
      // Fresh installations may not yet have received their first star vote.
      if(/no such table:\s*star_votes/i.test(String(e?.message||e)))return json({items:[]});
      throw e;
    }
  }
  if(path==='/api/stars/batch' && m==='POST'){
    const b=await req.json().catch(()=>({}));const targets=Array.isArray(b.targets)?b.targets:[];
    if(targets.length>120||targets.some(t=>!['track','artist','playlist'].includes(t.type)||typeof t.key!=='string'||!t.key||t.key.length>512))return json({error:'Invalid rating lookup'},400);
    await DB.prepare(`CREATE TABLE IF NOT EXISTS star_votes(target_type TEXT NOT NULL,target_key TEXT NOT NULL,voter TEXT NOT NULL,stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),updated_at INTEGER NOT NULL,PRIMARY KEY(target_type,target_key,voter))`).run();
    await DB.prepare('CREATE INDEX IF NOT EXISTS idx_star_votes_target ON star_votes(target_type,target_key)').run();
    const visitor=req.headers.get('X-Visitor')||'';
    const signedIn=await sessionInfo(req,env);
    const voter=signedIn?.role==='user'&&signedIn.user_id?accountReactionVoter(signedIn):/^[\w-]{8,64}$/.test(visitor)?await sha256(visitor):'';
    const keys=[...new Set(targets.map(t=>t.type+'\x1f'+t.key))];if(!keys.length)return json({items:[]});
    const ph=keys.map(()=>'?').join(',');
    const rs=(await DB.prepare(`SELECT target_type AS type,target_key AS key,COUNT(*) AS votes,AVG(stars) AS average,MAX(CASE WHEN voter=? THEN stars ELSE 0 END) AS mine FROM star_votes WHERE target_type||char(31)||target_key IN (${ph}) GROUP BY target_type,target_key`).bind(voter,...keys).all()).results||[];
    return json({items:rs});
  }
  if(path==='/api/stars' && m==='POST'){
    const b=await req.json().catch(()=>({})),type=b.type,key=clean(b.key,512),score=Number(b.stars);
    const visitor=req.headers.get('X-Visitor')||'';
    if(!/^[\w-]{8,64}$/.test(visitor)||!['track','artist','playlist'].includes(type)||!key||!Number.isInteger(score)||score<0||score>5)return json({error:'Invalid star rating.'},400);
    const origin=clean(b.origin,250).replace(/\/$/,'');
    let trusted=false;if(origin)trusted=!!(await knownPeer(DB,origin));
    if(type==='track'){
      if(origin){const remoteId=clean(b.remote_id,120);if(!trusted||!remoteId||key!==origin+'|'+remoteId)return json({error:'Unknown peer track'},404);}
      else if(!/^[\w-]{1,120}$/.test(key)||!(await DB.prepare('SELECT 1 FROM tracks WHERE id=?').bind(key).first()))return json({error:'Unknown track'},404);
    }else if(type==='artist'){
      if(!await libraryHasArtist(DB,key) && !trusted)return json({error:'Artist unavailable'},404);
    }else{
      const server=await DB.prepare('SELECT 1 FROM playlists WHERE id=?').bind(key).first();
      const user=await DB.prepare('SELECT user_id,is_public FROM user_playlists WHERE id=?').bind(key).first();
      const account=await sessionInfo(req,env);
      const owned=!!user&&(user.is_public||account&&(account.role==='admin'||account.user_id===user.user_id));
      if(!server&&!owned&&!(trusted&&key.startsWith(origin+'|')))return json({error:'Playlist unavailable'},404);
    }
    await DB.prepare(`CREATE TABLE IF NOT EXISTS star_votes(target_type TEXT NOT NULL,target_key TEXT NOT NULL,voter TEXT NOT NULL,stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),updated_at INTEGER NOT NULL,PRIMARY KEY(target_type,target_key,voter))`).run();
    await DB.prepare('CREATE INDEX IF NOT EXISTS idx_star_votes_target ON star_votes(target_type,target_key)').run();
    const signedIn=await sessionInfo(req,env);
    const voter=signedIn?.role==='user'&&signedIn.user_id?accountReactionVoter(signedIn):await sha256(visitor);
    if(score===0)await DB.prepare('DELETE FROM star_votes WHERE target_type=? AND target_key=? AND voter=?').bind(type,key,voter).run();
    else await DB.prepare('INSERT INTO star_votes(target_type,target_key,voter,stars,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(target_type,target_key,voter) DO UPDATE SET stars=excluded.stars,updated_at=excluded.updated_at').bind(type,key,voter,score,Date.now()).run();
    const row=await DB.prepare('SELECT COUNT(*) AS votes,COALESCE(AVG(stars),0) AS average FROM star_votes WHERE target_type=? AND target_key=?').bind(type,key).first();
    return json({...row,mine:score});
  }
  // A small, public, read-only snapshot of the currently playing song's
  // reactions. Browsers poll it for near-real-time counts; no user session is
  // required and no peer is contacted. Peer identities are scoped by origin.
  if (path === "/api/reaction-state" && m === "GET") {
    const visitor=req.headers.get("X-Visitor")||"";
    const voter=/^[\w-]{8,64}$/.test(visitor)?await sha256(visitor):"";
    const origin=clean(url.searchParams.get("origin"),250).replace(/\/$/,"");
    const remoteId=clean(url.searchParams.get("remote_id"),100);
    const localId=clean(url.searchParams.get("id"),100);
    let id;
    if (origin || remoteId) {
      if (!origin || !/^[\w-]{1,100}$/.test(remoteId)) return json({error:"Invalid peer song."},400);
      const known=await knownPeer(DB,origin);
      if (!known) return json({error:"Unknown peer."},404);
      id="peer-"+await sha256(origin+"\n"+remoteId);
    } else {
      if (!/^[\w-]{1,100}$/.test(localId)) return json({error:"Invalid song."},400);
      const known=await DB.prepare("SELECT 1 FROM tracks WHERE id = ?").bind(localId).first();
      if (!known) return json({error:"Song unavailable."},404);
      id=localId;
    }
    const signedIn=await sessionInfo(req,env);
    const effectiveVoter=signedIn?.role==='user'&&signedIn.user_id?accountReactionVoter(signedIn):voter;
    const counts=await DB.prepare(`SELECT
      COALESCE(SUM(kind='heart'),0) AS hearts,
      COALESCE(SUM(kind='like'),0) AS likes,
      COALESCE(SUM(kind='dislike'),0) AS dislikes,
      COALESCE(MAX(voter=? AND kind='heart'),0) AS my_heart,
      COALESCE(MAX(voter=? AND kind='like'),0) AS my_like,
      COALESCE(MAX(voter=? AND kind='dislike'),0) AS my_dislike
      FROM reactions WHERE track_id=?`).bind(effectiveVoter,effectiveVoter,effectiveVoter,id).first();
    if(signedIn?.role==='user'&&signedIn.user_id){
      const saved=(await DB.prepare('SELECT kind FROM user_song_reactions WHERE user_id=? AND track_id=?')
        .bind(signedIn.user_id,id).all()).results;
      for(const r of saved)if(['heart','like','dislike'].includes(r.kind))counts['my_'+r.kind]=1;
    }
    return json(counts,200,{"cache-control":"no-store"});
  }
  // Peer-song reactions are kept in THIS server's D1. A peer's original
  // music, reactions and library are never modified by local listeners.
  if (path === "/api/peer-reactions" && m === "GET") {
    const visitor = req.headers.get("X-Visitor") || "";
    const voter = /^[\w-]{8,64}$/.test(visitor) ? await sha256(visitor) : "";
    const signedIn=await sessionInfo(req,env);
    const effectiveVoter=signedIn?.role==='user'&&signedIn.user_id?accountReactionVoter(signedIn):voter;
    const { results } = await DB.prepare(`SELECT p.id, p.origin, p.remote_id,
      COALESCE(SUM(r.kind = 'heart'),0) AS hearts,
      COALESCE(SUM(r.kind = 'like'),0) AS likes,
      COALESCE(SUM(r.kind = 'dislike'),0) AS dislikes,
      p.title, p.artist, p.album, p.duration, p.cover_url, p.created_at,
      COALESCE(MAX(r.voter = ? AND r.kind = 'heart'),0) AS my_heart,
      COALESCE(MAX(r.voter = ? AND r.kind = 'like'),0) AS my_like,
      COALESCE(MAX(r.voter = ? AND r.kind = 'dislike'),0) AS my_dislike
      FROM peer_reaction_tracks p LEFT JOIN reactions r ON r.track_id = p.id
      GROUP BY p.id`).bind(effectiveVoter,effectiveVoter,effectiveVoter).all();
    if(signedIn?.role==='user'&&signedIn.user_id){
      const saved=(await DB.prepare('SELECT track_id,kind FROM user_song_reactions WHERE user_id=?')
        .bind(signedIn.user_id).all()).results;
      const own=new Set(saved.map(r=>r.track_id+'|'+r.kind));
      for(const row of results)for(const kind of ['heart','like','dislike'])
        if(own.has(row.id+'|'+kind))row['my_'+kind]=1;
    }
    return json(results);
  }
  if (path === "/api/peer-react" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const origin = clean(b.origin, 250).replace(/\/$/, "");
    const remoteId = clean(b.remote_id, 100);
    const vid = req.headers.get("X-Visitor") || "";
    if (!/^[\w-]{8,64}$/.test(vid) || !["heart","like","dislike"].includes(b.kind) ||
        !/^[\w-]{1,100}$/.test(remoteId) || !origin) return json({error:"Invalid reaction."},400);
    const peer = await knownPeer(DB,origin);
    if (!peer) return json({error:"Unknown peer."},404);
    const id = "peer-" + await sha256(origin + "\n" + remoteId);
    const browserVoter=await sha256(vid);
    const signedIn=await sessionInfo(req,env);
    const voter=signedIn?.role==='user'&&signedIn.user_id?accountReactionVoter(signedIn):browserVoter;
    const kind = b.kind;
    const title = clean(b.title, 200), artist = clean(b.artist, 200);
    const album = clean(b.album, 200);
    const duration = Math.max(0, Math.min(86400, Number(b.duration) || 0));
    let cover = "";
    try {
      const candidate = new URL(String(b.cover_url || ""));
      if (["https:", "http:"].includes(candidate.protocol)) cover = clean(candidate.href, 500);
    } catch {}
    const statements = [DB.prepare(`INSERT OR IGNORE INTO peer_reaction_tracks
      (id,origin,remote_id,created_at,title,artist,album,duration,cover_url)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(id,origin,remoteId,Date.now(),title,artist,album,duration,cover),
      DB.prepare(`UPDATE peer_reaction_tracks SET
        title=CASE WHEN ? != '' THEN ? ELSE title END,
        artist=CASE WHEN ? != '' THEN ? ELSE artist END,
        album=CASE WHEN ? != '' THEN ? ELSE album END,
        duration=CASE WHEN ? > 0 THEN ? ELSE duration END,
        cover_url=CASE WHEN ? != '' THEN ? ELSE cover_url END WHERE id=?`)
        .bind(title,title,artist,artist,album,album,duration,duration,cover,cover,id)];
    if(signedIn?.role==='user'&&signedIn.user_id&&browserVoter!==voter)
      statements.push(DB.prepare('DELETE FROM reactions WHERE track_id=? AND voter=? AND kind=?').bind(id,browserVoter,kind));
    if (b.on === true) {
      statements.push(DB.prepare("INSERT OR IGNORE INTO reactions(track_id,voter,kind) VALUES (?,?,?)").bind(id,voter,kind));
      const other = kind === "like" ? "dislike" : kind === "dislike" ? "like" : null;
      if (other) statements.push(DB.prepare("DELETE FROM reactions WHERE track_id = ? AND voter = ? AND kind = ?").bind(id,voter,other));
    } else {
      statements.push(DB.prepare("DELETE FROM reactions WHERE track_id = ? AND voter = ? AND kind = ?").bind(id,voter,kind));
    }
    await recordSignedInVoter(DB,signedIn,browserVoter);
    if (signedIn?.role === "user" && signedIn.user_id) {
      if (b.on === true) {
        statements.push(DB.prepare("INSERT OR IGNORE INTO user_song_reactions(user_id,track_id,kind) VALUES (?,?,?)").bind(signedIn.user_id,id,kind));
        const other=kind === "like" ? "dislike" : kind === "dislike" ? "like" : null;
        if (other) statements.push(DB.prepare("DELETE FROM user_song_reactions WHERE user_id = ? AND track_id = ? AND kind = ?").bind(signedIn.user_id,id,other));
      } else statements.push(DB.prepare("DELETE FROM user_song_reactions WHERE user_id = ? AND track_id = ? AND kind = ?").bind(signedIn.user_id,id,kind));
    }
    await DB.batch(statements);
    const counts = await DB.prepare(`SELECT COALESCE(SUM(kind = 'heart'),0) AS hearts,
      COALESCE(SUM(kind = 'like'),0) AS likes, COALESCE(SUM(kind = 'dislike'),0) AS dislikes
      FROM reactions WHERE track_id = ?`).bind(id).first();
    return json({ ...counts, origin, remote_id:remoteId });
  }
  if ((x = path.match(/^\/api\/play\/([\w-]+)$/)) && m === "POST") {
    const track=await DB.prepare("SELECT id,title,artist,album,duration FROM tracks WHERE id=?").bind(x[1]).first();
    if(!track)return json({error:"Track not found"},404);
    await recordListen(env,{track_id:track.id,remote_id:track.id,title:track.title,artist:track.artist,album:track.album,duration:track.duration},{relayed:req.headers.get("x-wasp-relay-play")==="1",eventId:playEventId(req)});
    return json({ ok: true });
  }
  if ((x = path.match(/^\/api\/react\/([\w-]+)$/)) && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const vid = req.headers.get("X-Visitor") || "";
    if (!/^[\w-]{8,64}$/.test(vid) || !["heart", "like", "dislike"].includes(b.kind)) return json({ error: "Bad request." }, 400);
    if (!(await DB.prepare("SELECT 1 FROM tracks WHERE id = ?").bind(x[1]).first())) return json({ error: "Not found." }, 404);
    const browserVoter=await sha256(vid), id=x[1], kind=b.kind;
    const signedIn=await sessionInfo(req,env);
    const voter=signedIn?.role==='user'&&signedIn.user_id?accountReactionVoter(signedIn):browserVoter;
    const stmts = [];
    if(signedIn?.role==='user'&&signedIn.user_id&&browserVoter!==voter)
      stmts.push(DB.prepare('DELETE FROM reactions WHERE track_id=? AND voter=? AND kind=?').bind(id,browserVoter,kind));
    if (b.on) {
      stmts.push(DB.prepare("INSERT OR IGNORE INTO reactions (track_id, voter, kind) VALUES (?, ?, ?)").bind(id, voter, kind));
      const other = kind === "like" ? "dislike" : kind === "dislike" ? "like" : null; // like and dislike exclude each other
      if (other) stmts.push(DB.prepare("DELETE FROM reactions WHERE track_id = ? AND voter = ? AND kind = ?").bind(id, voter, other));
    } else {
      stmts.push(DB.prepare("DELETE FROM reactions WHERE track_id = ? AND voter = ? AND kind = ?").bind(id, voter, kind));
    }
    await recordSignedInVoter(DB,signedIn,browserVoter);
    if (signedIn?.role === "user" && signedIn.user_id) {
      if (b.on) {
        stmts.push(DB.prepare("INSERT OR IGNORE INTO user_song_reactions (user_id,track_id,kind) VALUES (?,?,?)").bind(signedIn.user_id,id,kind));
        if (kind === "like" || kind === "dislike") stmts.push(DB.prepare("DELETE FROM user_song_reactions WHERE user_id = ? AND track_id = ? AND kind = ?").bind(signedIn.user_id,id,kind === "like" ? "dislike" : "like"));
      } else stmts.push(DB.prepare("DELETE FROM user_song_reactions WHERE user_id = ? AND track_id = ? AND kind = ?").bind(signedIn.user_id,id,kind));
    }
    await DB.batch(stmts);
    const c = await DB.prepare(
      `SELECT COALESCE(SUM(kind = 'heart'), 0) AS hearts, COALESCE(SUM(kind = 'like'), 0) AS likes, COALESCE(SUM(kind = 'dislike'), 0) AS dislikes
       FROM reactions WHERE track_id = ?`).bind(id).first();
    return json(c);
  }
  if (path === "/api/register" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const username = clean(b.username, 32);
    const password = String(b.password ?? "");
    const confirm = String(b.confirm ?? "");
    const adminName = (await DB.prepare("SELECT value FROM settings WHERE key = 'admin_username'").first())?.value || "admin";
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return json({ error: "Username must be 3–32 characters using letters, numbers, _ or -." }, 400);
    if (username.toLowerCase() === "admin" || username.toLowerCase() === adminName.toLowerCase()) return json({ error: "That username is reserved." }, 409);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);
    if (password !== confirm) return json({ error: "Passwords do not match." }, 400);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const id = crypto.randomUUID();
    try {
      await DB.prepare("INSERT INTO user_accounts (id, username, salt, hash, created_at) VALUES (?,?,?,?,?)").bind(id, username, salt, await pbkdf2(password, salt), Date.now()).run();
    } catch { return json({ error: "That username is already taken." }, 409); }
    return json({ ok: true }, 201);
  }
  if (path === "/api/login" && m === "POST") {
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    await DB.prepare("DELETE FROM attempts WHERE ts < ?").bind(now - 900000).run();
    const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE ip = ?").bind(ip).first();
    if (n >= 5) return json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    const body = await req.json().catch(() => ({}));
    const loginId = clean(body.id, 50);
    const adminName = (await DB.prepare("SELECT value FROM settings WHERE key = 'admin_username'").first())?.value || "admin";
    const adminRow = loginId.toLowerCase() === adminName.toLowerCase() ? await DB.prepare("SELECT salt, hash FROM admin WHERE id = 'admin'").first() : null;
    const userRow = adminRow ? null : await DB.prepare("SELECT id, username, salt, hash FROM user_accounts WHERE username = ? COLLATE NOCASE").bind(loginId).first();
    const row = adminRow || userRow;
    const attempt = await pbkdf2(String(body.password ?? ""), row ? row.salt : DEFAULT_SALT);
    if (!row || !safeEq(attempt, row.hash)) {
      await DB.prepare("INSERT INTO attempts (ip, ts) VALUES (?, ?)").bind(ip, now).run();
      return json({ error: "Wrong ID or password." }, 401);
    }
    await DB.prepare("DELETE FROM attempts WHERE ip = ?").bind(ip).run();
    await DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(now).run();
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const role = adminRow ? "admin" : "user";
    await DB.prepare("INSERT INTO sessions (token, expires, role, user_id) VALUES (?, ?, ?, ?)").bind(await sha256(token), now + SESSION_MS, role, userRow?.id || null).run();
    return json({ ok: true, role, username: adminRow ? adminName : userRow.username }, 200, { "set-cookie": cookie(token, SESSION_MS / 1000, new URL(req.url).protocol === "https:") });
  }
  if (path === "/api/logout" && m === "POST") {
    const s = await session(req, env);
    if (s) await DB.prepare("DELETE FROM sessions WHERE token = ?").bind(s).run();
    return json({ ok: true }, 200, { "set-cookie": cookie("", 0, new URL(req.url).protocol === "https:") });
  }
  if (path === "/api/me") {
    const info = await sessionInfo(req, env);
    if (!info) return json({ authenticated: false, admin: false });
    if (info.role === "admin") {
      const username = (await DB.prepare("SELECT value FROM settings WHERE key = 'admin_username'").first())?.value || "admin";
      return json({ authenticated: true, admin: true, role: "admin", username });
    }
    const u = await DB.prepare("SELECT username FROM user_accounts WHERE id = ?").bind(info.user_id).first();
    const notice=await DB.prepare('SELECT 1 FROM user_publish_approval_notices WHERE user_id=? AND viewed_at=0').bind(info.user_id).first();
    return json({ authenticated: !!u, admin: false, role: "user", username: u?.username || "", publish_notice:!!notice });
  }

  const auth = await sessionInfo(req, env);
  // Retain the v18.1.0 user-only endpoint for older clients. New public
  // clients subscribe to /api/announcements and do not need a login.
  if (path === '/api/user/announcements' && m === 'GET'){
    if(!auth || auth.role!=='user')return json({error:'User login required.'},401);
    await ensureAnnouncementTable(DB);
    const created=(await DB.prepare('SELECT created_at FROM user_accounts WHERE id=?').bind(auth.user_id).first())?.created_at||0;
    const items=(await DB.prepare(`SELECT id,title,body,severity,opacity,created_at FROM server_announcements
      WHERE created_at>=? AND created_at>=? ORDER BY created_at DESC LIMIT 20`)
      .bind(Date.now()-30*86400000,created).all()).results;
    return json({items},200,{'cache-control':'private, no-store'});
  }
  if (path.startsWith("/api/user/")) {
    // Authenticated user operations; admin credentials are handled separately.

    if (!auth || auth.role !== "user") return json({ error: "User login required." }, 401);
    // Import Spotify into the user's own private playlist. The request queue
    // receives ONLY absent song entries; the playlist itself is never posted.
    if(path==='/api/user/spotify-import' && m==='POST'){
      await ensureSpotifyImportSchema(DB);
      const b=await req.json().catch(()=>({}));
      let item;try{item=await spotifyPlaylist(String(b.url||''));}catch{return json({error:'Spotify metadata is unavailable right now.'},502);}
      if(item.error)return json({error:item.error},400);
      if(!item.meta?.tracks?.length)return json({error:'Spotify did not expose the playlist songs. Try another public playlist or reconnect later; no empty playlist was created.'},422);
      const active=(await DB.prepare("SELECT COUNT(*) AS count FROM spotify_user_imports WHERE user_id=? AND state='draft'").bind(auth.user_id).first())?.count||0;
      if(active>=10)return json({error:'Finish an existing Spotify import before creating more (maximum 10).'},429);
      if(await DB.prepare('SELECT id FROM spotify_user_imports WHERE user_id=? AND spotify_url=?').bind(auth.user_id,item.url).first())
        return json({error:'You already imported this Spotify playlist.'},409);
      const name=clean(item.title,80),now=Date.now(),playlistId=crypto.randomUUID(),importId=crypto.randomUUID();
      // Unique per user; never overwrite an existing playlist with same name.
      let unique=name;for(let n=2;n<100;n++){
        if(!(await DB.prepare('SELECT 1 FROM user_playlists WHERE user_id=? AND name=?').bind(auth.user_id,unique).first()))break;
        unique=name.slice(0,69)+' ('+n+')';
      }
      await DB.batch([
        DB.prepare("INSERT INTO user_playlists(id,user_id,name,is_public,created_at,cover_mode) VALUES(?,?,?,0,?,'copied')")
          .bind(playlistId,auth.user_id,unique,now),
        DB.prepare(`INSERT INTO spotify_user_imports
          (id,user_id,playlist_id,spotify_url,cover_url,tracks_json,total,partial,missing,updated_at,created_at,source_total)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(importId,auth.user_id,playlistId,item.url,item.image||'',JSON.stringify(item.meta.tracks),
            item.meta.total,item.meta.partial?1:0,item.meta.total,now,now,item.meta.source_total)
      ]);
      await saveSpotifyImportedCover(env,playlistId,item.image).catch(()=>{});
      const info=await refreshSpotifyUserImport(env,{id:importId,playlist_id:playlistId,user_id:auth.user_id,
        tracks_json:JSON.stringify(item.meta.tracks),total:item.meta.total,partial:item.meta.partial,
        created_at:now,state:'draft',source_total:item.meta.source_total},{fetchPeers:true});
      return json({ok:true,...info,name:unique,source_url:item.url},201);
    }
    if(path==='/api/user/spotify-imports' && m==='GET'){
      await ensureSpotifyImportSchema(DB);
      const items=(await DB.prepare(`SELECT id,playlist_id,spotify_url,total,partial,matched,
        local_count AS local,peer_count AS peer,missing,state,updated_at,source_total,completed_partial,user_supplied_count FROM spotify_user_imports
        WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).bind(auth.user_id).all()).results;
      return json(items);
    }
    if((x=path.match(/^\/api\/user\/spotify-imports\/([\w-]+)\/missing$/))&&m==='GET'){
      await ensureSpotifyImportSchema(DB);
      const imp=await DB.prepare('SELECT * FROM spotify_user_imports WHERE id=? AND user_id=?').bind(x[1],auth.user_id).first();
      if(!imp)return json({error:'Spotify import not found.'},404);
      const known=imp.missing_json?JSON.parse(imp.missing_json):(await matchPlaylistHIVE(env,JSON.parse(imp.tracks_json))).missing;
      return json({songs:known,source_total:imp.source_total,partial:!!imp.partial});
    }
    if((x=path.match(/^\/api\/user\/spotify-imports\/([\w-]+)\/supplement$/))&&m==='POST'){
      await ensureSpotifyImportSchema(DB);const b=await req.json().catch(()=>({}));
      const imp=await DB.prepare('SELECT * FROM spotify_user_imports WHERE id=? AND user_id=?').bind(x[1],auth.user_id).first();
      if(!imp)return json({error:'Spotify import not found.'},404);
      if(!imp.partial&&!imp.completed_partial)return json({error:'Only incomplete imports can be supplemented.'},409);
      if(typeof b.text!=='string'||b.text.length>500000)return json({error:'Paste a tab-separated list of title and artist.'},400);
      const old=JSON.parse(imp.tracks_json),seen=new Set(old.map(t=>norm(t.t)+'|'+norm(t.a))),added=[];
      for(const line of b.text.split(/\r?\n/).filter(a=>a.trim())){
        const parts=line.split('\t');if(parts.length!==2)return json({error:'Each row must contain title, a tab, then artist.'},400);
        const t=clean(parts[0],200),a=clean(parts[1],200);if(!t||!a)return json({error:'Title and artist are required.'},400);
        if(/^title$/i.test(t)&&/^artist$/i.test(a))continue;
        const key=norm(t)+'|'+norm(a);if(!seen.has(key)){seen.add(key);added.push({t,a});}
      }
      if(!added.length)return json({error:'No new songs found in the supplied list.'},400);
      if(old.length+added.length>1500)return json({error:'Maximum 1,500 known source entries per import.'},400);
      const pending=[...JSON.parse(imp.missing_json||'[]'),...added],next={...imp,tracks_json:JSON.stringify([...old,...added]),total:old.length+added.length,partial:1,missing_json:JSON.stringify(pending),newly_discovered:added};
      await DB.prepare('UPDATE spotify_user_imports SET tracks_json=?,total=?,partial=1,missing_json=?,user_supplied_count=user_supplied_count+? WHERE id=?').bind(next.tracks_json,next.total,next.missing_json,added.length,imp.id).run();
      const info=await refreshSpotifyUserImport(env,next,{requestMissing:false});return json({ok:true,added:added.length,...info});
    }
    if((x=path.match(/^\/api\/user\/spotify-imports\/([\w-]+)\/(request|search)$/))&&m==='POST'){
      await ensureSpotifyImportSchema(DB);const b=await req.json().catch(()=>({}));
      const imp=await DB.prepare('SELECT * FROM spotify_user_imports WHERE id=? AND user_id=?').bind(x[1],auth.user_id).first();
      if(!imp)return json({error:'Spotify import not found.'},404);
      const song=JSON.parse(imp.tracks_json||'[]').find(t=>t.t===b.title&&t.a===b.artist);
      if(!song)return json({error:'Song is not in this import.'},404);
      if(x[2]==='search'){
        const offset=Number.isSafeInteger(b.offset)&&b.offset>=0&&b.offset<=100?b.offset:0;
        const refresh=await refreshSpotifyPeerCatalogue(env,{max:4,offset}),cat=await spotifyImportCatalogue(DB);
        return json({ok:true,found:[...cat.local,...cat.remote].some(t=>sourceMatch(t,song)),refreshed:refresh.checked,reachable:refresh.reachable,nextOffset:refresh.nextOffset,totalPeers:refresh.totalPeers});
      }
      const result=await requestStoredSong(env,song,auth.user_id);return json(result,result.error?429:200);
    }
    if((x=path.match(/^\/api\/user\/spotify-imports\/([\w-]+)\/(refresh|complete)$/))&&m==='POST'){
      await ensureSpotifyImportSchema(DB);
      let imp=await DB.prepare('SELECT * FROM spotify_user_imports WHERE id=? AND user_id=?').bind(x[1],auth.user_id).first();
      if(!imp)return json({error:'Spotify import not found.'},404);
      if(imp.state!=='draft'&&!(x[2]==='refresh'&&imp.completed_partial))return json({error:'Spotify import already completed.'},409);
      if(x[2]==='refresh')imp=await extendSpotifyImport(env,imp);
      const info=await refreshSpotifyUserImport(env,imp,{fetchPeers:x[2]==='refresh'});
      if(x[2]==='refresh'){if(imp.state==='complete'&&!info.missing&&!info.partial)await DB.prepare('UPDATE spotify_user_imports SET completed_partial=0 WHERE id=?').bind(imp.id).run();return json({ok:true,...info});}
      const forced=(await req.json().catch(()=>({}))).confirm_partial===true;
      if(info.missing>0&&!forced)return json({error:`${info.missing} songs are still missing. Refresh later; only the owner can finish when the songs are available.`,...info},409);
      // Public Spotify embed may contain only the first 50 or 100 tracks.
      // Never claim the entire Spotify playlist is complete when truncated.
      if(info.partial&&!forced)return json({error:'Spotify exposed only part of this playlist. Completion is blocked until a complete song list can be retrieved.',...info},409);
      await DB.prepare("UPDATE spotify_user_imports SET state='complete',updated_at=?,completed_partial=? WHERE id=?")
        .bind(Date.now(),forced&&(info.missing>0||info.partial)?1:0,imp.id).run();
      return json({ok:true,...info,state:'complete'});
    }
    if (path === "/api/user/mobile-keys" || /^\/api\/user\/mobile-keys\/[\w-]+$/.test(path))
      return manageMobileBridge(req,env,"user",auth.user_id);
    if(path==="/api/user/username" && m==="PUT") {
      const b=await req.json().catch(()=>({})), username=clean(b.username,32);
      if(!/^[a-zA-Z0-9_-]{3,32}$/.test(username))return json({error:'Username must be 3–32 characters: letters, numbers, _ or -.'},400);
      const adminName=(await DB.prepare("SELECT value FROM settings WHERE key='admin_username'").first())?.value||'admin';
      if(['admin',adminName.toLowerCase()].includes(username.toLowerCase()))return json({error:'Reserved administrator username.'},409);
      const self=await DB.prepare('SELECT salt,hash FROM user_accounts WHERE id=?').bind(auth.user_id).first();
      if(!self||!safeEq(await pbkdf2(String(b.password||''),self.salt),self.hash))return json({error:'Current password is incorrect.'},403);
      try {await DB.prepare('UPDATE user_accounts SET username=? WHERE id=?').bind(username,auth.user_id).run();}
      catch {return json({error:'Username is already in use.'},409);}
      await touchCatalogue(DB);return json({ok:true,username});
    }
    if(path==="/api/user/publish/request" && m==="POST") {
      if(await userMayPublish(DB,auth.user_id))return json({error:'Publishing is already enabled for your account.'},409);
      const row=await DB.prepare('SELECT 1 FROM user_publish_requests WHERE user_id=?').bind(auth.user_id).first();
      if(row)return json({ok:true,pending:true,already_requested:true});
      await DB.prepare('INSERT INTO user_publish_requests(user_id,requested_at) VALUES(?,?)').bind(auth.user_id,Date.now()).run();
      return json({ok:true,pending:true},201);
    }
    if(path==="/api/user/publish" && m==="GET") {
      const allowed=await userMayPublish(DB,auth.user_id);
      const links=(await DB.prepare('SELECT id,url,name,track_count,last_ok,last_error,last_checked FROM user_published_peers WHERE user_id=? ORDER BY created_at DESC').bind(auth.user_id).all()).results;
      const request=await DB.prepare('SELECT requested_at FROM user_publish_requests WHERE user_id=?').bind(auth.user_id).first();
      const notice=await DB.prepare('SELECT approved_at FROM user_publish_approval_notices WHERE user_id=? AND viewed_at=0').bind(auth.user_id).first();
      if(notice)await DB.prepare('UPDATE user_publish_approval_notices SET viewed_at=? WHERE user_id=? AND viewed_at=0').bind(Date.now(),auth.user_id).run();
      return json({enabled:allowed,request_pending:!!request,approval_seen:!!notice,links:links.map(l=>({...l,online:!!l.last_ok&&!l.last_error}))});
    }
    if(path==="/api/user/publish" && m==="POST") {
      const allowed=await userMayPublish(DB,auth.user_id);
      if(!allowed)return json({error:'An administrator must enable publishing for your account.'},403);
      const count=(await DB.prepare('SELECT COUNT(*) AS n FROM user_published_peers WHERE user_id=?').bind(auth.user_id).first()).n;
      if(count>=8)return json({error:'Maximum 8 links per account.'},429);
      const b=await req.json().catch(()=>({}));let origin;
      try{origin=publicWaspOrigin(b.url);}catch(e){return json({error:e.message},400);}
      if(origin===new URL(req.url).origin)return json({error:'You cannot publish this server as its own peer.'},400);
      const status=await probeCommunityPeer(origin);
      if(!status.online)return json({error:'The link is not a reachable, sharing WASP server.'},422);
      const id=crypto.randomUUID();
      try{await DB.prepare(`INSERT INTO user_published_peers(id,user_id,url,name,track_count,last_ok,last_error,last_checked,created_at)
        VALUES(?,?,?,?,?,?,NULL,?,?)`).bind(id,auth.user_id,origin,status.name,status.tracks,Date.now(),Date.now(),Date.now()).run();}
      catch{return json({error:'This link has already been added by your account.'},409);}
      await touchCatalogue(DB);return json({ok:true,id,url:origin,name:status.name,online:true,track_count:status.tracks},201);
    }
    if((x=path.match(/^\/api\/user\/publish\/([\w-]+)$/))&&m==='DELETE') {
      await DB.prepare('DELETE FROM user_published_peers WHERE id=? AND user_id=?').bind(x[1],auth.user_id).run();
      await touchCatalogue(DB);return json({ok:true});
    }
    if(path==="/api/user/password" && m==="POST"){
      const b=await req.json().catch(()=>({}));const password=String(b.password||""), confirm=String(b.confirm||"");
      if(password.length<8)return json({error:"New password must be at least 8 characters."},400);
      if(password!==confirm)return json({error:"New passwords do not match."},400);
      const row=await DB.prepare("SELECT salt,hash FROM user_accounts WHERE id = ?").bind(auth.user_id).first();
      if(!row || !safeEq(await pbkdf2(String(b.current||""),row.salt),row.hash))return json({error:"Current password is incorrect."},403);
      const salt=hex(crypto.getRandomValues(new Uint8Array(16)));
      await DB.prepare("UPDATE user_accounts SET salt = ?, hash = ? WHERE id = ?").bind(salt,await pbkdf2(password,salt),auth.user_id).run();
      return json({ok:true});
    }
    if(path==='/api/user/playlist-track-search' && m==='POST'){
      const b=await req.json().catch(()=>({}));const pid=clean(b.playlist_id,100),ref=clean(b.ref,220);
      const owned=await DB.prepare('SELECT 1 FROM user_playlists p JOIN user_playlist_tracks l ON l.playlist_id=p.id WHERE p.id=? AND p.user_id=? AND l.track_id=?').bind(pid,auth.user_id,ref).first();
      if(!owned)return json({error:'Playlist track not found.'},404);
      const saved=await DB.prepare('SELECT title,artist,album FROM peer_track_refs WHERE ref=?').bind(ref).first()||await DB.prepare('SELECT title,artist,album FROM tracks WHERE id=?').bind(ref).first();
      const want=saved||{title:clean(b.title,200),artist:clean(b.artist,200),album:''};
      if(!want?.title||!want.artist)return json({error:'Track metadata is missing. Search or request by song name instead.'},404);
      if(b.request===true){const result=await requestStoredSong(env,{t:want.title,a:want.artist},auth.user_id);return json(result,result.error?429:200);}
      const offset=Number.isSafeInteger(b.offset)&&b.offset>=0&&b.offset<=100?b.offset:0;
      const refresh=b.deep===true?await refreshSpotifyPeerCatalogue(env,{max:4,offset}):null;
      const cat=await spotifyImportCatalogue(DB),matches=[...cat.local,...cat.remote].filter(t=>sourceMatch(t,{t:want.title,a:want.artist})&&(!want.album||!t.album||same(t.album,want.album))).slice(0,30);
      const candidates=[];for(const t of matches){const id=t.origin?'peer:'+await sha256(t.origin+'\n'+t.remote_id):t.id;if(t.origin&&b.replace===id&&id!==ref)await DB.prepare('INSERT OR IGNORE INTO peer_track_refs (ref,origin,remote_id,title,artist,album,duration,cover_url) VALUES(?,?,?,?,?,?,?,?)').bind(id,t.origin,t.remote_id,clean(t.title),clean(t.artist),clean(t.album),Number(t.duration)||0,clean(t.cover_url,500)).run();
        candidates.push({id,title:t.title,artist:t.artist,album:t.album||'',peer:!!t.origin,existing:id===ref});}
      if(b.replace){if(b.replace===ref||!candidates.some(t=>t.id===b.replace))return json({error:'Replacement is not a current catalogue match.'},409);
        const found=await DB.prepare('SELECT added_at FROM user_playlist_tracks WHERE playlist_id=? AND track_id=?').bind(pid,ref).first();if(!found)return json({error:'Playlist changed. Reload and retry.'},409);
        // Replacing an unavailable entry never deletes the underlying track or affects other playlists.
        await DB.batch([DB.prepare('INSERT OR IGNORE INTO user_playlist_tracks(playlist_id,track_id,added_at) VALUES(?,?,?)').bind(pid,b.replace,found.added_at),DB.prepare('DELETE FROM user_playlist_tracks WHERE playlist_id=? AND track_id=?').bind(pid,ref)]);return json({ok:true,replaced:true});}
      return json({ok:true,title:want.title,artist:want.artist,candidates,refreshed:refresh?.checked??0,reachable:refresh?.reachable??0,nextOffset:refresh?.nextOffset??null,totalPeers:refresh?.totalPeers??0});
    }
    if(path==="/api/user/playlists/copy" && m==="POST"){
      const b=await req.json().catch(()=>({})), name=clean(b.name,80);
      if(!name || !Array.isArray(b.tracks) || b.tracks.length>1500)return json({error:"Invalid playlist."},400);
      const refs=[...new Set(b.tracks.map(String))];
      for(const ref of refs){
        if(ref.length>220)return json({error:"Invalid track reference."},400);
        const local=await DB.prepare("SELECT id FROM tracks WHERE id = ?").bind(ref).first();
        const remote=/^peer:[a-f0-9]{64}$/.test(ref) && await DB.prepare("SELECT ref FROM peer_track_refs WHERE ref = ?").bind(ref).first();
        if(!local&&!remote)return json({error:`Unregistered or unavailable track: ${ref}`},409);
      }
      const id=crypto.randomUUID(), now=Date.now();
      try {
        await DB.batch([
          DB.prepare("INSERT INTO user_playlists (id,user_id,name,is_public,created_at,cover_mode) VALUES (?,?,?,?,?,?)").bind(id,auth.user_id,name,0,now,'mosaic'),
          ...refs.map((ref,i)=>DB.prepare("INSERT INTO user_playlist_tracks (playlist_id,track_id,added_at) VALUES (?,?,?)").bind(id,ref,now+i))
        ]);
      }catch(e){return json({error:e.message?.includes('UNIQUE')?'You already have a playlist with that name.':'Unable to copy playlist.'},409);}
      // Do not copy or delete audio. New playlists display a nine-tile album-art cover.
      return json({id,copied:refs.length,skipped:0},201);
    }
    if((x=path.match(/^\/api\/user\/playlists\/([\w-]+)\/cover$/)) && m==="PUT"){
      const owned=await DB.prepare("SELECT id FROM user_playlists WHERE id = ? AND user_id = ?").bind(x[1],auth.user_id).first();
      if(!owned)return json({error:"Playlist not found."},404);
      const type=(req.headers.get("content-type")||"").split(";")[0];
      if(!["image/jpeg","image/png","image/webp"].includes(type))return json({error:"JPEG, PNG or WebP required."},415);
      const bytes=await req.arrayBuffer();if(bytes.byteLength>5*1024*1024)return json({error:"Image exceeds 5 MB."},413);
      await env.MUSIC.put(`art/user-playlist/${x[1]}`,bytes,{httpMetadata:{contentType:type}});
      const v=Date.now();await DB.prepare("UPDATE user_playlists SET cover_v = ? WHERE id = ?").bind(v,x[1]).run();return json({ok:true,cover_url:`/art/user-playlist/${x[1]}?v=${v}`});
    }
    if (path === "/api/user/playlists" && m === "GET") {
      const pls = (await DB.prepare("SELECT id, name, is_public, created_at, cover_v, cover_mode FROM user_playlists WHERE user_id = ? ORDER BY created_at DESC").bind(auth.user_id).all()).results;
      const links = (await DB.prepare("SELECT playlist_id, track_id FROM user_playlist_tracks ORDER BY added_at, rowid").all()).results;
      const by = {}; for (const l of links) (by[l.playlist_id] ??= []).push(l.track_id);
      return json(pls.map(p => ({ ...p, tracks: by[p.id] || [], cover_url:p.cover_v && p.cover_mode!=="mosaic" ? `/art/user-playlist/${p.id}?v=${p.cover_v}` : null })));
    }
    if (path === "/api/user/playlists" && m === "POST") {
      const b = await req.json().catch(() => ({})), name = clean(b.name, 80);
      if (!name) return json({ error: "Playlist name is required." }, 400);
      const id = crypto.randomUUID();
      try { await DB.prepare("INSERT INTO user_playlists (id,user_id,name,is_public,created_at) VALUES (?,?,?,?,?)").bind(id,auth.user_id,name,b.is_public?1:0,Date.now()).run(); }
      catch { return json({ error: "You already have a playlist with that name." }, 409); }
      return json({ id, name, is_public: !!b.is_public, tracks: [] }, 201);
    }
    if ((x = path.match(/^\/api\/user\/playlists\/([\w-]+)$/)) && m === "PATCH") {
      const b = await req.json().catch(() => ({}));
      if (b.cover_mode !== undefined && !["copied","mosaic"].includes(b.cover_mode))return json({error:"Invalid cover mode."},400);
      const r = await DB.prepare("UPDATE user_playlists SET name = COALESCE(?,name), is_public = COALESCE(?,is_public), cover_mode = COALESCE(?,cover_mode) WHERE id = ? AND user_id = ?").bind(b.name ? clean(b.name,80) : null, b.is_public === undefined ? null : (b.is_public?1:0), b.cover_mode ?? null, x[1], auth.user_id).run();
      return json({ ok: true });
    }
    // Atomic bulk track updates, with ownership + track validation before any write.
    // PUT is used by the client-side staged removal (Undo / Save); POST /batch appends.
    if ((x=path.match(/^\/api\/user\/playlists\/([\w-]+)\/tracks(?:\/(batch))?$/)) &&
        ((m==="PUT"&&!x[2])||(m==="POST"&&x[2]==="batch"))) {
      const owned=await DB.prepare("SELECT id FROM user_playlists WHERE id = ? AND user_id = ?").bind(x[1],auth.user_id).first();
      if(!owned)return json({error:"Playlist not found or not owned by you."},404);
      const b=await req.json().catch(()=>({}));
      if(!Array.isArray(b.tracks)||b.tracks.length>1500)return json({error:"Invalid track list (maximum 1500)."},400);
      const refs=[...new Set(b.tracks.map(String))];
      for(const ref of refs){
        if(ref.length>220)return json({error:"Invalid track reference."},400);
        const local=await DB.prepare("SELECT id FROM tracks WHERE id = ?").bind(ref).first();
        const remote=/^peer:[a-f0-9]{64}$/.test(ref) && await DB.prepare("SELECT ref FROM peer_track_refs WHERE ref = ?").bind(ref).first();
        if(!local&&!remote)return json({error:"A selected track no longer exists in the catalogue."},409);
      }
      const existing=(await DB.prepare("SELECT track_id FROM user_playlist_tracks WHERE playlist_id = ? ORDER BY added_at, rowid").bind(x[1]).all()).results.map(r=>r.track_id);
      const additions=m==="PUT"?refs:refs.filter(ref=>!existing.includes(ref));
      const statements=[];
      if(m==="PUT")statements.push(DB.prepare("DELETE FROM user_playlist_tracks WHERE playlist_id = ?").bind(x[1]));
      const baseline=Date.now();
      additions.forEach((ref,i)=>statements.push(DB.prepare("INSERT OR IGNORE INTO user_playlist_tracks (playlist_id,track_id,added_at) VALUES (?,?,?)").bind(x[1],ref,baseline+i)));
      if(statements.length)await DB.batch(statements);
      return json({ok:true,added:additions.length,count:m==="PUT"?refs.length:existing.length+additions.length});
    }
    if ((x = path.match(/^\/api\/user\/playlists\/([\w-]+)\/tracks$/)) && m === "POST") {
      const b = await req.json().catch(() => ({}));
      const owned = await DB.prepare("SELECT id FROM user_playlists WHERE id = ? AND user_id = ?").bind(x[1],auth.user_id).first();
      if (!owned) return json({error:"Playlist not found."},404);
      const ref = clean(b.track_id, 220);
      const peerRef = /^peer:[a-f0-9]{64}$/.test(ref);
      if (peerRef && !(await DB.prepare("SELECT ref FROM peer_track_refs WHERE ref = ?").bind(ref).first())) return json({error:"Peer track not registered."},404);
      if (!peerRef && !(await DB.prepare("SELECT id FROM tracks WHERE id = ?").bind(ref).first())) return json({error:"Track not found."},404);
      await DB.prepare("INSERT OR IGNORE INTO user_playlist_tracks (playlist_id,track_id,added_at) VALUES (?,?,?)").bind(x[1],ref,Date.now()).run();
      return json({ok:true});
    }
    if ((x = path.match(/^\/api\/user\/playlists\/([\w-]+)\/tracks\/([\w-]+)$/)) && m === "DELETE") {
      await DB.prepare("DELETE FROM user_playlist_tracks WHERE playlist_id = ? AND track_id = ? AND EXISTS (SELECT 1 FROM user_playlists WHERE id = ? AND user_id = ?)").bind(x[1],x[2],x[1],auth.user_id).run();
      return json({ok:true});
    }
    if ((x = path.match(/^\/api\/user\/playlists\/([\w-]+)$/)) && m === "DELETE") {
      const owned=await DB.prepare("SELECT id FROM user_playlists WHERE id = ? AND user_id = ?").bind(x[1],auth.user_id).first();
      if(!owned)return json({error:"Playlist not found."},404);
      await ensureSpotifyImportSchema(DB);
      await DB.prepare('DELETE FROM spotify_user_imports WHERE playlist_id=? AND user_id=?').bind(x[1],auth.user_id).run();
      await DB.batch([DB.prepare("DELETE FROM user_playlist_tracks WHERE playlist_id = ?").bind(x[1]),DB.prepare("DELETE FROM playlist_hearts WHERE playlist_id = ?").bind(x[1]),DB.prepare("DELETE FROM user_playlists WHERE id = ? AND user_id = ?").bind(x[1],auth.user_id)]);
      // Only this playlist's dedicated cover is removed: song objects and peer refs remain.
      await env.MUSIC.delete(`art/user-playlist/${x[1]}`).catch(()=>{});
      return json({ok:true});
    }
    return json({error:"Not found."},404);
  }
  // ---------- admin only ----------
  const sid = auth?.token;
  if (!sid || auth.role !== "admin") return json({ error: "Admin access required." }, 403);
  if(path==="/api/admin/mobile-bridge" || path==="/api/admin/mobile-bridge/secret") return manageMobileBridge(req,env,"admin",null);
  if(path==="/api/admin/version" && m==="GET") return json({version:BUILD_VERSION,label:BUILD_LABEL},200,{"cache-control":"no-store"});
  // v18.1.3: release-channel preferences are local to this WASP deployment.
  // Only this fixed pair of public repositories is fetched; no arbitrary URLs,
  // access tokens, repository content execution or automatic installation.
  if(path==='/api/admin/release-updates'){
    if(m==='PUT'){
      const body=await req.json().catch(()=>null);
      if(!body||!Object.hasOwn(RELEASE_SOURCES,body.channel))return json({error:'Choose Stable or Test.'},400);
      await DB.prepare("INSERT INTO settings(key,value) VALUES('release_update_channel',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(body.channel).run();
      return json({ok:true,channel:body.channel,repository:RELEASE_SOURCES[body.channel].owner+'/'+RELEASE_SOURCES[body.channel].repo});
    }
    if(m!=='GET')return json({error:'Method not allowed'},405);
    const prefs=(await DB.prepare("SELECT key,value FROM settings WHERE key IN ('release_update_channel','release_update_baseline_stable','release_update_baseline_test')").all()).results;
    const settings=Object.fromEntries(prefs.map(row=>[row.key,row.value]));
    const channel=Object.hasOwn(RELEASE_SOURCES,settings.release_update_channel)?settings.release_update_channel:'stable';
    const source=RELEASE_SOURCES[channel];
    const deployedSha=[env.WASP_BUILD_SHA,env.WORKERS_CI_COMMIT_SHA,env.GITHUB_SHA,BUILD_COMMIT].find(v=>/^[a-f0-9]{40}$/i.test(v||''))||'';
    const base={channel,repository:`${source.owner}/${source.repo}`,repository_url:`https://github.com/${source.owner}/${source.repo}`,installed_version:BUILD_VERSION,deployed_sha:deployedSha||null};
    try{
      const upstream=await fetchUpstream(channel,{force:url.searchParams.get('refresh')==='1',token:env.GITHUB_UPDATES_TOKEN||''});
      const k='release_update_baseline_'+channel;
      let baselineSha=settings[k]||'';
      // Unknown build SHA: pin the first observed HEAD only once per server
      // and channel. Subsequent upstream commits then generate notifications.
      if(!deployedSha&&!/^[a-f0-9]{40}$/i.test(baselineSha)&&upstream.commit?.sha){
        await DB.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').bind(k,upstream.commit.sha).run();
        baselineSha=(await DB.prepare('SELECT value FROM settings WHERE key=?').bind(k).first())?.value||upstream.commit.sha;
      }
      return json({...base,...upstream,decision:releaseDecision({upstream,installedVersion:BUILD_VERSION,deployedSha,baselineSha}),
        detection:deployedSha?'deployed-sha':'first-observed-commit',check_interval_ms:21600000},200,{'cache-control':'private, no-store'});
    }catch(e){return json({...base,error:'Could not check GitHub: '+String(e.message||e).slice(0,180)},503);}
  }

  if(path==='/api/admin/announcements'){
    await ensureAnnouncementTable(DB);
    if(m==='GET'){
      const items=(await DB.prepare(`SELECT id,title,body,severity,opacity,created_at FROM server_announcements
        ORDER BY created_at DESC LIMIT 30`).all()).results;
      return json({items});
    }
    if(m==='POST'){
      const input=await req.json().catch(()=>null);
      if(!input || typeof input.title!=='string' || typeof input.body!=='string')return json({error:'Title and message are required.'},400);
      const title=input.title.trim(),body=input.body.trim(),severity=String(input.severity||'info');
      const opacity=Number(input.opacity);
      if(!title||title.length>100||!body||body.length>2000)return json({error:'Provide a title (1–100 characters) and message (1–2000 characters).'},400);
      if(!announcementTypes.has(severity)||!Number.isFinite(opacity)||opacity<0.5||opacity>0.98)
        return json({error:'Invalid announcement type or opacity.'},400);
      const id=crypto.randomUUID(),now=Date.now();
      await DB.prepare(`INSERT INTO server_announcements(id,title,body,severity,opacity,created_at)
        VALUES(?,?,?,?,?,?)`).bind(id,title,body,severity,Math.round(opacity*100)/100,now).run();
      // Invalidate this edge's public announcement cache immediately; other
      // Cloudflare POPs will refresh within the short (2s) cache lifetime.
      try {if(typeof caches!=='undefined'&&caches.default)await caches.default.delete(new Request(new URL('/api/announcements',req.url)));}catch{}
      return json({ok:true,id,title,created_at:now},201);
    }
    return json({error:'Method not allowed'},405);
  }
  if(path==="/api/admin/docs" && m==="GET") {
    const name=url.searchParams.get("name");
    if(!name)return json(RELEASE_DOCS.map(d=>({name:d.name})),200,{"cache-control":"private, no-store"});
    const doc=RELEASE_DOCS.find(d=>d.name===name);
    return doc?json(doc,200,{"cache-control":"private, no-store"}):json({error:"Document not found"},404);
  }
  if(path==="/api/admin/crons" && m==="GET") {
    return json(await getCronConfig(DB),200,{"cache-control":"no-store"});
  }
  if(path==="/api/admin/crons" && m==="PUT") {
    const data=await req.json().catch(()=>null);
    let config;try{config=validateCronConfig(data);}catch(e){return json({error:e.message},400);}
    await DB.batch([
      DB.prepare("INSERT INTO settings(key,value) VALUES('cron_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(config)),
      DB.prepare("INSERT INTO settings(key,value) VALUES('telemetry_share_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(config.jobs.telemetry.enabled?'1':'0')
    ]);
    return json({ok:true,config},200,{"cache-control":"no-store"});
  }


  if(path==="/api/admin/users/publish-default" && m==="GET")
    return json({enabled:await globalPublishDefault(DB)});
  if(path==="/api/admin/users/publish-default" && m==="PUT") {
    const b=await req.json().catch(()=>({}));
    if(typeof b.enabled!=='boolean')return json({error:'Invalid publishing default.'},400);
    await DB.prepare(`INSERT INTO settings(key,value) VALUES('user_publish_default',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(b.enabled?'1':'0').run();
    // Approve only requests whose effective permission is now enabled. Per-user
    // explicit denials continue to override the global checkbox.
    if(b.enabled){
      const pending=(await DB.prepare('SELECT user_id FROM user_publish_requests').all()).results;
      for(const item of pending)if(await userMayPublish(DB,item.user_id))await approvePublishRequest(DB,item.user_id);
    }
    await touchCatalogue(DB);
    return json({ok:true,enabled:b.enabled});
  }
  if(path==="/api/admin/users/publish-notifications" && m==="GET") {
    const {n}=await DB.prepare('SELECT COUNT(*) AS n FROM user_publish_requests').first();
    return json({pending:Number(n)||0});
  }
  // Admin users may count healthy community peers, but never receive their URLs.
  if (path === "/api/admin/users" && m === "GET") {
    await refreshCommunityHealth(DB,8);
    const { results } = await DB.prepare(`
      SELECT u.id, u.username, u.created_at,
        COALESCE((SELECT enabled FROM user_peer_permissions x WHERE x.user_id=u.id),${PUBLISH_DEFAULT_SQL}) AS can_publish,
        (SELECT 1 FROM user_publish_requests pr WHERE pr.user_id=u.id) AS publish_requested,
        (SELECT COUNT(*) FROM user_published_peers l WHERE l.user_id=u.id) AS provided_links,
        (SELECT COUNT(*) FROM user_published_peers l WHERE l.user_id=u.id AND l.last_ok IS NOT NULL AND l.last_error IS NULL AND COALESCE((SELECT enabled FROM user_peer_permissions p WHERE p.user_id=u.id),${PUBLISH_DEFAULT_SQL})=1) AS online_links,
        (SELECT COUNT(*) FROM user_song_reactions r WHERE r.user_id=u.id AND r.kind='heart') AS heart_songs,
        (SELECT COUNT(*) FROM user_song_reactions r WHERE r.user_id=u.id AND r.kind='like') AS like_songs,
        (SELECT COUNT(*) FROM user_song_reactions r WHERE r.user_id=u.id AND r.kind='dislike') AS dislike_songs,
        (SELECT COUNT(*) FROM user_playlists p WHERE p.user_id=u.id AND p.is_public=0) AS private_playlists,
        (SELECT COUNT(*) FROM user_playlists p WHERE p.user_id=u.id AND p.is_public=1) AS public_playlists
      FROM user_accounts u ORDER BY u.created_at DESC, u.username COLLATE NOCASE`).all();
    return json(results);
  }
  if((x=path.match(/^\/api\/admin\/users\/([\w-]+)\/publish$/))&&m==='PUT') {
    const user=await DB.prepare('SELECT id FROM user_accounts WHERE id=?').bind(x[1]).first();
    if(!user)return json({error:'User not found.'},404);
    const b=await req.json().catch(()=>({}));
    if(typeof b.enabled!=='boolean')return json({error:'Invalid permission.'},400);
    const previouslyAllowed=await userMayPublish(DB,user.id);
    await DB.prepare(`INSERT INTO user_peer_permissions(user_id,enabled) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled`).bind(user.id,b.enabled?1:0).run();
    if(b.enabled){
      const fromRequest=await approvePublishRequest(DB,user.id);
      if(!fromRequest&&!previouslyAllowed)await createPublishApprovalNotice(DB,user.id);
    }
    await touchCatalogue(DB);return json({ok:true,enabled:b.enabled});
  }
  if((x=path.match(/^\/api\/admin\/users\/([\w-]+)$/))&&m==='DELETE') {
    const b=await req.json().catch(()=>({}));
    if(String(b.confirm||'').trim()!=='delete')return json({error:'Type delete to confirm.'},400);
    const row=await DB.prepare("SELECT salt,hash FROM admin WHERE id='admin'").first();
    if(!row||!safeEq(await pbkdf2(String(b.password||''),row.salt),row.hash))return json({error:'Administrator password is incorrect.'},403);
    const user=await DB.prepare('SELECT id FROM user_accounts WHERE id=?').bind(x[1]).first();
    if(!user)return json({error:'User not found.'},404);
    const images=(await DB.prepare('SELECT id FROM user_playlists WHERE user_id=?').bind(user.id).all()).results;
    await ensureMobileSchema(DB); // Revoke any app credentials atomically with account deletion.
    await ensureSpotifyImportSchema(DB);
    const spotifyImportVoter=await sha256('spotify-import:'+user.id);
    const importRequests=(await DB.prepare("SELECT * FROM requests WHERE voter=? AND status='active' LIMIT 100")
      .bind(spotifyImportVoter).all()).results;
    // Notify the HIVE before removing requests owned by this deleted account.
    for(const own of importRequests)await publishHiveRequest(env,own,'cancelled').catch(()=>{});
    // Atomic D1 removal of user-owned data. Music files and other users' playlists are retained.
    await DB.batch([
      DB.prepare(`DELETE FROM user_playlist_tracks WHERE playlist_id IN (SELECT id FROM user_playlists WHERE user_id=?)`).bind(user.id),
      DB.prepare(`DELETE FROM playlist_hearts WHERE playlist_id IN (SELECT id FROM user_playlists WHERE user_id=?)`).bind(user.id),
      DB.prepare(`DELETE FROM entity_reactions WHERE kind='playlist' AND entity IN (SELECT id FROM user_playlists WHERE user_id=?)`).bind(user.id),
      DB.prepare(`DELETE FROM voted_playlist_cache WHERE id IN (SELECT id FROM user_playlists WHERE user_id=?)`).bind(user.id),
      DB.prepare('DELETE FROM spotify_user_imports WHERE user_id=?').bind(user.id),
      DB.prepare('DELETE FROM requests WHERE voter=?').bind(spotifyImportVoter),
      DB.prepare('DELETE FROM user_playlists WHERE user_id=?').bind(user.id),
      DB.prepare('DELETE FROM user_song_reactions WHERE user_id=?').bind(user.id),
      // v16.0.6: revoke the shared mobile/browser account voter as well.
      DB.prepare('DELETE FROM reactions WHERE voter=?').bind(accountReactionVoter({user_id:user.id})),
      // A visitor cookie can be shared by different signed-in accounts on the
      // same browser. Never erase another account's aggregate interactions.
      DB.prepare(`DELETE FROM playlist_hearts WHERE voter IN (SELECT t.voter FROM user_voter_tokens t
        WHERE t.user_id=? AND NOT EXISTS (SELECT 1 FROM user_voter_tokens other WHERE other.voter=t.voter AND other.user_id<>?))`).bind(user.id,user.id),
      DB.prepare(`DELETE FROM reactions WHERE voter IN (SELECT t.voter FROM user_voter_tokens t
        WHERE t.user_id=? AND NOT EXISTS (SELECT 1 FROM user_voter_tokens other WHERE other.voter=t.voter AND other.user_id<>?))`).bind(user.id,user.id),
      DB.prepare(`DELETE FROM entity_reactions WHERE voter IN (SELECT t.voter FROM user_voter_tokens t
        WHERE t.user_id=? AND NOT EXISTS (SELECT 1 FROM user_voter_tokens other WHERE other.voter=t.voter AND other.user_id<>?))`).bind(user.id,user.id),
      DB.prepare(`DELETE FROM requests WHERE voter IN (SELECT t.voter FROM user_voter_tokens t
        WHERE t.user_id=? AND NOT EXISTS (SELECT 1 FROM user_voter_tokens other WHERE other.voter=t.voter AND other.user_id<>?))`).bind(user.id,user.id),
      DB.prepare('DELETE FROM user_voter_tokens WHERE user_id=?').bind(user.id),
      DB.prepare('DELETE FROM user_published_peers WHERE user_id=?').bind(user.id),
      DB.prepare('DELETE FROM user_peer_permissions WHERE user_id=?').bind(user.id),
      DB.prepare('DELETE FROM user_publish_requests WHERE user_id=?').bind(user.id),
      DB.prepare('DELETE FROM user_publish_approval_notices WHERE user_id=?').bind(user.id),
      DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
      DB.prepare('DELETE FROM mobile_bridge_keys WHERE user_id=?').bind(user.id),
      DB.prepare('DELETE FROM user_accounts WHERE id=?').bind(user.id),
    ]);
    await Promise.all(images.map(p=>env.MUSIC.delete('art/user-playlist/'+p.id).catch(()=>{})));
    await touchCatalogue(DB);return json({ok:true});
  }
  if (path === "/api/admin/bio/refresh" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const name = clean(b.name);
    if (!name || !(await libraryHasArtist(DB, name))) return json({ error: "Artist not found." }, 404);
    const row = await DB.prepare("SELECT * FROM artist_info WHERE name = ?").bind(name).first();
    try { return json({ status: await refreshInfo(env, name, row) }); }
    catch { return json({ error: "Wikipedia is unavailable right now." }, 502); }
  }
  if ((x = path.match(/^\/api\/admin\/playlists\/([\w-]+)\/tracks\/([\w-]+)$/)) && m === "DELETE") {
    await DB.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?").bind(x[1], x[2]).run();
    return json({ ok: true });
  }
  if (path === "/api/admin/settings" && m === "PUT") {
    const b = await req.json().catch(() => ({}));
    const stmts = [];
    const set = (k, v) => stmts.push(DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v)));
    if ("site_name" in b) set("site_name", clean(b.site_name, 60) || "WASP");
    if ("brand_mode" in b) {
      if(!["text","image"].includes(b.brand_mode))return json({error:"Invalid branding mode"},400);
      set("brand_mode",b.brand_mode);
    }
    if ("sidebar_enabled" in b) set("sidebar_enabled",b.sidebar_enabled?"1":"0");
    if ("sidebar_bbcode" in b) {
      const code=String(b.sidebar_bbcode??"");
      if(code.length>8000)return json({error:"Sidebar BBCode exceeds 8,000 characters."},400);
      set("sidebar_bbcode",code);
    }
    // Retained solely for backwards compatibility with installations that
    // already store HTML credits. New clients only save safe BBCode.
    if ("sidebar_html" in b) {
      const h=String(b.sidebar_html??"");
      if(h.length>25000)return json({error:"Sidebar code exceeds 25,000 characters."},400);
      set("sidebar_html",h);
    }
    if ("show_brand_icon" in b) set("show_brand_icon", b.show_brand_icon ? "1" : "0");
    if ("tab_title" in b) set("tab_title", clean(b.tab_title, 80));
    if ("ad_enabled" in b) set("ad_enabled", b.ad_enabled ? "1" : "0");
    if ("ad_html" in b) {
      const h = String(b.ad_html ?? "");
      if (h.length > 100000) return json({ error: "The ad code is too long (100,000 characters at most)." }, 400);
      set("ad_html", h);
    }
    if ("ad_height" in b) set("ad_height", Math.min(1000, Math.max(60, parseInt(b.ad_height, 10) || 340)));
    if (stmts.length) await DB.batch(stmts);
    return json(await siteSettings(DB));
  }
  if (path === "/api/admin/brand-image") {
    if (m === "PUT") {
      const type=req.headers.get("content-type")||"",size=Number(req.headers.get("content-length")||0);
      if(!/^image\/(png|jpeg|webp|gif)$/.test(type)||!size||size>1024*1024)
        return json({error:"Choose a PNG, JPEG, WebP or GIF up to 1 MB."},400);
      await env.MUSIC.put("site/brand",req.body,{httpMetadata:{contentType:type}});
      const v=Date.now();await DB.prepare("INSERT INTO settings(key,value) VALUES('brand_v',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(v)).run();
      return json({ok:true,brand_v:v});
    }
    if(m === "DELETE") {
      await env.MUSIC.delete("site/brand");
      await DB.prepare("INSERT INTO settings(key,value) VALUES('brand_v','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
      return json({ok:true,brand_v:0});
    }
  }
  if (path === "/api/admin/favicon") {
    if (m === "PUT") {
      const type = req.headers.get("content-type") || "";
      const size = Number(req.headers.get("content-length") || 0);
      if (!/^image\/(png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(type) || !size || size > 512 * 1024)
        return json({ error: "Choose a PNG, ICO, SVG, JPEG, WebP or GIF image up to 512 KB." }, 400);
      await env.MUSIC.put("site/favicon", req.body, { httpMetadata: { contentType: type } });
      const v = Date.now();
      await DB.prepare("INSERT INTO settings (key, value) VALUES ('favicon_v', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(v)).run();
      return json({ ok: true, favicon: v });
    }
    if (m === "DELETE") {
      await env.MUSIC.delete("site/favicon");
      await DB.prepare("INSERT INTO settings (key, value) VALUES ('favicon_v', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
      return json({ ok: true, favicon: 0 });
    }
  }
  // Private administrator-only Spotify search settings. Never return a client
  // secret, not even an encrypted copy. A blank secret in PUT means "keep".
  if (path === "/api/admin/spotify-config") {
    if (m === "GET") {
      const saved = await spotifySavedConfig(env);
      let locked = false;
      if (saved) {
        try { await decryptSpotifySecret(env, saved.secret_cipher); }
        catch { locked = true; }
      }
      return json(spotifyConfigResponse(saved, env, locked));
    }
    if (m === "PUT") {
      if (req.headers.get("content-type")?.split(";")[0] !== "application/json")
        return json({ error: "JSON request required." }, 415);
      if (Number(req.headers.get("content-length") || 0) > 4096) return json({ error: "Request too large." }, 413);
      let b;
      try { b = await req.json(); }
      catch { return json({ error: "Invalid JSON." }, 400); }
      const id = typeof b?.client_id === "string" ? b.client_id.trim() : "";
      const supplied = typeof b?.client_secret === "string" ? b.client_secret.trim() : "";
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) return json({ error: "Enter a valid Spotify Client ID." }, 400);
      if (supplied && (!/^[\x21-\x7e]{8,256}$/.test(supplied))) return json({ error: "Client secret must have 8–256 non-space characters." }, 400);
      const saved = await spotifySavedConfig(env);
      if (!supplied && !saved) return json({ error: "Enter the Spotify Client Secret." }, 400);
      try {
        const cipher = supplied ? await encryptSpotifySecret(env, supplied) : saved.secret_cipher;
        // Verify the old secret is actually decryptable if it is retained.
        if (!supplied) await decryptSpotifySecret(env, cipher);
        await DB.prepare("INSERT INTO spotify_credentials(id,client_id,secret_cipher,updated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id, secret_cipher=excluded.secret_cipher, updated_at=excluded.updated_at")
          .bind(id, cipher, Date.now()).run();
        spotifyAuthCache = { id: "", token: "", expires: 0 };
        return json({ ok: true, ...spotifyConfigResponse(await spotifySavedConfig(env), env) });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Unable to save encrypted Spotify settings." }, 503);
      }
    }
    if (m === "DELETE") {
      await DB.prepare("DELETE FROM spotify_credentials WHERE id = 1").run();
      spotifyAuthCache = { id: "", token: "", expires: 0 };
      return json({ ok: true, ...spotifyConfigResponse(null, env) });
    }
    return json({ error: "Method not allowed." }, 405);
  }
  // Playlist request recovery: read-only candidate search and explicit reviewed overrides.
  if ((x=path.match(/^\/api\/admin\/requests\/([\w-]+)\/candidates$/)) && m==='GET'){
    const row=await DB.prepare("SELECT id,kind,meta FROM requests WHERE id=? AND kind='playlist' AND status='active'").bind(x[1]).first();
    if(!row)return json({error:'Local playlist request not found.'},404);
    const mt=JSON.parse(row.meta||'{}'),index=Number(url.searchParams.get('index'));
    if(!Number.isSafeInteger(index)||index<0||index>=mt.tracks?.length)return json({error:'Invalid source song index.'},400);
    const cat=await spotifyImportCatalogue(DB),query=clean(url.searchParams.get('q'),120);
    return json({index,source:mt.tracks[index],candidates:suggestRequestCandidates(mt.tracks[index],cat,{query,rejected:mt.rejected_candidates?.[index]||[],limit:12})});
  }
  if ((x=path.match(/^\/api\/admin\/requests\/([\w-]+)\/match$/)) && m==='POST'){
    const row=await DB.prepare("SELECT * FROM requests WHERE id=? AND kind='playlist' AND status='active'").bind(x[1]).first();
    if(!row)return json({error:'Local playlist request not found.'},404);
    const body=await req.json().catch(()=>null),mt=JSON.parse(row.meta||'{}');
    if(!body||!['accept','reject','clear','skip','restore','add'].includes(body.action))return json({error:'Invalid action'},400);
    let idx=Number(body.index);
    if(body.action==='add'){
      if(!Array.isArray(mt.tracks)||mt.tracks.length>=1500)return json({error:'Request has too many entries'},400);
      const t=clean(body.title,200),a=clean(body.artist,200);
      if(!t||!a)return json({error:'Title and artist are required.'},400);
      mt.tracks.push({t,a,manual_added:true});idx=mt.tracks.length-1;mt.total=mt.tracks.length;
    }else{
      if(!Number.isSafeInteger(idx)||idx<0||idx>=mt.tracks?.length)return json({error:'Invalid source song index'},400);
      const id=clean(body.id,110),origin=clean(body.origin,300),key=origin+'|'+id;
      if(['accept','reject'].includes(body.action)){
        if(!id)return json({error:'Select an existing song'},400);
        const cat=await spotifyImportCatalogue(DB),exists=[...cat.local,...cat.remote].find(t=>String(t.origin||'')===origin&&String(t.remote_id||t.id)===id);
        if(!exists)return json({error:'Song is not available in the current HIVE catalogue. Refresh and try again.'},409);
        if(body.action==='accept'){
          mt.manual_matches={...safeManualMatches(mt),[idx]:{id,origin}};
          const rejects={...(mt.rejected_candidates||{})};rejects[idx]=(rejects[idx]||[]).filter(v=>v!==key);mt.rejected_candidates=rejects;
        }else{
          delete (mt.manual_matches||{})[idx];
          const rejects={...(mt.rejected_candidates||{})};rejects[idx]=[...new Set([...(rejects[idx]||[]),key])].slice(-40);mt.rejected_candidates=rejects;
        }
      }
      if(body.action==='clear')delete (mt.manual_matches||{})[idx];
      if(body.action==='skip'||body.action==='restore'){
        const skipped=new Set(mt.skipped_indices||[]);body.action==='skip'?skipped.add(idx):skipped.delete(idx);mt.skipped_indices=[...skipped].sort((a,b)=>a-b);
      }
    }
    // State and review are retained even if the admin closes the browser.
    const cat=await spotifyImportCatalogue(DB);
    const found=await matchPlaylistHIVE(env,requestActiveTracks(mt),{catalogue:cat,manual_matches:safeManualMatches(mt)});
    Object.assign(mt,{matched:found.matched.length,matched_local:found.local_count,matched_peer:found.peer_count,matched_missing:found.missing,availability_checked_at:Date.now()});
    await DB.prepare('UPDATE requests SET meta=? WHERE id=? AND status=\'active\'').bind(JSON.stringify(mt),row.id).run();
    return json({ok:true,index:idx,matched:mt.matched,missing:found.missing,skipped_count:(mt.skipped_indices||[]).length});
  }
  if (path === "/api/admin/requests" && m === "GET") {
    const rows = (await DB.prepare("SELECT id, kind, title, artist, album, image, url, created_at, CASE WHEN json_valid(meta) THEN json_remove(meta,'$.tracks') ELSE NULL END AS meta, CASE WHEN json_valid(meta) THEN json_type(meta,'$.tracks')='array' ELSE 0 END AS has_tracks FROM requests WHERE status = 'active' ORDER BY created_at, rowid").all()).results;
    const local=[];
    for(const {meta,has_tracks,...r} of rows){
      let mt=null;try{mt=meta?JSON.parse(meta):null;}catch{}
      if(!mt||!has_tracks){local.push({...r,...(mt?.review?mt.review:{})});continue;}
      const checked=Array.isArray(mt.matched_missing)&&Number.isFinite(mt.availability_checked_at);
      local.push({...r,total:mt.total,partial:!!mt.partial,
        source_total:Number.isSafeInteger(mt.source_total)?mt.source_total:null,
        source_status:mt.source_status||'unverified',matched:checked?mt.matched:null,
        matched_local:checked?mt.matched_local:null,matched_peer:checked?mt.matched_peer:null,missing:checked?mt.matched_missing:null,skipped:(mt.skipped_indices||[]).map(i=>({...mt.tracks?.[i],request_index:i})).filter(x=>x.t).slice(0,50),skipped_count:(mt.skipped_indices||[]).length,manual_match_count:Object.keys(mt.manual_matches||{}).length,availability_checked_at:checked?mt.availability_checked_at:null});
    }
    // Remote requests retain origin ownership; local admins can dismiss copies.
    const remote=await hiveRequestsForDisplay(env,{admin:true});
    return json([...local,...remote].sort((a,b)=>a.created_at-b.created_at));
  }
  if(path==='/api/admin/requests/review' && m==='POST'){
    const b=await req.json().catch(()=>({}));
    if(!Array.isArray(b.ids)||!b.ids.length||b.ids.length>8||b.ids.some(id=>typeof id!=='string'||id.length>192)||!['refresh','complete','locate','hide-offline'].includes(b.action))return json({error:'Invalid review selection.'},400);
    const unique=[...new Set(b.ids)],result=[];
    const refreshed=b.action==='refresh'&&b.cached_only!==true?await refreshSpotifyPeerCatalogue(env,{max:4}):null;
    const catalogue=b.action==='refresh'?await spotifyImportCatalogue(DB):null;
    for(const id of unique){
      const remote=id.includes('|');const row=remote?await remoteRequestRow(env,id):await DB.prepare("SELECT * FROM requests WHERE id=? AND status='active'").bind(id).first();
      if(!row){result.push({id,error:'Request not found'});continue;}
      if(b.action==='locate'){
        if(!remote){result.push({id,origin_status:'local'});continue;}
        // Direct approved origin only; run the ordinary pull to refresh health.
        if(b.live===true)await syncHiveRequests(env,{force:true,targetOrigin:row.origin_id});
        result.push({id,...await originStatus(env,row.origin_id)});continue;
      }
      if(b.action==='hide-offline'){
        if(!remote||!await reviewRemoteRequest(env,id,{hide:true}))result.push({id,error:'Origin is not verified offline.'});else result.push({id,status:'hidden'});continue;
      }
      if(b.action==='complete'){
        if(!['artist','album'].includes(row.kind)||b.confirm!==true){result.push({id,error:'Only confirmed artist or album completion is allowed here.'});continue;}
        if(remote)await reviewRemoteRequest(env,id,{done:true});else{await markDone(DB,id);await publishHiveRequest(env,row,'done').catch(()=>{});}
        result.push({id,status:'done',local_only:remote});continue;
      }
      let stats={},done=false,meta={};try{meta=JSON.parse(row.meta||'{}')||{};}catch{}
      if(row.kind==='song'){
        const wanted={t:row.title,a:row.artist};const own=catalogue.local.some(t=>sourceMatch(t,wanted)),peer=catalogue.remote.some(t=>sourceMatch(t,wanted));
        stats={matched_local:own?1:0,matched_peer:peer?1:0,availability_checked_at:Date.now()};done=own||peer;
      }else if(['artist','album'].includes(row.kind)){
        const match=t=>artistsOfRow(t).some(a=>normArtist(a)===normArtist(row.kind==='artist'?row.title:row.artist))&&(row.kind==='artist'||same(t.album,row.title));
        const key=t=>core(t.title)+'|'+norm(t.artist)+'|'+norm(t.album);
        const own=new Set(catalogue.local.filter(match).map(key)),other=new Set(catalogue.remote.filter(match).map(key));
        stats={matched_local:own.size,matched_peer:other.size,availability_checked_at:Date.now()};
      }else if(row.kind==='playlist'){
        const sid=String(row.url||'').match(/^https:\/\/open\.spotify\.com\/playlist\/([A-Za-z0-9]{10,40})$/)?.[1];
        if(sid)try{const embed=await spotifyEmbed(sid);if(embed.tracks.length>=(meta.tracks||[]).length){const replacement=playlistMeta(embed.tracks,embed.sourceTotal);
          if(stableRequestSelections(meta,replacement.tracks))Object.assign(replacement,{manual_matches:meta.manual_matches,rejected_candidates:meta.rejected_candidates,skipped_indices:meta.skipped_indices});meta=replacement;}}catch{}
        if(!meta.tracks?.length){result.push({id,error:'Spotify song list unavailable.'});continue;}
        const found=await matchPlaylistHIVE(env,requestActiveTracks(meta),{catalogue,manual_matches:safeManualMatches(meta)});stats={total:meta.total,partial:!!meta.partial,source_total:meta.source_total??null,source_status:meta.source_status,matched:found.matched.length,matched_local:found.local_count,matched_peer:found.peer_count,missing:found.missing,availability_checked_at:Date.now()};
        Object.assign(meta,{matched:stats.matched,matched_local:stats.matched_local,matched_peer:stats.matched_peer,matched_missing:stats.missing,availability_checked_at:stats.availability_checked_at});
      }
      if(remote)await reviewRemoteRequest(env,id,{stats,done});else{
        await DB.prepare('UPDATE requests SET meta=? WHERE id=?').bind(JSON.stringify({...meta,review:stats}),id).run();
        if(done){await markDone(DB,id);await publishHiveRequest(env,row,'done').catch(()=>{});}
      }
      result.push({id,...stats,status:done?'done':'progress',local_only:remote});
    }
    return json({ok:true,results:result,refresh:refreshed});
  }
  if ((x = path.match(/^\/api\/admin\/requests\/([\w-]+)\/(refresh|complete)$/)) && m === "POST") {
    const r = await DB.prepare("SELECT * FROM requests WHERE id = ? AND kind = 'playlist' AND status = 'active'").bind(x[1]).first();
    if (!r) return json({ error: "Playlist request not found." }, 404);
    let meta = null; try { meta = r.meta ? JSON.parse(r.meta) : null; } catch {}
    if (x[2] === "refresh") { // refresh bounded peer snapshots, then compare Spotify source list
      await refreshSpotifyPeerCatalogue(env,{max:4});
      try {
        const e = await spotifyEmbed(String(r.dedupe).split("|")[1]);
        if (!e.tracks.length) throw new Error("empty");
        if(!meta?.tracks||e.tracks.length>=meta.tracks.length)meta = playlistMeta(e.tracks, e.sourceTotal??meta?.source_total);
        if (!r.image && e.image) r.image = e.image;
      } catch { if (!meta) return json({ error: "Couldn't read the playlist from Spotify right now." }, 502); }
    }
    if (!meta || !meta.tracks || !meta.tracks.length) return json({ error: "The song list of this playlist isn't available." }, 400);
    const isCompletion=x[2]==='complete';
    let {matched,missing,local_count,peer_count}=await matchPlaylistHIVE(env,requestActiveTracks(meta),{register:false,manual_matches:safeManualMatches(meta)});
    meta.matched=matched.length;meta.matched_local=local_count;meta.matched_peer=peer_count;meta.matched_missing=missing;meta.availability_checked_at=Date.now();
    const reportedTotal=Number.isSafeInteger(meta.source_total)?meta.source_total:null;
    const confirmedIncomplete=reportedTotal!==null && reportedTotal>meta.tracks.length;
    let requestBody={};
    if(isCompletion)requestBody=await req.json().catch(()=>({}));
    const acceptedUnverified=isCompletion && !!meta.partial && (requestBody?.confirm_unverified===true || confirmedIncomplete&&requestBody?.confirm_incomplete===true);
    if(acceptedUnverified){
      // An explicit admin decision, not a claim that all Spotify songs were
      // fetched. Persist the acknowledgement with the completed request.
      meta.completed_unverified=true;meta.completed_retrieved=meta.tracks.length;
      meta.completed_at=Date.now();
    }
    await DB.prepare("UPDATE requests SET meta = ?, image = COALESCE(image, ?) WHERE id = ?").bind(JSON.stringify(meta), r.image || null, r.id).run();
    if(isCompletion && missing.length && requestBody.confirm_missing!==true)return json({error:`${missing.length} Spotify songs are still missing. Confirm explicitly to finish with only available songs.`,code:'missing_confirmation',matched:matched.length,missing,requires_confirmation:true},409);
    if(isCompletion && !matched.length)return json({error:'None of the songs are available yet.'},409);
    if(isCompletion && confirmedIncomplete && requestBody.confirm_incomplete!==true)return json({error:`Spotify reports ${reportedTotal} songs, but only ${meta.tracks.length} were retrieved. Explicitly confirm completing this incomplete list.`,code:'spotify_list_incomplete',source_total:reportedTotal,requires_confirmation:true},409);
    if(isCompletion && meta.partial && !acceptedUnverified && !confirmedIncomplete)return json({
      error:`Spotify exposed ${meta.tracks.length} songs, but its complete playlist length cannot be verified. Explicitly finalize only the retrieved songs to continue.`,
      code:'spotify_list_unverified',requires_confirmation:true,retrieved:meta.tracks.length
    },409);
    if(isCompletion){
      ({matched,missing,local_count,peer_count}=await matchPlaylistHIVE(env,requestActiveTracks(meta),{register:true,manual_matches:safeManualMatches(meta)}));
      meta.completed_missing=missing;meta.completed_with_missing=!!missing.length;meta.completed_incomplete=confirmedIncomplete;await DB.prepare('UPDATE requests SET meta=? WHERE id=?').bind(JSON.stringify(meta),r.id).run();
      const pid=await completePlaylistRequest(env,r,matched);
      return json({status:'done',playlist_id:pid,total:meta.total,matched:matched.length,
        local:local_count,peer:peer_count,completed_unverified:acceptedUnverified});
    }
    return json({status:'progress',total:meta.total,partial:meta.partial,
      source_total:reportedTotal,source_status:meta.source_status||'unverified',
      matched:matched.length,local:local_count,peer:peer_count,missing});
  }
  if (path === '/api/admin/requests/housekeeping' && m === 'POST') {
    const b=await req.json().catch(()=>null);
    if(!b || !['selected','remote','all'].includes(b.mode) || b.confirm!==true ||
      (b.mode==='selected' && (!Array.isArray(b.ids)||!b.ids.length||b.ids.length>8||b.ids.some(id=>typeof id!=='string'||id.length>192))))return json({error:'Invalid housekeeping selection or confirmation.'},400);
    const ids=b.mode==='selected'?[...new Set(b.ids)]:[];
    const remote=await dismissHiveRequests(env,{all:b.mode!=='selected',ids});
    let local=0;
    if(b.mode==='all'||b.mode==='selected'){
      // Only explicitly selected or active local requests; never delete history or music.
      const own=b.mode==='all'?(await DB.prepare("SELECT * FROM requests WHERE status='active' LIMIT 8").all()).results:
        (await Promise.all(ids.filter(id=>/^[\w-]{8,100}$/.test(id)).map(id=>DB.prepare("SELECT * FROM requests WHERE id=? AND status='active'").bind(id).first()))).filter(Boolean);
      for(const row of own){await publishHiveRequest(env,row,'cancelled');
        const r=await DB.prepare("DELETE FROM requests WHERE id=? AND status='active'").bind(row.id).run();local+=Number(r.meta?.changes||0);}
    }
    const more=b.mode==='all'&&!!(await DB.prepare("SELECT 1 FROM requests WHERE status='active' LIMIT 1").first());
    return json({ok:true,remote,local,more});
  }
  if ((x = path.match(/^\/api\/admin\/requests\/([\w-]+)$/)) && m === "DELETE") {
    const own=await DB.prepare("SELECT * FROM requests WHERE id=?").bind(x[1]).first();
    if(own?.status==='active'){
      await publishHiveRequest(env,own,'cancelled');
      await DB.prepare("DELETE FROM requests WHERE id = ? AND status='active'").bind(x[1]).run();
    }
    return json({ ok: true });
  }
  if ((x = path.match(/^\/api\/admin\/playlists\/([\w-]+)\/cover$/))) {
    if (!(await DB.prepare("SELECT 1 FROM playlists WHERE id = ?").bind(x[1]).first())) return json({ error: "Playlist not found." }, 404);
    if (m === "PUT") {
      const type = req.headers.get("content-type") || "";
      const size = Number(req.headers.get("content-length") || 0);
      if (!/^image\/(jpeg|png|webp)$/.test(type) || !size || size > 5 * 1024 * 1024) return json({ error: "Choose a JPEG, PNG or WebP image under 5 MB." }, 400);
      await env.MUSIC.put(`art/playlist/${x[1]}`, req.body, { httpMetadata: { contentType: type }, customMetadata: { source: "custom", at: String(Date.now()) } });
      const v = Date.now();
      await DB.prepare("UPDATE playlists SET cover_v = ? WHERE id = ?").bind(v, x[1]).run();
      return json({ ok: true, cover_v: v });
    }
    if (m === "DELETE") {
      await env.MUSIC.delete(`art/playlist/${x[1]}`);
      await DB.prepare("UPDATE playlists SET cover_v = 0 WHERE id = ?").bind(x[1]).run();
      return json({ ok: true });
    }
  }
  if(path==="/api/admin/hash-scan" && m==="POST") {
    if(!env.SCANNER_SECRET)return json({error:"The SHA-256 folder scanner is available on Docker installations only."},400);
    const request=crypto.randomUUID();
    await DB.prepare("INSERT INTO settings(key,value) VALUES('hash_scan_request',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(request).run();
    await DB.prepare("INSERT INTO settings(key,value) VALUES('fingerprint_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({state:"queued",total:0,scanned:0,changed:0,updated_at:Date.now()})).run();
    return json({ok:true,request});
  }
  if(path==="/api/admin/duplicates" && m==="GET") {
    const status=(await DB.prepare("SELECT value FROM settings WHERE key='fingerprint_status'").first())?.value;
    // Exact-byte duplicates.  Upload objects and server-folder files are distinct
    // storage sources; legacy upload hashes are not repeated on folder rows.
    const cte=`WITH sources AS (
      SELECT id,hash AS sha,size,'upload' AS source,'' AS source_path FROM tracks WHERE hash IS NOT NULL
      UNION ALL
      SELECT f.track_id AS id,f.sha256 AS sha,f.size AS size,'folder' AS source,f.source_path AS source_path FROM file_fingerprints f JOIN tracks t ON t.id=f.track_id
    ), dup AS (SELECT sha,COUNT(*) AS qty FROM sources GROUP BY sha HAVING COUNT(*)>1)`;
    const summary=await DB.prepare(cte+" SELECT COALESCE(SUM(qty-1),0) AS duplicates, COUNT(*) AS groups FROM dup").first();
    const groups=(await DB.prepare(cte+" SELECT d.sha,d.qty,COALESCE(SUM(s.size),0) AS total_bytes FROM dup d JOIN sources s ON s.sha=d.sha GROUP BY d.sha,d.qty ORDER BY d.qty DESC,d.sha LIMIT 100").all()).results;
    const entries=(await DB.prepare(cte+" SELECT s.id,s.sha,s.size,s.source,s.source_path,t.title,t.artist,t.plays, (SELECT COUNT(*) FROM playlist_tracks p WHERE p.track_id=s.id)+(SELECT COUNT(*) FROM user_playlist_tracks u WHERE u.track_id=s.id) AS references_count FROM sources s JOIN dup d ON s.sha=d.sha LEFT JOIN tracks t ON t.id=s.id ORDER BY s.sha,s.source DESC LIMIT 1000").all()).results;
    return json({groups:groups.map(g=>({...g,items:entries.filter(e=>e.sha===g.sha)})),duplicate_count:summary?.duplicates||0,duplicate_groups:summary?.groups||0,status:status?JSON.parse(status):{state:"not_run"},note:"Only eligible, unused web-uploaded duplicates can be deleted. /music is mounted read-only."});
  }
  if((x=path.match(/^\/api\/admin\/duplicates\/([0-9a-f-]+)$/)) && m==="DELETE") {
    const b=await req.json().catch(()=>({}));
    if(b.confirm!=="delete duplicate")return json({error:"Explicit confirmation required."},400);
    const track=await DB.prepare("SELECT id,hash,size,plays FROM tracks WHERE id=? AND hash IS NOT NULL").bind(x[1]).first();
    if(!track)return json({error:"Only WASP-managed uploaded files can be deleted here. Original /music files stay read-only."},400);
    const matches=await DB.prepare("SELECT (SELECT COUNT(*) FROM tracks WHERE hash=?)+(SELECT COUNT(*) FROM file_fingerprints WHERE sha256=?) AS n").bind(track.hash,track.hash).first();
    if((matches?.n||0)<2)return json({error:"No other identical file is available. Refusing deletion."},409);
    // A stale folder fingerprint is not sufficient to justify destroying the
    // only uploaded copy. Require a recently confirmed folder scan if there
    // are no other independently stored uploads with the same hash.
    const alternative=await DB.prepare("SELECT COUNT(*) AS n FROM tracks WHERE hash=? AND id<>?").bind(track.hash,track.id).first();
    if(!alternative?.n){
      const marker=(await DB.prepare("SELECT value FROM settings WHERE key='fingerprint_status'").first())?.value;
      let scan;try{scan=JSON.parse(marker||"{}");}catch{scan={};}
      // Scans reconcile removed/moved paths before writing 'complete'. An old
      // scan cannot justify deleting the only managed copy of a track.
      if(scan.state!=="complete" || Date.now()-Number(scan.updated_at||0)>5*60*1000)
        return json({error:"Complete a fresh SHA-256 scan of /music before deleting an upload that has no second uploaded copy."},409);
      const surviving=await DB.prepare("SELECT COUNT(*) AS n FROM file_fingerprints WHERE sha256=?").bind(track.hash).first();
      if(!surviving?.n)return json({error:"The matching /music file was removed or changed. Deletion refused."},409);
    }
    const refs=await DB.prepare("SELECT (SELECT COUNT(*) FROM playlist_tracks WHERE track_id=?)+(SELECT COUNT(*) FROM user_playlist_tracks WHERE track_id=?)+(SELECT COUNT(*) FROM reactions WHERE track_id=?)+(SELECT COUNT(*) FROM user_song_reactions WHERE track_id=?) AS n").bind(track.id,track.id,track.id,track.id).first();
    if(refs.n || Number(track.plays)>0)return json({error:"This upload has plays, reactions or playlist references. Preserve it to avoid losing user data."},409);
    await env.MUSIC.delete(track.id);
    await DB.batch([DB.prepare("DELETE FROM track_artist_map WHERE track_id=?").bind(track.id),DB.prepare("DELETE FROM tracks WHERE id=? AND hash=?").bind(track.id,track.hash)]);
    await touchCatalogue(DB);
    return json({ok:true,deleted_id:track.id});
  }
  if (path === "/api/admin/check" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const row = /^[0-9a-f]{64}$/.test(b.hash) ? (await DB.prepare("SELECT id FROM tracks WHERE hash = ?").bind(b.hash).first() || await DB.prepare("SELECT track_id AS id FROM file_fingerprints WHERE sha256=? LIMIT 1").bind(b.hash).first()) : null;
    return json({ id: row ? row.id : null });
  }
  if (path === "/api/admin/upload" && m === "POST") {
    const size = Number(req.headers.get("content-length") || 0);
    if (!req.body || !size) return json({ error: "Empty upload." }, 400);
    if (size > MAX_UPLOAD) return json({ error: "File is larger than 100 MB." }, 413);
    let meta = {};
    try { meta = JSON.parse(decodeURIComponent(req.headers.get("X-Meta") || "{}")); } catch {}
    const filename = decodeURIComponent(req.headers.get("X-Filename") || "");
    if (!/\.mp3$/i.test(filename)) return json({ error: "Only .mp3 files are allowed." }, 400);
    const hash = req.headers.get("X-Hash") || "";
    if (!/^[0-9a-f]{64}$/.test(hash)) return json({ error: "Missing file fingerprint." }, 400);
    const dup = await DB.prepare("SELECT id FROM tracks WHERE hash = ?").bind(hash).first() || await DB.prepare("SELECT track_id AS id FROM file_fingerprints WHERE sha256=? LIMIT 1").bind(hash).first();
    if (dup) return json({ error: "Already in the library.", id: dup.id }, 409);
    const pid = req.headers.get("X-Playlist");
    if (pid && !(await DB.prepare("SELECT 1 FROM playlists WHERE id = ?").bind(pid).first())) return json({ error: "Playlist not found." }, 400);
    const id = crypto.randomUUID();
    await env.MUSIC.put(id, req.body, { httpMetadata: { contentType: "audio/mpeg" } });
    const t = {
      id,
      title: clean(meta.title) || filename.replace(/\.mp3$/i, ""),
      artist: clean(meta.artist) || "Unknown Artist",
      album: clean(meta.album), // empty = a single
      track_no: parseInt(meta.track, 10) || 0,
      duration: Number(meta.duration) || 0,
    };
    t.artists = Array.isArray(meta.artists)&&meta.artists.length ? meta.artists.slice(0,30).map(a=>clean(a,120)).filter(Boolean) : splitArtists(t.artist);
    const now = Date.now();
    const stmts = [DB.prepare(
      "INSERT INTO tracks (id, title, artist, album, track_no, duration, size, created_at, hash, artists) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(t.id, t.title, t.artist, t.album, t.track_no, t.duration, size, now, hash, JSON.stringify(t.artists))];
    if (pid) stmts.push(DB.prepare("INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, added_at) VALUES (?,?,?)").bind(pid, id, now));
    stmts.push(...artistIndexStatements(DB,t));
    await DB.batch(stmts);
    if(meta.year||meta.genre){await rememberTrackMetadata(env,t.id,{release_year:meta.year,genre:meta.genre}).catch(()=>{});await rememberFileFacts(env,t,{release_year:meta.year,genre:meta.genre}).catch(()=>{});}await rememberPicardFacts(env,t,{...meta,artist_names:meta.artists}).catch(e=>console.warn('Picard fact extraction delayed:',e.message));
    await fulfil(env, t).catch(() => {}); // takes matching requests out of the queue
    // Automatically warm biography and artwork for new artists/albums. Never
    // fail an upload because a third-party artwork service is unavailable.
    if(ctx?.waitUntil) ctx.waitUntil((async()=>{
      for(const artist of (t.artists||[]).slice(0,3)) {
        try { await serveBio(env,new URL("https://localhost/api/bio?name="+encodeURIComponent(artist)),null); } catch {}
        try { await serveArt(env,new URL("https://localhost/art/artist?name="+encodeURIComponent(artist))); } catch {}
        if(t.album) try { await serveArt(env,new URL("https://localhost/art/album?artist="+encodeURIComponent(artist)+"&album="+encodeURIComponent(t.album))); } catch {}
      }
    })());
    return json(t, 201);
  }
  if (path === "/api/admin/playlists" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const name = clean(b.name, 80);
    if (!name) return json({ error: "Playlist needs a name." }, 400);
    let row = await DB.prepare("SELECT id, name FROM playlists WHERE name = ?").bind(name).first();
    if (!row) {
      row = { id: crypto.randomUUID(), name };
      await DB.prepare("INSERT INTO playlists (id, name, created_at) VALUES (?,?,?)").bind(row.id, name, Date.now()).run();
    }
    // a playlist request leaves the queue once a playlist with the same name exists
    const asked = (await DB.prepare("SELECT id, title, image FROM requests WHERE kind = 'playlist' AND status = 'active'").all()).results.filter((r) => norm(r.title) === norm(name));
    for (const r of asked) { await coverFromRequest(env, row.id, r.image).catch(() => {}); await markDone(DB, r.id, row.id); }
    return json(row);
  }
  if ((x = path.match(/^\/api\/admin\/playlists\/([\w-]+)\/tracks$/)) && m === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!(await DB.prepare("SELECT 1 FROM tracks WHERE id = ?").bind(String(b.track_id)).first())) return json({ error: "Track not found." }, 404);
    await DB.prepare("INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, added_at) VALUES (?,?,?)").bind(x[1], String(b.track_id), Date.now()).run();
    return json({ ok: true });
  }
  if ((x = path.match(/^\/api\/admin\/playlists\/([\w-]+)$/)) && m === "DELETE") {
    await DB.batch([
      DB.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").bind(x[1]),
      DB.prepare("DELETE FROM playlists WHERE id = ?").bind(x[1]),
    ]);
    try { await DB.prepare("DELETE FROM entity_reactions WHERE kind = 'playlist' AND entity = ?").bind(x[1]).run(); } catch {}
    await env.MUSIC.delete(`art/playlist/${x[1]}`);
    return json({ ok: true });
  }
  if ((x = path.match(/^\/api\/admin\/tracks\/([\w-]+)\/cover$/)) && m === "PUT") {
    const t = await DB.prepare("SELECT artist, artists, album FROM tracks WHERE id = ?").bind(x[1]).first();
    const type = req.headers.get("content-type") || "";
    const size = Number(req.headers.get("content-length") || 0);
    if (!t || !/^image\/(jpeg|png|webp)$/.test(type) || !size || size > 5 * 1024 * 1024) return json({ error: "Bad cover image." }, 400);
    const key = t.album ? await artKey("album", artistsOfRow(t)[0], t.album) : `art/track/${x[1]}`;
    await env.MUSIC.put(key, req.body, { httpMetadata: { contentType: type }, customMetadata: { source: "embedded", at: String(Date.now()) } });
    return json({ ok: true });
  }
  if (path === "/api/admin/art/reset" && m === "POST") {
    // Forget downloaded artwork and misses (keeps covers embedded in your mp3s) so it is fetched again.
    let cursor, removed = 0;
    do {
      const l = await env.MUSIC.list({ prefix: "art/", cursor, include: ["customMetadata"] });
      const keys = l.objects.filter((o) => !["embedded", "custom"].includes(o.customMetadata?.source)).map((o) => o.key);
      if (keys.length) { await env.MUSIC.delete(keys); removed += keys.length; }
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    return json({ ok: true, removed });
  }
  if ((x = path.match(/^\/api\/admin\/tracks\/([\w-]+)$/))) {
    if (m === "DELETE") {
      await env.MUSIC.delete([x[1], `art/track/${x[1]}`, `lyrics/${x[1]}`, `lyrics2/${x[1]}`]);
      await DB.batch([
        DB.prepare("DELETE FROM tracks WHERE id = ?").bind(x[1]),
        DB.prepare("DELETE FROM track_artist_map WHERE track_id = ?").bind(x[1]),
        DB.prepare("DELETE FROM playlist_tracks WHERE track_id = ?").bind(x[1]),
        DB.prepare("DELETE FROM reactions WHERE track_id = ?").bind(x[1]),
      ]);
      return json({ ok: true });
    }
    if (m === "PATCH") {
      const b = await req.json().catch(() => ({}));
      const artists = artistsFromInput(b.artist);
      await DB.batch([
        DB.prepare("UPDATE tracks SET title = ?, artist = ?, artists = ?, album = ? WHERE id = ?")
          .bind(clean(b.title) || "Untitled", artists.join(", "), JSON.stringify(artists), clean(b.album), x[1]),
        ...artistIndexStatements(DB,{id:x[1],artist:artists.join(", "),artists:JSON.stringify(artists),album:clean(b.album)})
      ]);
      await env.MUSIC.delete([`lyrics/${x[1]}`, `lyrics2/${x[1]}`]);
      await fulfil(env, { title: clean(b.title), artists, album: clean(b.album) }).catch(() => {});
      return json({ ok: true });
    }
  }
  if (path === "/api/admin/clean" && m === "POST") {
    // Wipe the whole library: every stored file (songs and artwork) plus tracks, playlists, plays and reactions.
    // Requires the admin password and the word "confirm". The admin login itself is kept.
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    await DB.prepare("DELETE FROM attempts WHERE ts < ?").bind(Date.now() - 900000).run();
    const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE ip = ?").bind(ip).first();
    if (n >= 5) return json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    const b = await req.json().catch(() => ({}));
    if (String(b.confirm ?? "").trim() !== "confirm") return json({ error: 'Type "confirm" to continue.' }, 400);
    const row = await DB.prepare("SELECT salt, hash FROM admin WHERE id = 'admin'").first();
    if (!safeEq(await pbkdf2(String(b.password ?? ""), row.salt), row.hash)) {
      await DB.prepare("INSERT INTO attempts (ip, ts) VALUES (?, ?)").bind(ip, Date.now()).run();
      return json({ error: "Wrong password." }, 403);
    }
    let cursor, removed = 0;
    do {
      const l = await env.MUSIC.list({ cursor, limit: 1000 });
      const keys = l.objects.map((o) => o.key).filter((k) => !k.startsWith("site/")); // keep the browser icon
      if (keys.length) { await env.MUSIC.delete(keys); removed += keys.length; }
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    // Clear core tables first; optional tables (entity_reactions etc.) are best-effort so a
    // partial schema upgrade never blocks the wipe.
    await DB.batch([
      DB.prepare("DELETE FROM playlist_tracks"), DB.prepare("DELETE FROM playlists"),
      DB.prepare("DELETE FROM reactions"), DB.prepare("DELETE FROM tracks"), DB.prepare("DELETE FROM track_artist_map"), DB.prepare("DELETE FROM requests"),
      DB.prepare("DELETE FROM artist_info"), DB.prepare("DELETE FROM artist_similar"),
    ]);
    try { await DB.prepare("DELETE FROM entity_reactions").run(); } catch {}
    return json({ ok: true, removed });
  }
  if (path === "/api/admin/username" && m === "PUT") {
    const b = await req.json().catch(() => ({})), username = clean(b.username,32);
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return json({error:"Username must be 3–32 characters using letters, numbers, _ or -."},400);
    if (username.toLowerCase() === "admin") return json({error:"Choose a username other than admin."},400);
    const current=await DB.prepare("SELECT salt,hash FROM admin WHERE id='admin'").first();
    if(!current||!safeEq(await pbkdf2(String(b.password||''),current.salt),current.hash))return json({error:'Administrator password is incorrect.'},403);
    if (await DB.prepare("SELECT 1 FROM user_accounts WHERE username = ? COLLATE NOCASE").bind(username).first()) return json({error:"That username is already used by a member."},409);
    await DB.prepare("INSERT INTO settings (key,value) VALUES ('admin_username',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(username).run();
    return json({ok:true,username});
  }
  if (path === "/api/admin/password" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    const row = await DB.prepare("SELECT salt, hash FROM admin WHERE id = 'admin'").first();
    if (!safeEq(await pbkdf2(String(b.current ?? ""), row.salt), row.hash))
      return json({ error: "Current password is wrong." }, 403);
    const next = String(b.next ?? "");
    if (b.confirm !== undefined && String(b.confirm) !== next) return json({ error: "The new passwords don't match." }, 400);
    if (next.length < 8) return json({ error: "New password must be at least 8 characters." }, 400);
    if (next === b.current) return json({ error: "New password must be different." }, 400);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await DB.batch([
      DB.prepare("UPDATE admin SET salt = ?, hash = ? WHERE id = 'admin'").bind(salt, await pbkdf2(next, salt)),
      DB.prepare("DELETE FROM sessions WHERE token != ?").bind(sid),
    ]);
    return json({ ok: true });
  }

  // ---------- network (peer-to-peer library sharing) ----------
  if (path === "/api/admin/network" && m === "GET") {
    const share = await isSharing(DB);
    const peers = (await DB.prepare("SELECT id, url, name, track_count, last_ok, last_error, added_at FROM peers ORDER BY added_at").all()).results;
    const primary=(await DB.prepare("SELECT value FROM settings WHERE key='primary_peer_id'").first())?.value||"";
    return json({ share, primary_peer_id:primary, peers:peers.map(p=>({...p,is_primary:p.id===primary})) });
  }
  if (path === "/api/admin/network" && m === "PUT") {
    const b = await req.json().catch(() => ({}));
    const on = !!b.share;
    await DB.prepare("INSERT INTO settings (key, value) VALUES ('network_share', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(on ? "1" : "0").run();
    return json({ share: on });
  }
  if (path === "/api/admin/network/primary" && m === "PUT") {
    const b=await req.json().catch(()=>({}));
    const id=clean(b.peer_id,100);
    if (id && !(await DB.prepare("SELECT id FROM peers WHERE id=?").bind(id).first())) return json({error:"Peer not found"},404);
    await DB.prepare("INSERT INTO settings(key,value) VALUES('primary_peer_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(id).run();
    await touchCatalogue(DB);
    return json({ok:true,primary_peer_id:id});
  }
  if (path === "/api/admin/network/peers" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    let raw = clean(b.url, 300);
    if (!raw) return json({ error: "Paste a link to another music-app instance." }, 400);
    // Accept with or without trailing slash / path
    try {
      const u = new URL(raw.startsWith("http") ? raw : "https://" + raw);
      if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
      raw = u.origin; // store origin only
    } catch {
      return json({ error: "That doesn't look like a valid URL." }, 400);
    }
    // Don't add ourselves
    const self = new URL(req.url).origin;
    if (raw === self) return json({ error: "That's this site. Add a different instance." }, 400);
    const exists = await DB.prepare("SELECT id FROM peers WHERE url = ?").bind(raw).first();
    if (exists) return json({ error: "That peer is already in the list." }, 409);

    // Probe the peer
    let peerInfo = null, err = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(raw + "/api/peer", { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "music-app-peer" } });
      clearTimeout(t);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) err = j.error || `Peer answered ${r.status}`;
      else peerInfo = j;
    } catch (e) {
      err = e.name === "AbortError" ? "Timed out reaching the peer." : (e.message || "Could not reach the peer.");
    }
    if (err) return json({ error: err }, 502);

    const id = crypto.randomUUID();
    const now = Date.now();
    await DB.prepare(
      "INSERT INTO peers (id, url, name, track_count, last_ok, last_error, added_at) VALUES (?,?,?,?,?,?,?)")
      .bind(id, raw, peerInfo.name || raw, peerInfo.tracks || 0, now, null, now).run();
    return json({ id, url: raw, name: peerInfo.name || raw, track_count: peerInfo.tracks || 0, online: true, last_ok: now }, 201);
  }
  if ((x = path.match(/^\/api\/admin\/network\/peers\/([\w-]+)$/)) && m === "DELETE") {
    await ensureFederationSchema(DB);
    await DB.prepare("DELETE FROM mobile_federation_chunks WHERE gateway_id=?").bind(x[1]).run();
    await DB.prepare("DELETE FROM mobile_federation_sources WHERE gateway_id=?").bind(x[1]).run();
    await DB.prepare("DELETE FROM peer_catalogue_chunks WHERE peer_id = ?").bind(x[1]).run();
    await DB.prepare("DELETE FROM peer_catalogue_cache WHERE peer_id = ?").bind(x[1]).run();
    await DB.prepare("DELETE FROM peers WHERE id = ?").bind(x[1]).run();
    await DB.prepare("UPDATE settings SET value='' WHERE key='primary_peer_id' AND value=?").bind(x[1]).run();
    await touchCatalogue(DB);
    return json({ ok: true });
  }
  if ((x = path.match(/^\/api\/admin\/network\/peers\/([\w-]+)\/sync$/)) && m === "POST") {
    const peer=await DB.prepare("SELECT id,url,name FROM peers WHERE id=?").bind(x[1]).first();
    if(!peer)return json({error:"Peer not found"},404);
    const body=await req.json().catch(()=>({}));
    try {
      if(body.phase==="finish"){
        await snapshotPeerRevision(env,peer);
        const federation=(await DB.prepare("SELECT value FROM settings WHERE key='mobile_bridge_enabled'").first())?.value==='1'
          ?await syncFederatedFromGateway(env,peer).catch(e=>({sources:0,tracks:0,playlists:0,errors:[e.message]}))
          :null;
        await touchCatalogue(DB);
        return json({ok:true,phase:"finish",revision:await catalogueVersion(DB),federation});
      }
      const result=await syncPeerPhase(env,peer,body.phase);
      return json({ok:true,...result});
    }catch(e){return json({error:e.message||"Peer sync failed"},502);}
  }
  if ((x = path.match(/^\/api\/admin\/network\/peers\/([\w-]+)\/refresh$/)) && m === "POST") {
    const peer = await DB.prepare("SELECT * FROM peers WHERE id = ?").bind(x[1]).first();
    if (!peer) return json({ error: "Peer not found." }, 404);
    let peerInfo = null, err = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(peer.url + "/api/peer", { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "music-app-peer" } });
      clearTimeout(t);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) err = j.error || `Peer answered ${r.status}`;
      else peerInfo = j;
    } catch (e) {
      err = e.name === "AbortError" ? "Timed out reaching the peer." : (e.message || "Could not reach the peer.");
    }
    if (err) {
      await DB.prepare("UPDATE peers SET last_error = ?, last_ok = last_ok WHERE id = ?").bind(err, peer.id).run();
      return json({ error: err, online: false }, 502);
    }
    const now = Date.now();
    await DB.prepare("UPDATE peers SET name = ?, track_count = ?, last_ok = ?, last_error = NULL WHERE id = ?")
      .bind(peerInfo.name || peer.name, peerInfo.tracks || 0, now, peer.id).run();
    return json({ id: peer.id, url: peer.url, name: peerInfo.name || peer.name, track_count: peerInfo.tracks || 0, online: true, last_ok: now });
  }

  return json({ error: "Not found." }, 404);
}

export default {
  async scheduled(controller,env,ctx) {
    await init(env);
    const when=controller.scheduledTime||Date.now();
    const cronResults=await runDueCronJobs(env,when);
    // Telemetry cadence belongs to Network → Crons; default five minutes.
    const config=await getCronConfig(env.DB);
    const peerDue=shouldRunCron(config.jobs.peers,cronLocalDate(new Date(when),config.timezone));
    await telemetryScheduleTick(env,when,{skipTelemetry:peerDue});
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (env.DEEZER_API) DZ = env.DEEZER_API;
    if (env.WIKI_API) WIKI = env.WIKI_API;
    if (env.LRCLIB_API) LRC = env.LRCLIB_API;
    if (env.WIKIDATA_API) WIKIDATA = env.WIKIDATA_API;
    if (env.SPOTIFY_URL) SPOTIFY = env.SPOTIFY_URL;
    if (env.LYRICSOVH_API) OVH = env.LYRICSOVH_API;
    try {
      const hit=await cachedPublicResponse(req,url);
      if(hit) return hit;
      await init(env);
      if (!env.DB || !env.MUSIC) {
        return json({ error: "This Worker has no D1 database (DB) or R2 bucket (MUSIC) bound. Enable R2 on the account, then check the Git build log and the Worker bindings." }, 503);
      }
      // Isolated compatibility adapter: never interpret mobile URLs as native
      // WASP routes. Its authentication and storage are independent.
      if (url.pathname==='/mobile/artist-image')return await handleMobileArtistImage(req,env,url);
      if (url.pathname === '/mobile' || url.pathname === '/mobile/')
        return env.ASSETS.fetch(new Request(new URL('/mobile.html',url),req));
      if (/^\/(?:mobile\/)?rest\/[a-zA-Z][a-zA-Z0-9]*(?:\.view)?$/.test(url.pathname))
        return await handleMobileRest(req,env,url,{getBiography:async name=>{
          const bioUrl=new URL('/api/bio?name='+encodeURIComponent(name),url);
          const response=await serveBio(env,bioUrl,ctx);
          return response.ok?await response.json():null;
        }});
      const share = await isSharing(env.DB);
      // Peer CORS preflight
      if (req.method === "OPTIONS" && share) {
        const peerPaths = url.pathname.startsWith("/api/") || url.pathname.startsWith("/audio/") || url.pathname.startsWith("/art/") || url.pathname === "/site/favicon";
        if (peerPaths) return new Response(null, { status: 204, headers: CORS_PEER });
      }
      if (url.pathname === "/site/favicon") return withCors(await serveFavicon(env), share);
      if (url.pathname === "/site/brand") {
        const obj=await env.MUSIC.get("site/brand");if(!obj)return new Response(null,{status:404});
        const h=new Headers();obj.writeHttpMetadata(h);
        h.set("cache-control","public, max-age=86400");h.set("x-content-type-options","nosniff");
        return withCors(new Response(obj.body,{headers:h}),share);
      }
      if(url.pathname.startsWith("/art/user-playlist/")){
        const id=url.pathname.slice("/art/user-playlist/".length);
        if(!/^[\w-]+$/.test(id))return new Response("Not found",{status:404});
        const p=await env.DB.prepare("SELECT is_public,user_id FROM user_playlists WHERE id = ?").bind(id).first();
        const auth=await sessionInfo(req,env);
        if(!p || (!p.is_public && auth?.user_id!==p.user_id && auth?.role!=="admin"))return new Response("Not found",{status:404});
        const obj=await env.MUSIC.get(`art/user-playlist/${id}`);if(!obj)return new Response("Not found",{status:404});
        const h=new Headers();obj.writeHttpMetadata(h);h.set("cache-control","public, max-age=3600");return withCors(new Response(obj.body,{headers:h}),share);
      }
      if (url.pathname.startsWith("/audio/")) return withCors(await serveAudio(req, env, url.pathname.slice(7)), share);
      if (["/art/album", "/art/artist", "/art/track", "/art/playlist"].includes(url.pathname)) return withCors(await serveArt(env, url), share);
      if (url.pathname.startsWith("/api/")) {
        // Persist an audit record and expose in-flight admin operations.
        // Failed log writes never roll back music/user actions. All request bodies,
        // cookies, credentials and query values are deliberately omitted.
        let operation=null;
        const audited=req.method!=='GET'&&url.pathname.startsWith('/api/admin/')&&url.pathname!=='/api/admin/processes/logs/clear';
        if(audited){
          try{const admin=await sessionInfo(req,env);
            if(admin?.role==='admin'){const label=(await env.DB.prepare("SELECT value FROM settings WHERE key='admin_username'").first())?.value||'admin';operation=await startAdminOperation(env.DB,label,req.method,url.pathname);}
          }catch(error){console.warn('Unable to start admin audit',String(error.message).slice(0,80));}
        }
        let res;
        try{res=await api(req, env, url, ctx);}catch(error){
          if(operation)try{await finishAdminOperation(env.DB,operation,500);}catch{}
          throw error;
        }
        if(operation)try{await finishAdminOperation(env.DB,operation,res.status);}catch(error){console.warn('Unable to complete admin audit',String(error.message).slice(0,80));}
        // CORS only on public read endpoints (not admin)
        const publicPeer = share && (url.pathname === "/api/tracks" || url.pathname === "/api/playlists" || url.pathname === "/api/user-playlists" || url.pathname === "/api/site" || url.pathname === "/api/peer" || url.pathname === "/api/network/peers" || url.pathname === "/api/catalog-version" || url.pathname === "/api/peer-plays" || url.pathname === "/api/recent-listens" || url.pathname === "/api/active-streams" || url.pathname === "/api/telemetry/feed" || url.pathname === "/api/telemetry/metadata/feed");
        const output=withCors(res,publicPeer);
        if(req.method !== "GET" && output.ok && changesCatalogue(url.pathname)) {
          try { await touchCatalogue(env.DB); } catch(e) {console.warn("Unable to update catalogue revision",e.message);}
        }
        if(req.method !== "GET") invalidatePublicCache(req,url,output,ctx);
        return await storePublicResponse(req,url,output,ctx);
      }
    } catch (e) {
      return json({ error: "Server error: " + e.message }, 500);
    }
    return env.ASSETS.fetch(req);
  },
};
