import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {syncTelemetryPeers} from '../src/telemetry.js';

async function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 class Q {constructor(query,params=[]){this.query=query;this.params=params}bind(...a){return new Q(this.query,a)}async first(){return sqlite.prepare(this.query).get(...this.params)||null}async all(){return {results:sqlite.prepare(this.query).all(...this.params)}}async run(){return {meta:{changes:sqlite.prepare(this.query).run(...this.params).changes}}}}
 const DB={prepare:q=>new Q(q),batch:async qs=>{sqlite.exec('BEGIN');try{const out=[];for(const q of qs)out.push(await q.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('Not found',{status:404})}};
 const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 const salt='1234567890abcdef1234567890abcdef';
 const pbkdf2=async password=>{const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(salt.match(/../g).map(x=>parseInt(x,16))),iterations:100000},key,256);return Array.from(new Uint8Array(bits)).map(x=>x.toString(16).padStart(2,'0')).join('')};
 const api=async(path,method='GET',body,cookie='')=>{const response=await worker.fetch(new Request('https://main.example'+path,{method,headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env,{waitUntil:()=>{}});return {status:response.status,data:await response.json().catch(()=>null),cookie:response.headers.get('set-cookie')?.split(';')[0]||'',cacheControl:response.headers.get('cache-control')||''};};
 await api('/api/me');
 sqlite.prepare('UPDATE admin SET salt=?,hash=? WHERE id=\'admin\'').run(salt,await pbkdf2('test-password-123'));
 const admin=(await api('/api/login','POST',{id:'admin',password:'test-password-123'})).cookie;
 assert.ok(admin);
 assert.equal((await api('/api/register','POST',{username:'listener',password:'user-password-123',confirm:'user-password-123'})).status,201);
 const user=(await api('/api/login','POST',{id:'listener',password:'user-password-123'})).cookie;assert.ok(user);
 return {sqlite,DB,env,api,admin,user,hash};
}


test('v18.1.1 public announcements reach guests, remain local and keep admin controls',async()=>{
 const main=await fixture(),testServer=await fixture();
 try{
   assert.equal((await main.api('/api/announcements')).status,200);
   assert.deepEqual((await main.api('/api/announcements')).data.items,[]);
   assert.equal((await main.api('/api/admin/announcements','POST',{title:'No',body:'No',opacity:.87,severity:'info'})).status,403);
   assert.equal((await main.api('/api/admin/announcements','POST',{title:'No',body:'No',opacity:.87,severity:'info'},main.user)).status,403);
   const r=await main.api('/api/admin/announcements','POST',{title:'Public <alert> notice',body:'System update in 10 min.',opacity:.62,severity:'maintenance'},main.admin);
   assert.equal(r.status,201,JSON.stringify(r));
   const guest=await main.api('/api/announcements');assert.equal(guest.status,200);
   assert.equal(guest.data.items[0].title,'Public <alert> notice');
   assert.equal(guest.data.items[0].body,'System update in 10 min.');
   assert.equal(guest.data.items[0].opacity,.62);
   assert.equal((await main.api('/api/announcements','GET',undefined,main.user)).data.items.length,1);
   assert.equal((await testServer.api('/api/announcements')).data.items.length,0,'no cross-HIVE broadcasts');
   const feed=await main.api('/api/telemetry/feed');assert.ok(!JSON.stringify(feed.data).includes('System update'));
   assert.equal((await main.api('/api/announcements')).data.items.length,1,'refresh still returns announcement');
 }finally{main.sqlite.close();testServer.sqlite.close()}
});

test('v18.1.1 Update current telemetry rebuilds this server statistics only',async()=>{
 const f=await fixture();try{
   assert.equal((await f.api('/api/admin/telemetry/recalculate','POST',{},f.user)).status,403);
   assert.equal((await f.api('/api/admin/telemetry/recalculate','POST',{})).status,403);
   await f.api('/api/telemetry?period=week&scope=hive');
   const local=f.sqlite.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").get().value;
   const now=Date.now();
   f.sqlite.prepare('INSERT INTO telemetry_events(origin_id,event_id,played_at,track_id,title,artist,album,duration) VALUES(?,?,?,?,?,?,?,?)').run(local,crypto.randomUUID(),now,'local-track','Local','Artist','Album',180);
   f.sqlite.prepare('INSERT INTO telemetry_events(origin_id,event_id,played_at,track_id,title,artist,album,duration) VALUES(?,?,?,?,?,?,?,?)').run('other-origin',crypto.randomUUID(),now,'remote-track','Remote','Artist','Album',180);
   f.sqlite.prepare("INSERT INTO telemetry_summary_cache(key,body,expires_at) VALUES('outdated','{}',?)").run(now+60000);
   const result=await f.api('/api/admin/telemetry/recalculate','POST',{},f.admin);
   assert.equal(result.status,200,JSON.stringify(result));
   assert.equal(result.data.localPlays,1);assert.equal(result.data.hivePlays,2);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM telemetry_summary_cache').get().n,0);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get().n,2,'no duplicate, deletion or peer pull');
   assert.equal((await f.api('/api/telemetry?period=week&scope=hive')).data.plays,2);
   assert.equal((await f.api('/api/telemetry?period=week&scope=local')).data.plays,1);
 }finally{f.sqlite.close()}
});


test('v18.3.0f: every announcement expires 10 minutes from server creation',async()=>{
 const f=await fixture();
 try{
   const post=async title=>{
     const r=await f.api('/api/admin/announcements','POST',{title,body:'Temporary notice',opacity:.87,severity:'maintenance'},f.admin);
     assert.equal(r.status,201,JSON.stringify(r));return r.data.id;
   };
   const old=await post('Old notice');
   // Pre-existing announcements must vanish on upgrade, not reappear for guests.
   f.sqlite.prepare('UPDATE server_announcements SET created_at=? WHERE id=?').run(Date.now()-600001,old);
   assert.deepEqual((await f.api('/api/announcements')).data.items,[]);
   assert.deepEqual((await f.api('/api/user/announcements','GET',undefined,f.user)).data.items,[]);
   assert.equal((await f.api('/api/admin/announcements','GET',undefined,f.user)).status,403);
   assert.deepEqual((await f.api('/api/admin/announcements','GET',undefined,f.admin)).data.items,[]);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM server_announcements').get().n,0,'expired history removed from storage');

   const active=await post('Still active');
   let guest=await f.api('/api/announcements');
   assert.deepEqual(guest.data.items.map(a=>a.id),[active]);
   assert.match(guest.cacheControl,/s-maxage=2/);
   assert.equal((await f.api('/api/user/announcements','GET',undefined,f.user)).data.items.length,1);

   // A notice with less than a second left cannot be cached at the edge.
   f.sqlite.prepare('UPDATE server_announcements SET created_at=? WHERE id=?').run(Date.now()-599500,active);
   guest=await f.api('/api/announcements');
   assert.deepEqual(guest.data.items.map(a=>a.id),[active]);
   assert.equal(guest.cacheControl,'no-store');

   f.sqlite.prepare('UPDATE server_announcements SET created_at=? WHERE id=?').run(Date.now()-600001,active);
   assert.deepEqual((await f.api('/api/announcements')).data.items,[]);
   assert.deepEqual((await f.api('/api/user/announcements','GET',undefined,f.user)).data.items,[]);
   assert.deepEqual((await f.api('/api/admin/announcements','GET',undefined,f.admin)).data.items,[]);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM server_announcements').get().n,0);

   // A future announcement must have its own full ten minutes, not be
   // suppressed by the old announcement's localStorage history.
   const fresh=await post('Second active notice');
   assert.deepEqual((await f.api('/api/announcements')).data.items.map(a=>a.id),[fresh]);
 }finally{f.sqlite.close()}
});
