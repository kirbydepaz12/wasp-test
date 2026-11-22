// WASP administrator-only process journal and audit trail.
// Never persist request payloads, cookies, passwords, tokens, IP addresses or query strings.
const bootstrapped = new WeakSet();
export async function ensureAdminOperations(DB) {
  if (bootstrapped.has(DB)) return;
  await DB.prepare(`CREATE TABLE IF NOT EXISTS admin_action_log (
    id TEXT PRIMARY KEY, happened_at INTEGER NOT NULL, actor TEXT NOT NULL,
    method TEXT NOT NULL, action TEXT NOT NULL, status INTEGER NOT NULL
  )`).run();
  await DB.prepare('CREATE INDEX IF NOT EXISTS idx_admin_action_log_time ON admin_action_log(happened_at DESC, id DESC)').run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS admin_active_operations (
    id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    actor TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL
  )`).run();
  bootstrapped.add(DB);
}
export function sanitizedAdminAction(path) {
  // Log only the HTTP route, never its parameters or request contents.
  return String(path || '').slice(0,160)
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id')
    .replace(/\/users\/[a-zA-Z0-9_-]{3,}(?=\/|$)/g, '/users/:id')
    .replace(/\/tracks\/[a-zA-Z0-9_-]{3,}(?=\/|$)/g, '/tracks/:id')
    .replace(/\/playlists\/[a-zA-Z0-9_-]{3,}(?=\/|$)/g, '/playlists/:id');
}
export async function startAdminOperation(DB, actor, method, path) {
  await ensureAdminOperations(DB);
  const id = crypto.randomUUID(), at = Date.now(), action = sanitizedAdminAction(path);
  await DB.prepare('INSERT INTO admin_active_operations(id,started_at,updated_at,actor,action,state) VALUES(?,?,?,?,?,?)')
    .bind(id, at, at, String(actor || 'admin').slice(0,80), `${method} ${action}`, 'running').run();
  return {id, at, actor: String(actor || 'admin').slice(0,80), method, action};
}
export async function finishAdminOperation(DB, operation, status) {
  if (!operation) return;
  await ensureAdminOperations(DB);
  const code=Number(status)||500;
  await DB.batch([
    DB.prepare('INSERT INTO admin_action_log(id,happened_at,actor,method,action,status) VALUES(?,?,?,?,?,?)')
      .bind(operation.id, operation.at, operation.actor, operation.method, operation.action, code),
    DB.prepare('DELETE FROM admin_active_operations WHERE id=?').bind(operation.id),
  ]);
}
export async function clearAdminLog(DB, actor) {
  await ensureAdminOperations(DB);
  await DB.batch([
    DB.prepare('DELETE FROM admin_action_log'),
    DB.prepare('INSERT INTO admin_action_log(id,happened_at,actor,method,action,status) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(),Date.now(),String(actor||'admin').slice(0,80),'DELETE','Admin audit history cleared',200),
  ]);
}
export async function readAdminLog(DB,{limit=120,beforeAt=0,beforeId=''}={}) {
  await ensureAdminOperations(DB);
  const take=Math.min(200,Math.max(1,Number(limit)||120));
  const rows=(beforeAt>0&&beforeId
    ? await DB.prepare('SELECT * FROM admin_action_log WHERE happened_at < ? OR (happened_at=? AND id<?) ORDER BY happened_at DESC,id DESC LIMIT ?').bind(beforeAt,beforeAt,beforeId,take+1).all()
    : await DB.prepare('SELECT * FROM admin_action_log ORDER BY happened_at DESC,id DESC LIMIT ?').bind(take+1).all()).results||[];
  const page=rows.slice(0,take),last=page.at(-1);
  return {entries:page,next:rows.length>take&&last?`${last.happened_at}:${last.id}`:null};
}
export function parseAdminCursor(value) {
  const match=String(value||'').match(/^(\d{12,15}):([0-9a-f-]{36})$/i);
  return match?{beforeAt:Number(match[1]),beforeId:match[2]}:{};
}
const reading=(obj) => {try{return JSON.parse(obj?.value||'{}');}catch{return {};}};
export async function readAdminProcesses(DB) {
  await ensureAdminOperations(DB);
  const now=Date.now(),items=[];
  // Short-lived API calls are registered while in flight. Interrupted ones are marked stale.
  const api=(await DB.prepare('SELECT id,actor,action,started_at,updated_at,state FROM admin_active_operations ORDER BY started_at DESC LIMIT 80').all()).results||[];
  for(const x of api)items.push({id:x.id,name:x.action,category:'Admin action',state:now-x.started_at>5*60*1000?'interrupted':'running',started_at:x.started_at,updated_at:x.updated_at,actor:x.actor});
  const records=(await DB.prepare("SELECT key,value FROM settings WHERE key IN ('hive_metadata_scan_v182','fingerprint_status') OR key LIKE 'manual_cron_%' LIMIT 1000").all()).results||[];
  for(const row of records){
    const s=reading(row);if(!s.state||s.state==='idle')continue;
    const started=Number(s.started||s.started_at||s.updated||s.updated_at||0),updated=Number(s.updated||s.updated_at||started)||0;
    if(row.key.startsWith('manual_cron_')){
      if(now-updated>24*3600*1000)continue;
      items.push({id:row.key,name:`${s.kind||'Unknown'} maintenance`,category:'Cron',state:['running','queued'].includes(s.state)&&now-updated>120000?'interrupted':s.state,started_at:started,updated_at:updated,progress:Number(s.progress)||0,message:String(s.message||'').slice(0,160)});
    }else if(row.key==='hive_metadata_scan_v182'){
      items.push({id:'metadata',name:'HIVE metadata scanner',category:'Metadata',state:s.state,started_at:started,updated_at:updated,progress:null,message:`${s.phase||'Scanning'} · ${Number(s.processed)||0} processed · ${Number(s.remaining)||0} due`});
    }else if(row.key==='fingerprint_status'){
      items.push({id:'hash',name:'SHA-256 music folder scan',category:'Storage',state:['queued','running'].includes(s.state)&&now-updated>10*60*1000?'interrupted':s.state,started_at:started,updated_at:updated,progress:Number(s.total)>0?Math.round((Number(s.scanned)||0)/Number(s.total)*100):null,message:`${Number(s.scanned)||0} / ${Number(s.total)||0} files`});
    }
  }
  items.sort((a,b)=>Number(b.started_at||b.updated_at||0)-Number(a.started_at||a.updated_at||0));
  return items.slice(0,100);
}
