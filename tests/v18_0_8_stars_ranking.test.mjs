import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q {constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ss=>{sql.exec('BEGIN');try{const out=[];for(const s of ss)out.push(await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const api=async(path,method='GET',body,visitor='visitor-1234')=>{
   const r=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{'X-Visitor':visitor,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});
   return {status:r.status,data:await r.json().catch(()=>null)};
 };
 return {sql,api};
}

test('star-ranked songs are sorted by total star votes, not historical likes',async()=>{
 const f=fixture();try{
  assert.equal((await f.api('/api/stars/rankings?type=track')).status,200);
  assert.deepEqual((await f.api('/api/stars/rankings?type=track')).data.items,[]);
  for(const [id,title] of [['t1','Song 1'],['t2','Song 2']])f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run(id,title,'Artist','Album',Date.now());
  f.sql.prepare('INSERT INTO reactions(track_id,voter,kind) VALUES(?,?,?)').run('t2','old-voter','like');
  const send=(key,stars,visitor)=>f.api('/api/stars','POST',{type:'track',key,stars},visitor);
  assert.equal((await send('t1',5,'visitor-1234')).status,200);
  assert.equal((await send('t1',4,'visitor-5678')).status,200);
  await send('t2',5,'visitor-9123');
  let result=(await f.api('/api/stars/rankings?type=track')).data.items;
  assert.deepEqual(result.map(x=>x.key),['t1','t2']);
  assert.equal(result[0].score,9);assert.equal(result[0].votes,2);assert.equal(result[0].average,4.5);
  assert.equal(Object.hasOwn(result[0],'voter'),false);
  assert.equal((await f.api('/api/stars/rankings?type=unknown')).status,400);
  await send('t1',0,'visitor-1234');
  result=(await f.api('/api/stars/rankings?type=track')).data.items;
  assert.equal(result[0].key,'t2');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM reactions').get().n,1);
 }finally{f.sql.close();}
});

test('star-ranked playlists exclude private accounts and unknown peer identities',async()=>{
 const f=fixture();try{
  await f.api('/api/tracks');
  const now=Date.now();
  f.sql.prepare('INSERT INTO playlists(id,name,created_at) VALUES(?,?,?)').run('public-server','Featured mix',now);
  f.sql.prepare('INSERT INTO user_accounts(id,username,salt,hash,created_at) VALUES(?,?,?,?,?)').run('u','user','a','b',now);
  f.sql.prepare('INSERT INTO user_playlists(id,user_id,name,is_public,created_at) VALUES(?,?,?,?,?)').run('private-u','u','Private mix',0,now);
  f.sql.prepare('INSERT INTO user_playlists(id,user_id,name,is_public,created_at) VALUES(?,?,?,?,?)').run('public-u','u','Public mix',1,now);
  f.sql.prepare('INSERT INTO peers(id,url,name,added_at) VALUES(?,?,?,?)').run('peer1','https://peer.example','Peer',now);
  await f.api('/api/stars/batch','POST',{targets:[]});
  const entries=[['public-server',5],['private-u',5],['public-u',4],['https://peer.example|remote',3],['https://unknown.invalid|remote',5]];
  for(const [i,[key,n]] of entries.entries())f.sql.prepare('INSERT INTO star_votes(target_type,target_key,voter,stars,updated_at) VALUES(?,?,?,?,?)').run('playlist',key,'voter'+i,n,now);
  const result=(await f.api('/api/stars/rankings?type=playlist')).data.items;
  assert.deepEqual(result.map(x=>x.key),['public-server','public-u','https://peer.example|remote']);
  assert.equal((await f.api('/api/stars/rankings?type=artist')).data.items.length,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM star_votes').get().n,5);
 }finally{f.sql.close();}
});
