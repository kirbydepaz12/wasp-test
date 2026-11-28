// Server-local non-destructive delisting. Never federate rules or erase telemetry.
// Delists block playback on this WASP server, but cannot revoke access offered
// directly by a remote, independently operated HIVE host.
export const normalizeDelist = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
const LIMIT = 500;
const hasOwn = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
export function delistCredits(track){
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
  const artistNames=delistCredits(track),title=normalizeDelist(track.title);
  for(const rule of policy.rules){
    if(rule.kind==='artist'&&artistNames.includes(rule.key_artist))return 'artist';
    if(rule.kind==='song'&&title===rule.key_title&&artistNames.includes(rule.key_artist))return 'song';
  }
  return null;
}
// A restriction and its search visibility are independent: all rules block
// playback, but each rule may opt out of search results on this installation.
export function hiddenByDelist(track,policy){
  if(!track||!policy?.rules?.length)return false;
  const artistNames=delistCredits(track),title=normalizeDelist(track.title);
  return policy.rules.some(rule=>Boolean(Number(rule.hide_search))&&artistNames.includes(rule.key_artist)&&
    (rule.kind==='artist'||(rule.kind==='song'&&title===rule.key_title)));
}
export function markDelisted(track,policy){const reason=evaluateDelist(track,policy);return {...track,delisted:!!reason,delist_reason:reason||null,delist_hidden:hiddenByDelist(track,policy)};}
// Admin-only autocomplete, deliberately bounded and based on already cached
// catalogue data; never contacts a peer or exposes hidden metadata publicly.
export function suggestDelists(catalogue,{kind='artist',query='',artist='',limit=16}={}){
  const q=normalizeDelist(query),fav=normalizeDelist(artist);
  if(q.length<2||!['artist','song'].includes(kind))return [];
  const found=new Map();
  for(const t of [...(catalogue?.local||[]),...(catalogue?.remote||[])]){
    const names=delistCredits(t),title=String(t.title||'').trim();
    let original=t.artists;
    if(typeof original==='string')try{original=JSON.parse(original);}catch{}
    const label=name=>{
      const available=Array.isArray(original)?original:String(t.artist||'').split(/\s*[;\/]\s*/);
      return available.find(n=>normalizeDelist(n)===name)||name;
    };
    if(kind==='artist'){
      for(const name of names){if(!name.includes(q))continue;
        const display=label(name);
        if(!found.has(name))found.set(name,{artist:display,title:'',source:t.origin?'HIVE':'Local',score:name.startsWith(q)?0:2});
        else if(!t.origin)found.get(name).source='Local';
      }
    }else{
      if(!normalizeDelist(title).includes(q))continue;
      for(const name of names){const key=normalizeDelist(title)+'|'+name;
        const score=(normalizeDelist(title).startsWith(q)?0:2)+(fav&&(name!==fav)?1:0);
        const current=found.get(key);
        if(!current||score<current.score||(!t.origin&&current.source!=='Local'))
          found.set(key,{title,artist:label(name),album:String(t.album||'').slice(0,120),source:t.origin?'HIVE':'Local',score});
      }
    }
    // Bound intermediate memory even if thousands of peer records share names.
    if(found.size>2500)break;
  }
  return [...found.values()].sort((a,b)=>a.score-b.score||a.artist.localeCompare(b.artist)||a.title.localeCompare(b.title)).slice(0,Math.max(1,Math.min(20,limit)))
    .map(({score,...v})=>v);
}
export async function ensureDelists(DB){
  await DB.prepare(`CREATE TABLE IF NOT EXISTS delist_rules (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('artist','song')),
    key_artist TEXT NOT NULL, key_title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
    hide_search INTEGER NOT NULL DEFAULT 0,
    UNIQUE(kind,key_artist,key_title))`).run();
}
async function migrateDelistVisibility(DB){
  // Older v18.3.0d deployments have a global search preference. On first
  // upgrade, carry that choice across to pre-existing rules, then let the
  // administrator manage each rule independently.
  try{await DB.prepare('ALTER TABLE delist_rules ADD COLUMN hide_search INTEGER NOT NULL DEFAULT 0').run();
    const old=await DB.prepare("SELECT value FROM settings WHERE key='delists_searchable'").first();
    if(old?.value==='0')await DB.prepare('UPDATE delist_rules SET hide_search=1').run();
  }catch(e){if(!/duplicate column/i.test(String(e)))throw e;}
}
export async function readDelists(DB){
  // Avoid a DDL request on every audio range/seek. Create this additive table
  // only when an older instance encounters the endpoint for the first time.
  const sql='SELECT id,kind,key_artist,key_title,artist,title,created_at,hide_search FROM delist_rules ORDER BY created_at DESC LIMIT 500';
  let rows;
  try{rows=await DB.prepare(sql).all();}
  catch(error){
    if(/no such table/i.test(String(error))){await ensureDelists(DB);rows=await DB.prepare(sql).all();}
    else if(/no such column.*hide_search/i.test(String(error))){await migrateDelistVisibility(DB);rows=await DB.prepare(sql).all();}
    else throw error;
  }
  const setting=await DB.prepare("SELECT value FROM settings WHERE key='delists_searchable'").first();
  return {searchable:setting?.value!=='0',rules:rows.results||[]};
}
export async function addDelist(DB,body){
  if(!body||!['artist','song'].includes(body.kind))throw Error('Choose artist or song');
  const artist=String(body.artist||'').trim().slice(0,200),title=body.kind==='song'?String(body.title||'').trim().slice(0,200):'';
  if(!artist||!normalizeDelist(artist)||body.kind==='song'&&!normalizeDelist(title))throw Error('Artist is required, and song delists need both title and artist');
  await ensureDelists(DB);
  await readDelists(DB); // migrate an older v18.3.0d table before writing
  const hideSearch=body.hide_search===true||body.hide_search===1;
  // An existing rule can be edited through Add without duplicating it.
  const exists=await DB.prepare('SELECT id FROM delist_rules WHERE kind=? AND key_artist=? AND key_title=?').bind(body.kind,normalizeDelist(artist),normalizeDelist(title)).first();
  if(exists)return readDelists(DB); // re-adding must not silently loosen an existing rule
  const row=(await DB.prepare('SELECT COUNT(*) AS n FROM delist_rules').first());
  if(Number(row?.n)>=LIMIT)throw Error('Maximum 500 delist rules');
  const id=crypto.randomUUID();
  await DB.prepare('INSERT OR IGNORE INTO delist_rules (id,kind,key_artist,key_title,artist,title,created_at,hide_search) VALUES(?,?,?,?,?,?,?,?)')
    .bind(id,body.kind,normalizeDelist(artist),normalizeDelist(title),artist,title,Date.now(),hideSearch?1:0).run();
  return readDelists(DB);
}
export async function removeDelist(DB,id){
  if(!/^[a-f0-9-]{36}$/i.test(String(id||'')))throw Error('Invalid rule ID');
  await ensureDelists(DB);
  await DB.prepare('DELETE FROM delist_rules WHERE id=?').bind(id).run();
  return readDelists(DB);
}

export async function setDelistVisibility(DB,id,hidden){
  if(!/^[a-f0-9-]{36}$/i.test(String(id||''))||typeof hidden!=='boolean')throw Error('Invalid visibility setting');
  await readDelists(DB);
  const result=await DB.prepare('UPDATE delist_rules SET hide_search=? WHERE id=?').bind(hidden?1:0,id).run();
  if(!result.meta?.changes)throw Error('Delist not found');
  return readDelists(DB);
}
