import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {ensureAdminOperations,readAdminLog,readAdminProcesses,sanitizedAdminAction} from '../src/admin-operations.js';

async function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 class Q{constructor(sql,params=[]){this.sql=sql;this.params=params}bind(...p){return new Q(this.sql,p)}async first(){return sqlite.prepare(this.sql).get(...this.params)||null}async all(){return {results:sqlite.prepare(this.sql).all(...this.params)}}async run(){return {meta:{changes:sqlite.prepare(this.sql).run(...this.params).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async commands=>{sqlite.exec('BEGIN');try{const res=[];for(const c of commands)res.push(await c.run());sqlite.exec('COMMIT');return res;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('Not found',{status:404})}};
 const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(v=>v.toString(16).padStart(2,'0')).join('');
 const salt='1234567890abcdef1234567890abcdef';
 const secret=async password=>{const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(salt.match(/../g).map(x=>parseInt(x,16))),iterations:100000},key,256);return Array.from(new Uint8Array(bits)).map(v=>v.toString(16).padStart(2,'0')).join('');};
 const api=async(path,method='GET',body,cookie='')=>{const response=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env,{waitUntil:()=>{}});return {status:response.status,body:await response.json().catch(()=>null),cookie:response.headers.get('set-cookie')?.split(';')[0]||''};};
 await api('/api/me');sqlite.prepare("UPDATE admin SET salt=?,hash=? WHERE id='admin'").run(salt,await secret('test-pw-123'));
 const admin=(await api('/api/login','POST',{id:'admin',password:'test-pw-123'})).cookie;
 assert.ok(admin);
 return {sqlite,DB,env,api,admin,hash};
}

test('v18.1.2 auth, action history excludes secrets, clear is admin-only and audit records clearing',async()=>{
 const f=await fixture();try{
  assert.equal((await f.api('/api/admin/processes')).status,403);
  assert.equal((await f.api('/api/admin/processes/logs')).status,403);
  assert.equal((await f.api('/api/admin/processes/logs/clear','DELETE',{confirm:'clear logs'})).status,403);
  assert.equal((await f.api('/api/admin/processes/logs/clear','DELETE',{confirm:'no'},f.admin)).status,400);
  const payload={title:'Emergency <notice>',body:'Do not log this secret: PASSWORD-FROM-TEXT',severity:'warning',opacity:.8};
  assert.equal((await f.api('/api/admin/announcements','POST',payload,f.admin)).status,201);
  const logs=(await f.api('/api/admin/processes/logs','GET',undefined,f.admin)).body;
  assert.equal(logs.entries.length,1);
  assert.equal(logs.entries[0].action,'/api/admin/announcements');
  assert.equal(logs.entries[0].method,'POST');assert.equal(logs.entries[0].status,201);
  assert.ok(!JSON.stringify(logs).includes('PASSWORD-FROM-TEXT'));
  assert.ok(!JSON.stringify(logs).includes('Emergency <notice>'));
  assert.equal((await f.api('/api/admin/processes/logs/clear','DELETE',{confirm:'clear logs'},f.admin)).status,200);
  const after=(await f.api('/api/admin/processes/logs','GET',undefined,f.admin)).body.entries;
  assert.equal(after.length,1);assert.equal(after[0].action,'Admin audit history cleared');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM server_announcements').get().n,1,'clearing logs must not delete announcements');
  assert.equal((await f.api('/api/admin/version','GET',undefined,f.admin)).body.version,'18.1.5');
 }finally{f.sqlite.close();}
});

test('v18.1.2 running processes show metadata, hash, crons and pending admin actions without secrets',async()=>{
 const f=await fixture();try{
  await ensureAdminOperations(f.DB);
  const now=Date.now();
  const set=(k,v)=>f.sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(k,JSON.stringify(v));
  set('hive_metadata_scan_v182',{state:'running',started:now-30000,updated:now,processed:25,remaining:200,phase:'offline'});
  set('fingerprint_status',{state:'running',scanned:5,total:10,updated_at:now});
  set('manual_cron_00000000-0000-0000-0000-000000000001',{kind:'artwork',state:'running',progress:53,started:now-1000,updated_at:now,message:'Checking artwork'});
  f.sqlite.prepare("INSERT INTO admin_active_operations(id,started_at,updated_at,actor,action,state) VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(),now-2000,now,'admin','POST /api/admin/upload','running');
  const r=await f.api('/api/admin/processes','GET',undefined,f.admin);
  assert.equal(r.status,200);const items=r.body.processes;
  assert.ok(items.find(p=>p.id==='metadata'&&p.state==='running'));
  assert.equal(items.find(p=>p.id==='hash').progress,50);
  assert.equal(items.find(p=>p.category==='Cron').progress,53);
  assert.ok(items.find(p=>p.category==='Admin action'&&p.name.includes('upload')));
  assert.ok(!JSON.stringify(items).includes('password'));
 }finally{f.sqlite.close();}
});

test('v18.1.2 log cursors page without duplication; sanitized paths do not expose resource identifiers',async()=>{
 const f=await fixture();try{
  await ensureAdminOperations(f.DB);
  for(let i=0;i<301;i++)f.sqlite.prepare('INSERT INTO admin_action_log(id,happened_at,actor,method,action,status) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),Date.now()+i,'admin','PUT','/api/admin/settings',200);
  let cursor='',total=0,ids=new Set();do{const [at,id]=cursor?cursor.split(':'):[];const result=await readAdminLog(f.DB,{limit:120,...(cursor?{beforeAt:Number(at),beforeId:id}:{})});for(const row of result.entries){total++;assert.ok(!ids.has(row.id));ids.add(row.id);}cursor=result.next||'';}while(cursor);
  assert.equal(total,301);
  assert.equal(sanitizedAdminAction('/api/admin/users/abc-123def-901'),'/api/admin/users/:id');
 }finally{f.sqlite.close();}
});

test('v18.1.2 least-starred uses the global ascending aggregate rather than reversing top 100',async()=>{
 const f=await fixture();try{
  assert.equal((await f.api('/api/stars/batch','POST',{targets:[]})).status,200);
  const now=Date.now();
  const insert=f.sqlite.prepare('INSERT INTO star_votes(target_type,target_key,voter,stars,updated_at) VALUES(?,?,?,?,?)');
  for(let i=0;i<110;i++)insert.run('artist','High Artist '+i,'v'+i,5,now);
  insert.run('artist','Least Rated Artist','lowest',1,now);
  const high=await f.api('/api/stars/rankings?type=artist');
  assert.equal(high.status,200);assert.equal(high.body.items.length,100);
  assert.ok(!high.body.items.some(x=>x.key==='Least Rated Artist'));
  const low=await f.api('/api/stars/rankings?type=artist&sort=least');
  assert.equal(low.status,200);assert.equal(low.body.items[0].key,'Least Rated Artist');
  assert.equal(low.body.items[0].score,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM star_votes').get().n,111);
 }finally{f.sqlite.close();}
});
