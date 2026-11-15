import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
const sql=new DatabaseSync(':memory:');
class Stmt {
  constructor(q,args=[]){this.q=q;this.args=args;}
  bind(...args){return new Stmt(this.q,args);}
  async first(){return sql.prepare(this.q).get(...this.args)||null;}
  async all(){return {results:sql.prepare(this.q).all(...this.args)};}
  async run(){const r=sql.prepare(this.q).run(...this.args);return {meta:{changes:r.changes}};}
}
const DB={prepare:q=>new Stmt(q),batch:async statements=>{sql.exec('BEGIN');try{for(const statement of statements)await statement.run();sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');throw error;}}};
const env={DB,MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{}},ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
const salt='1234567890abcdef1234567890abcdef';
const pbkdf2=async password=>{const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);return [...new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(salt.match(/../g).map(s=>parseInt(s,16))),iterations:100000},key,256))].map(x=>x.toString(16).padStart(2,'0')).join('');};
const call=async(path,method='GET',body,cookie='')=>{
  const response=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env,{});
  return {status:response.status,json:await response.json().catch(()=>null),cookie:response.headers.get('set-cookie')?.split(';')[0]||''};
};
const password='admin-long-password';
await call('/api/me');
assert.equal(sql.prepare("SELECT value FROM settings WHERE key='wasp_schema_version'").get().value,'15.3');
for(const name of ['user_publish_requests','user_publish_approval_notices'])assert.ok(sql.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name));
sql.prepare("UPDATE admin SET salt=?,hash=? WHERE id='admin'").run(salt,await pbkdf2(password));
const admin=(await call('/api/login','POST',{id:'admin',password})).cookie;
const register=async(name)=>{
  assert.equal((await call('/api/register','POST',{username:name,password:'password-123',confirm:'password-123'})).status,201);
  return (await call('/api/login','POST',{id:name,password:'password-123'})).cookie;
};
const alice=await register('alice');
let list=(await call('/api/admin/users','GET',undefined,admin)).json;
const aliceId=list[0].id;
assert.equal(list[0].can_publish,0,'default is disabled');
assert.equal((await call('/api/user/publish/request','POST',{},alice)).status,201);
assert.equal((await call('/api/user/publish/request','POST',{},alice)).json.already_requested,true,'same request is idempotent');
assert.equal((await call('/api/admin/users/publish-notifications','GET',undefined,alice)).status,403,'nonadmins cannot view request count');
assert.equal((await call('/api/admin/users/publish-notifications','GET',undefined,admin)).json.pending,1);
list=(await call('/api/admin/users','GET',undefined,admin)).json;
assert.equal(list[0].publish_requested,1);
assert.ok(!('url' in list[0]));
assert.equal((await call('/api/admin/users/'+aliceId+'/publish','PUT',{enabled:true},alice)).status,403);
assert.equal((await call('/api/admin/users/'+aliceId+'/publish','PUT',{enabled:true},admin)).status,200);
assert.equal((await call('/api/admin/users/publish-notifications','GET',undefined,admin)).json.pending,0,'grant clears admin request');
assert.equal((await call('/api/me','GET',undefined,alice)).json.publish_notice,true,'approval notice shown');
assert.equal((await call('/api/me','GET',undefined,alice)).json.publish_notice,true,'status poll must not clear notice');
assert.equal((await call('/api/user/publish','GET',undefined,alice)).json.approval_seen,true,'Publish tab acknowledges notice');
assert.equal((await call('/api/me','GET',undefined,alice)).json.publish_notice,false,'notice cleared when viewed');
assert.equal((await call('/api/admin/users/publish-default','GET',undefined,admin)).json.enabled,false);
assert.equal((await call('/api/admin/users/publish-default','PUT',{enabled:true},alice)).status,403);
assert.equal((await call('/api/admin/users/publish-default','PUT',{enabled:true},admin)).status,200);
assert.equal((await call('/api/admin/users/publish-default','GET',undefined,admin)).json.enabled,true);
const bob=await register('bob');
list=(await call('/api/admin/users','GET',undefined,admin)).json;
const bobId=list.find(u=>u.username==='bob').id;
assert.equal(list.find(u=>u.username==='bob').can_publish,1,'new users inherit global allow');
assert.equal((await call('/api/user/publish','GET',undefined,bob)).json.enabled,true);
assert.equal((await call('/api/admin/users/'+bobId+'/publish','PUT',{enabled:false},admin)).status,200,'admin may deny one user');
assert.equal((await call('/api/user/publish','GET',undefined,bob)).json.enabled,false);
assert.equal((await call('/api/user/publish/request','POST',{},bob)).status,201,'denied user may request');
assert.equal((await call('/api/admin/users/publish-notifications','GET',undefined,admin)).json.pending,1);
const charlie=await register('charlie');
assert.equal((await call('/api/user/publish','GET',undefined,charlie)).json.enabled,true,'third user inherits global allow');
// A globally-approved member can publish a public HTTPS peer without a per-user grant.
const oldFetch=globalThis.fetch;
globalThis.fetch=async input=>{
  const url=String(input);
  if(url.startsWith('https://cloudflare-dns.com/dns-query')){
    const type=new URL(url).searchParams.get('type');
    return Response.json({Status:0,Answer:type==='A'?[{type:1,data:'104.21.44.12'}]:[]});
  }
  if(url==='https://contributor.example.org/api/peer')return Response.json({ok:true,name:'Community',tracks:73});
  throw Error('Unknown network access: '+url);
};
try {
  const contributed=await call('/api/user/publish','POST',{url:'https://contributor.example.org'},charlie);
  assert.equal(contributed.status,201,JSON.stringify(contributed.json));
  const peers=(await call('/api/network/peers')).json;
  assert.equal(peers.length,1,'Global publishing adds a community peer to discovery');
  assert.equal(peers[0].community,true);
  assert.equal(peers[0].is_primary,false,'Contributed peer must never become the primary source');
}finally{globalThis.fetch=oldFetch;}
assert.equal((await call('/api/admin/users/publish-default','PUT',{enabled:false},admin)).status,200);
assert.equal((await call('/api/user/publish','GET',undefined,charlie)).json.enabled,false,'inherited user loses access when default off');
assert.equal((await call('/api/user/publish','GET',undefined,alice)).json.enabled,true,'explicit grants remain after default off');
assert.equal((await call('/api/admin/users/'+bobId+'/publish','PUT',{enabled:true},admin)).status,200);
assert.equal((await call('/api/admin/users/publish-notifications','GET',undefined,admin)).json.pending,0);
assert.equal((await call('/api/me','GET',undefined,bob)).json.publish_notice,true);
assert.equal((await call('/api/user/publish','GET',undefined,bob)).json.approval_seen,true);
assert.equal((await call('/api/me','GET',undefined,bob)).json.publish_notice,false);
// Regression: existing schema v15.2 repairs additive tables without resetting accounts.
sql.exec('DROP TABLE user_publish_requests; DROP TABLE user_publish_approval_notices;');
sql.prepare("UPDATE settings SET value='15.2' WHERE key='wasp_schema_version'").run();
const coldWorker=(await import('../src/index.js?migration-repair-v1506')).default;
const migrated=await coldWorker.fetch(new Request('https://wasp.test/api/me'),env,{});
assert.equal(migrated.status,200);
assert.ok(sql.prepare("SELECT name FROM sqlite_master WHERE name='user_publish_requests'").get());
assert.equal(sql.prepare("SELECT value FROM settings WHERE key='wasp_schema_version'").get().value,'15.3');
assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM user_accounts').get().n,3,'existing accounts retained');
console.log('PASS v15.0.6: global default, new-user inheritance, user override, request badge, approval acknowledgement, 15.2 safe migration');
