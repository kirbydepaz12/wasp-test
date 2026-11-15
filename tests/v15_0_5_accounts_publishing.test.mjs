import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
const sqlite=new DatabaseSync(':memory:');
class Stmt {
  constructor(sql,args=[]){this.sql=sql;this.args=args;}
  bind(...args){return new Stmt(this.sql,args);}
  async first(){return sqlite.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.args)};}
  async run(){const r=sqlite.prepare(this.sql).run(...this.args);return {meta:{changes:r.changes}};}
}
const DB={prepare:s=>new Stmt(s),batch:async list=>{sqlite.exec('BEGIN');try{for(const q of list)await q.run();sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const files=new Map();
const env={DB,MUSIC:{get:async(k)=>files.get(k)||null,put:async(k,v)=>files.set(k,v),delete:async k=>{files.delete(k);}},ASSETS:{fetch:async()=>new Response('Not found',{status:404})}};
const hash=async(s)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const pbkdf2=async(password,salt)=>{const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(salt.match(/../g).map(x=>parseInt(x,16))),iterations:100000},key,256);return Array.from(new Uint8Array(bits)).map(b=>b.toString(16).padStart(2,'0')).join('');};
const salt='1234567890abcdef1234567890abcdef',password='admin-password-123';
let cookie='';
const call=async(path,method='GET',body,auth='',headers={})=>{
  const req=new Request('https://wasp.test'+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(auth?{cookie:auth}:{}) ,...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await worker.fetch(req,env,{});
  return {code:result.status,data:await result.json().catch(()=>null),cookie:result.headers.get('set-cookie')?.split(';')[0]||''};
};
const oldFetch=globalThis.fetch;
let online=true;
globalThis.fetch=async(input,opts)=>{
 const url=String(input);
 if(url.startsWith('https://cloudflare-dns.com/dns-query?')){
   const type=new URL(url).searchParams.get('type');
   return Response.json({Status:0,Answer:type==='A'?[{type:1,data:'104.21.44.12'}]:[]});
 }
 if(url==='https://friendly-music.example.org/api/peer'&&online)return Response.json({ok:true,name:'Community WASP',tracks:34});
 throw Error('Peer is offline');
};
try {
  assert.equal((await call('/api/me')).code,200);
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='wasp_schema_version'").get().value,'15.3');
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='user_published_peers'").get());
  sqlite.prepare("UPDATE admin SET salt=?,hash=? WHERE id='admin'").run(salt,await pbkdf2(password,salt));
  const admin=(await call('/api/login','POST',{id:'admin',password})).cookie;
  assert.ok(admin,'Admin login works');
  assert.equal((await call('/api/register','POST',{username:'alice',password:'alice-pass-123',confirm:'alice-pass-123'})).code,201);
  const user=(await call('/api/login','POST',{id:'alice',password:'alice-pass-123'})).cookie;
  assert.ok(user,'User login works');
  assert.equal((await call('/api/admin/users','GET',undefined,user)).code,403,'regular users are denied admin access');
  assert.equal((await call('/api/user/publish','POST',{url:'https://friendly-music.example.org'},user)).code,403,'permission denied by default');
  let users=await call('/api/admin/users','GET',undefined,admin);
  assert.equal(users.data[0].can_publish,0);const id=users.data[0].id;
  assert.equal((await call('/api/admin/users/'+id+'/publish','PUT',{enabled:true},user)).code,403,'user cannot approve themself');
  assert.equal((await call('/api/admin/users/'+id+'/publish','PUT',{enabled:true},admin)).code,200);
  for (const link of ['http://friendly-music.example.org','https://127.0.0.1','https://localhost','https://evil.example.org/path','https://user:pass@friendly-music.example.org','https://friendly-music.example.org:8443'])
    assert.equal((await call('/api/user/publish','POST',{url:link},user)).code,400,'Reject unsafe '+link);
  const published=await call('/api/user/publish','POST',{url:'https://friendly-music.example.org'},user);
  assert.equal(published.code,201,JSON.stringify(published.data));
  assert.equal((await call('/api/user/publish','POST',{url:'https://friendly-music.example.org'},user)).code,409);
  assert.equal((await call('/api/user/publish','GET',undefined,user)).data.links.length,1);
  const peers=(await call('/api/network/peers')).data;
  assert.equal(peers.length,1);assert.equal(peers[0].community,true);assert.equal(peers[0].is_primary,false);
  // A contributed peer can never be primary unless an administrator adds it
  // to the separate managed-peer registry.
  assert.equal((await call('/api/admin/network/primary','PUT',{peer_id:peers[0].id},admin)).code,404);
  sqlite.prepare('INSERT INTO peers(id,url,name,track_count,last_ok,added_at) VALUES(?,?,?,?,?,?)').run('managed','https://friendly-music.example.org','Admin source',34,Date.now(),1);
  assert.equal((await call('/api/admin/network/primary','PUT',{peer_id:'managed'},admin)).code,200);
  let chosen=(await call('/api/network/peers')).data;
  assert.equal(chosen.length,1,'Admin peer takes precedence over duplicate user link');
  assert.equal(chosen[0].community,false);assert.equal(chosen[0].is_primary,true);
  await call('/api/admin/network/primary','PUT',{peer_id:''},admin);
  sqlite.prepare("DELETE FROM peers WHERE id='managed'").run();
  assert.equal((await call('/api/network/peers')).data[0].is_primary,false);
  // The admin view refreshes health; offline URLs disappear from the shared
  // catalogue and do not count toward online links.
  online=false;
  let offline=await call('/api/admin/users','GET',undefined,admin);
  assert.equal(offline.data[0].online_links,0);
  assert.equal(offline.data[0].provided_links,1);
  assert.equal((await call('/api/network/peers')).data.length,0);
  online=true;
  assert.equal((await call('/api/admin/users','GET',undefined,admin)).data[0].online_links,1);

  users=await call('/api/admin/users','GET',undefined,admin);
  assert.equal(users.code,200);assert.equal(users.data[0].online_links,1);assert.equal(users.data[0].provided_links,1);
  assert.ok(!JSON.stringify(users.data).includes('friendly-music.example.org'),'Admin Users response does not include URLs');
  assert.ok(!JSON.stringify((await call('/api/admin/network','GET',undefined,admin)).data).includes('friendly-music.example.org'));
  // User rename requires current password and does not change stable ID or role.
  assert.equal((await call('/api/user/username','PUT',{username:'alice2',password:'wrong'},user)).code,403);
  assert.equal((await call('/api/user/username','PUT',{username:'alice2',password:'alice-pass-123'},user)).code,200);
  assert.equal((await call('/api/me','GET',undefined,user)).data.username,'alice2');
  assert.equal((await call('/api/admin/users','GET',undefined,user)).code,403);
  assert.equal((await call('/api/admin/username','PUT',{username:'owner',password:'wrong'},admin)).code,403);
  assert.equal((await call('/api/admin/username','PUT',{username:'owner',password},admin)).code,200);
  assert.equal((await call('/api/me','GET',undefined,admin)).data.username,'owner');
  assert.equal((await call('/api/me','GET',undefined,admin)).data.role,'admin');
  assert.equal((await call('/api/user/username','PUT',{username:'owner',password:'alice-pass-123'},user)).code,409);
  sqlite.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('song','Song','Artist','',1);
  assert.equal((await call('/api/react/song','POST',{kind:'heart',on:true},user,{'X-Visitor':'person12345'})).code,200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM reactions').get().n,1);
  sqlite.prepare('INSERT INTO user_playlists(id,user_id,name,created_at) VALUES(?,?,?,?)').run('pl',id,'My music',1);
  assert.equal((await call('/api/admin/users/'+id,'DELETE',{password,confirm:'wrong'},admin)).code,400);
  assert.equal((await call('/api/admin/users/'+id,'DELETE',{password:'wrong',confirm:'delete'},admin)).code,403);
  assert.equal((await call('/api/admin/users/'+id,'DELETE',{password,confirm:'delete'},user)).code,403);
  assert.equal((await call('/api/admin/users/'+id,'DELETE',{password,confirm:'delete'},admin)).code,200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM user_accounts').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM user_published_peers').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM user_playlists').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM reactions').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1,'shared audio tracks preserved');
  assert.equal((await call('/api/network/peers')).data.length,0);
  assert.equal((await call('/api/me','GET',undefined,user)).data.authenticated,false);
  assert.equal((await call('/api/admin/users','GET',undefined,admin)).data.length,0);
  console.log('PASS v15.0.5: role-safe rename, disabled-by-default community publishing, online-only counts, private admin users view, protected deletion');
} finally {globalThis.fetch=oldFetch;}
