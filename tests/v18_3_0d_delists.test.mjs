import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {normalizeDelist,evaluateDelist,markDelisted,addDelist,readDelists} from '../src/delists.js';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q{constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ops=>{sql.exec('BEGIN');try{const out=[];for(const s of ops)out.push(await s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 let storageReads=0,storageWrites=0;
 const env={DB,SCANNER_SECRET:'test-gateway-secret',MUSIC:{
  get:async id=>{storageReads++;return {body:new Uint8Array([1,2,3]),size:3,httpEtag:'"etag"',writeHttpMetadata:h=>h.set('content-type','audio/mpeg')}},
  put:async()=>{storageWrites++;throw Error('Forbidden music write')},delete:async()=>{storageWrites++;throw Error('Forbidden music delete')},list:async()=>({objects:[]})},
  ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 async function api(path,method='GET',body,session='',headers={}){
  const options={method,headers:{...headers,...(session?{cookie:'sid='+session}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined};
  const result=await worker.fetch(new Request('https://wasp.test'+path,options),env,{waitUntil:()=>{}});
  return {status:result.status,data:await result.clone().json().catch(()=>null),text:await result.text()};
 }
 async function admin(){
  const token=crypto.randomUUID();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+86400000,'admin');return token;
 }
 return {sql,DB,env,api,admin,get reads(){return storageReads},get writes(){return storageWrites}};
}
const song=(id,title,artist,album='An Album')=>[id,title,artist,album,Date.now()];

test('Delist matching respects contributors, accented case, identity and specific song titles',()=>{
 assert.equal(normalizeDelist('  JINJER  '),'jinjer');
 const policy={rules:[{kind:'artist',key_artist:'jinjer',key_title:''}]};
 assert.equal(evaluateDelist({title:'Afraid to Die',artist:'P.O.D.; Jinjer'},policy),'artist');
 assert.equal(evaluateDelist({title:'Other',artist:'P.O.D.',artists:['P.O.D.','Jinjer']},policy),'artist');
 assert.equal(evaluateDelist({title:'Other',artist:'P.O.D., Tatiana Shmayluk, Jinjer'},policy),'artist');
 assert.equal(evaluateDelist({title:'Other',artist:'Gingerbread'},policy),null);
 assert.equal(evaluateDelist({title:'Other',artist:'Tyler, The Creator'}, {rules:[{kind:'artist',key_artist:'tyler, the creator'}]}),'artist');
 assert.equal(markDelisted({title:'Other',artist:'Jinjer'},policy).delisted,true);
 const specific={rules:[{kind:'song',key_artist:'jinjer',key_title:'afraid to die'}]};
 assert.equal(evaluateDelist({title:'AFRAID TO DIE',artist:'Jinjer'},specific),'song');
 assert.equal(evaluateDelist({title:'Afraid to Die (Live)',artist:'Jinjer'},specific),null);
 assert.equal(evaluateDelist({title:'Afraid to Die',artist:'Another Artist'},specific),null);
});

test('Admin-only rules preserve library and block audio and play events, but not telemetry rows',async()=>{
 const f=fixture();try{
  assert.equal((await f.api('/api/tracks')).status,200);
  const q=f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)');
  q.run(...song('t1','Hit Song','Jinjer','Album One'));
  q.run(...song('t2','A Different Song','P.O.D.; Jinjer','Mixed Album'));
  q.run(...song('t3','Good Song','P.O.D.','Mixed Album'));
  f.sql.prepare('INSERT INTO recent_listens(id,track_id,played_at,title,artist) VALUES(?,?,?,?,?)').run('listen1','t1',Date.now(),'Hit Song','Jinjer');
  assert.equal((await f.api('/api/admin/delists')).status,403);
  assert.equal((await f.api('/api/admin/delists','POST',{kind:'artist',artist:'Jinjer'})).status,403);
  const adm=await f.admin();
  let d=await f.api('/api/admin/delists','POST',{kind:'artist',artist:'Jinjer'},adm);
  assert.equal(d.status,201,JSON.stringify(d.data));assert.equal(d.data.rules.length,1);
  assert.equal((await f.api('/api/admin/delists','POST',{kind:'artist',artist:'jinjer'},adm)).data.rules.length,1,'same rule deduplicates');
  const catalogue=await f.api('/api/tracks');assert.equal(catalogue.data.length,3);
  assert.equal(catalogue.data.find(x=>x.id==='t1').delisted,true);
  assert.equal(catalogue.data.find(x=>x.id==='t2').delisted,true);
  assert.equal(catalogue.data.find(x=>x.id==='t3').delisted,false);
  assert.equal((await f.api('/audio/t1')).status,451);
  assert.equal((await f.api('/audio/t2','HEAD')).status,451);
  assert.equal((await f.api('/audio/t3')).status,200);
  assert.equal((await f.api('/api/play/t1','POST')).status,451);
  assert.equal((await f.api('/api/play/t3','POST')).status,200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tracks').get().n,3);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM recent_listens WHERE title='Hit Song'").get().n,1);
  assert.equal(f.writes,0);
  assert.equal((await f.api('/api/admin/delists/searchable','PUT',{searchable:false},adm)).data.searchable,false);
  assert.equal((await f.api('/api/delists')).data.searchable,false);
  const id=d.data.rules[0].id;
  assert.equal((await f.api('/api/admin/delists/'+id,'DELETE',undefined,adm)).status,200);
  assert.equal((await f.api('/audio/t1')).status,200,'restored after delist is removed');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM recent_listens WHERE id=?').get('listen1').n,1);
 }finally{f.sql.close();}
});

test('Individual song rule does not block its album or other artist songs',async()=>{
 const f=fixture();try{
  await f.api('/api/tracks');const a=await f.admin();
  const insert=f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)');
  insert.run(...song('s1','Duality','Slipknot','Vol 3'));
  insert.run(...song('s2','Before I Forget','Slipknot','Vol 3'));
  insert.run(...song('s3','Duality','Other Artist','Other Album'));
  assert.equal((await f.api('/api/admin/delists','POST',{kind:'song',artist:'Slipknot',title:'Duality'},a)).status,201);
  assert.equal((await f.api('/audio/s1')).status,451);
  assert.equal((await f.api('/audio/s2')).status,200);
  assert.equal((await f.api('/audio/s3')).status,200);
  assert.equal((await f.api('/api/tracks')).data.filter(x=>x.delisted).length,1);
 }finally{f.sql.close();}
});

test('Docker scanner-secret route cannot be bypassed for local or peer audio',async()=>{
 const f=fixture();try{
  await f.api('/api/tracks');const a=await f.admin();
  const insert=f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)');
  insert.run(...song('folder-123','Banned Track','Jinjer'));
  f.sql.prepare('INSERT INTO peer_track_refs(ref,origin,remote_id,title,artist) VALUES(?,?,?,?,?)').run('peer:123','https://peer.example','remote1','Banned Track','Jinjer');
  await f.api('/api/admin/delists','POST',{kind:'artist',artist:'Jinjer'},a);
  assert.equal((await f.api('/api/internal/delist/check?id=folder-123')).status,403);
  const headers={'x-scanner-secret':'test-gateway-secret'};
  assert.equal((await f.api('/api/internal/delist/check?id=folder-123','GET',undefined,'',headers)).data.allowed,false);
  assert.equal((await f.api('/api/internal/delist/check?origin=https%3A%2F%2Fpeer.example&remote_id=remote1','GET',undefined,'',headers)).data.allowed,false);
  assert.equal((await f.api('/api/internal/delist/check?origin=https%3A%2F%2Fpeer.example&remote_id=unknown','GET',undefined,'',headers)).data.allowed,false,'unknown peer is blocked when rules exist');
  assert.equal((await f.api('/api/internal/delist/check?origin=https%3A%2F%2Fpeer.example&remote_id=unknown&source_title=Good&source_artist=Different','GET',undefined,'',headers)).data.allowed,true,'authorized gateway can supply verified source metadata');
 }finally{f.sql.close();}
});
