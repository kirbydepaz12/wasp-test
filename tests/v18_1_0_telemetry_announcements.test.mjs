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
 const api=async(path,method='GET',body,cookie='')=>{const response=await worker.fetch(new Request('https://main.example'+path,{method,headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env,{waitUntil:()=>{}});return {status:response.status,data:await response.json().catch(()=>null),cookie:response.headers.get('set-cookie')?.split(';')[0]||''};};
 await api('/api/me');
 sqlite.prepare('UPDATE admin SET salt=?,hash=? WHERE id=\'admin\'').run(salt,await pbkdf2('test-password-123'));
 const admin=(await api('/api/login','POST',{id:'admin',password:'test-password-123'})).cookie;
 assert.ok(admin);
 assert.equal((await api('/api/register','POST',{username:'listener',password:'user-password-123',confirm:'user-password-123'})).status,201);
 const user=(await api('/api/login','POST',{id:'listener',password:'user-password-123'})).cookie;assert.ok(user);
 return {sqlite,DB,env,api,admin,user,hash};
}

test('v18.1.0 separates public peer server name from browser tab name',async()=>{
 const f=await fixture();try{
  const updated=await f.api('/api/admin/settings','PUT',{site_name:'MAIN',tab_title:'Private browser title'},f.admin);assert.equal(updated.status,200);
  f.sqlite.prepare("INSERT INTO settings(key,value) VALUES('network_share','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const peer=await f.api('/api/peer');assert.equal(peer.status,200);assert.equal(peer.data.name,'MAIN');assert.equal(peer.data.title,'MAIN');
  assert.ok(!JSON.stringify(peer.data).includes('Private browser title'));
  assert.equal((await f.api('/api/site')).data.title,'Private browser title');
 }finally{f.sqlite.close()}
});

test('v18.1.0 local announcements require admin to send, are private to users and validate content',async()=>{
 const f=await fixture();try{
  assert.equal((await f.api('/api/user/announcements')).status,401);
  assert.equal((await f.api('/api/admin/announcements','GET',undefined,f.user)).status,403);
  assert.equal((await f.api('/api/admin/announcements','POST',{title:'Unauthorized',body:'Hi',severity:'info',opacity:.87},f.user)).status,403);
  {const x=await f.api('/api/admin/announcements','POST',{title:'',body:'Hi',severity:'info',opacity:.87},f.admin);assert.equal(x.status,400,JSON.stringify(x));}
  assert.equal((await f.api('/api/admin/announcements','POST',{title:'A',body:'B',severity:'critical',opacity:2},f.admin)).status,400);
  assert.equal((await f.api('/api/user/announcements','GET',undefined,f.user)).data.items.length,0);
  const msg={title:'<img src=x onerror=alert(1)> Update',body:'Music uploaded!\nNew albums available.',severity:'update',opacity:0.75};
  const sent=await f.api('/api/admin/announcements','POST',msg,f.admin);assert.equal(sent.status,201,JSON.stringify(sent));
  assert.ok(sent.data.id);
  const listed=await f.api('/api/user/announcements','GET',undefined,f.user);assert.equal(listed.status,200);
  assert.equal(listed.data.items.length,1);assert.equal(listed.data.items[0].body,msg.body);
  assert.equal(listed.data.items[0].title,msg.title);assert.equal(listed.data.items[0].opacity,0.75);
  assert.equal((await f.api('/api/admin/announcements','GET',undefined,f.admin)).data.items.length,1);
  assert.equal((await f.api('/api/network/peers')).status,200);
  assert.ok(!JSON.stringify((await f.api('/api/site')).data).includes('Music uploaded'));
  const feed=(await f.api('/api/telemetry/feed')).data;assert.ok(!JSON.stringify(feed).includes('Music uploaded'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,0);
 }finally{f.sqlite.close()}
});

test('v18.1.0 manual selection imports multiple peers without double counting, rejects unknown peers, clears cached summaries',async()=>{
 const f=await fixture();const old=globalThis.fetch;
 try{
  f.sqlite.prepare('INSERT INTO peers(id,url,name,added_at) VALUES(?,?,?,?)').run('p1','https://peer1.example','TEST',1);
  f.sqlite.prepare('INSERT INTO peers(id,url,name,added_at) VALUES(?,?,?,?)').run('p2','https://peer2.example','PROD',2);
  const list=await f.api('/api/admin/telemetry/peers','GET',undefined,f.admin);
  assert.equal(list.status,200);assert.deepEqual(list.data.peers.map(x=>x.name),['TEST','PROD']);
  assert.equal((await f.api('/api/admin/telemetry/peers','GET',undefined,f.user)).status,403);
  assert.equal((await f.api('/api/admin/telemetry/pull','POST',{peers:['https://malicious.example']},f.admin)).status,400);
  assert.equal((await f.api('/api/admin/telemetry/pull','POST',{peers:['https://peer1.example']},f.user)).status,403);
  const before=await f.api('/api/telemetry?period=week&scope=hive');assert.equal(before.data.plays,0);
  const when=Date.now()-60000;
  const origin='11111111-1111-4111-8111-111111111111';
  const e1={seq:1,origin_id:origin,event_id:'22222222-2222-4222-8222-222222222222',played_at:when,track_id:'a',title:'Song A',artist:'Artist',album:'Album',duration:180};
  const e2={...e1,seq:2,event_id:'33333333-3333-4333-8333-333333333333',title:'Song B'};
  const node1='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',node2='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const requests=[];
  globalThis.fetch=async input=>{
    const url=new URL(String(input));requests.push(url.hostname);
    if(url.pathname==='/api/peer')return Response.json({ok:true,name:url.hostname,tracks:1});
    if(url.pathname==='/api/telemetry/feed'){
      const first=url.hostname==='peer1.example',cursor=Number(url.searchParams.get('cursor'))||0;
      return Response.json({ok:true,protocol:1,nodeId:first?node1:node2,cursor:first?1:2,events:cursor?[]:first?[e1]:[e1,e2]});
    }throw Error('Unexpected URL '+url);
  };
  const result=await f.api('/api/admin/telemetry/pull','POST',{peers:['https://peer1.example','https://peer2.example']},f.admin);
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.data.imported,2);assert.equal(result.data.checked,2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get().n,2);
  assert.equal((await f.api('/api/telemetry?period=week&scope=hive')).data.plays,2,'new events visible without cached stale counts');
  assert.equal((await f.api('/api/telemetry?period=week&scope=local')).data.plays,0);
  const repeat=await f.api('/api/admin/telemetry/pull','POST',{peers:['https://peer1.example','https://peer2.example']},f.admin);
  assert.equal(repeat.data.imported,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get().n,2);
  assert.ok(requests.includes('peer1.example')&&requests.includes('peer2.example'));
 }finally{globalThis.fetch=old;f.sqlite.close()}
});
