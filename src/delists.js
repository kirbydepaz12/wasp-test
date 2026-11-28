// Server-local non-destructive delisting. Never federate rules or erase telemetry.
// Delists block playback on this WASP server, but cannot revoke access offered
// directly by a remote, independently operated HIVE host.
export const normalizeDelist = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
const LIMIT = 500;
const hasOwn = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
function credits(track){
  let a=track?.artists;
  if(typeof a==='string')try{a=JSON.parse(a);}catch{}
  if(Array.isArray(a)&&a.length)return a.map(normalizeDelist).filter(Boolean);
  // Match WASP's multi-artist tag convention, including comma-separated
  // contributors, but preserve artist names which themselves include commas.
  let raw=String(track?.artist||'').replace(/\0/g,';');
  const keep=['Tyler, The Creator','Earth, Wind & Fire','Emerson, Lake & Palmer',
    'Peter, Paul and Mary','Blood, Sweat & Tears','Crosby, Stills, Nash & Young',
    'Crosby, Stills & Nash'];
  const held=[];
  for(const artist of keep)raw=raw.replace(new RegExp(artist.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),matched=>{
    held.push(matched);return `\u0001${held.length-1}\u0001`;
  });
  return raw.replace(/\(\s*(?:feat\.?|ft\.?|featuring)\s+([^)]*)\)/gi,';$1')
    .split(/\s*(?:[;/,]|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+vs\.?\s+)\s*/i)
    .map(part=>part.replace(/\u0001(\d+)\u0001/g,(_,i)=>held[Number(i)]))
    .map(normalizeDelist).filter(Boolean).slice(0,12);
}
export function evaluateDelist(track,policy){
  if(!track||!policy?.rules?.length)return null;
  const artistNames=credits(track),title=normalizeDelist(track.title);
  for(const rule of policy.rules){
    if(rule.kind==='artist'&&artistNames.includes(rule.key_artist))return 'artist';
    if(rule.kind==='song'&&title===rule.key_title&&artistNames.includes(rule.key_artist))return 'song';
  }
  return null;
}
export function markDelisted(track,policy){const reason=evaluateDelist(track,policy);return {...track,delisted:!!reason,delist_reason:reason||null};}
export async function ensureDelists(DB){
  await DB.prepare(`CREATE TABLE IF NOT EXISTS delist_rules (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('artist','song')),
    key_artist TEXT NOT NULL, key_title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
    UNIQUE(kind,key_artist,key_title))`).run();
}
export async function readDelists(DB){
  // Avoid a DDL request on every audio range/seek. Create this additive table
  // only when an older instance encounters the endpoint for the first time.
  const sql='SELECT id,kind,key_artist,key_title,artist,title,created_at FROM delist_rules ORDER BY created_at DESC LIMIT 500';
  let rows;
  try{rows=await DB.prepare(sql).all();}
  catch(error){if(!/no such table/i.test(String(error)))throw error;await ensureDelists(DB);rows=await DB.prepare(sql).all();}
  const setting=await DB.prepare("SELECT value FROM settings WHERE key='delists_searchable'").first();
  return {searchable:setting?.value!=='0',rules:rows.results||[]};
}
export async function addDelist(DB,body){
  if(!body||!['artist','song'].includes(body.kind))throw Error('Choose artist or song');
  const artist=String(body.artist||'').trim().slice(0,200),title=body.kind==='song'?String(body.title||'').trim().slice(0,200):'';
  if(!artist||!normalizeDelist(artist)||body.kind==='song'&&!normalizeDelist(title))throw Error('Artist is required, and song delists need both title and artist');
  await ensureDelists(DB);
  const row=(await DB.prepare('SELECT COUNT(*) AS n FROM delist_rules').first());
  if(Number(row?.n)>=LIMIT)throw Error('Maximum 500 delist rules');
  const id=crypto.randomUUID();
  await DB.prepare('INSERT OR IGNORE INTO delist_rules (id,kind,key_artist,key_title,artist,title,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id,body.kind,normalizeDelist(artist),normalizeDelist(title),artist,title,Date.now()).run();
  return readDelists(DB);
}
export async function removeDelist(DB,id){
  if(!/^[a-f0-9-]{36}$/i.test(String(id||'')))throw Error('Invalid rule ID');
  await ensureDelists(DB);
  await DB.prepare('DELETE FROM delist_rules WHERE id=?').bind(id).run();
  return readDelists(DB);
}
