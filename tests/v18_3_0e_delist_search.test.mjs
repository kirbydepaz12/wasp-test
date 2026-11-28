import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {addDelist,readDelists,hiddenByDelist,markDelisted,suggestDelists} from '../src/delists.js';
function dbFixture(){
 const db=new DatabaseSync(':memory:');
 class Q{constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return db.prepare(this.s).get(...this.a)||null}async all(){return {results:db.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:db.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s)};
 const env={DB,MUSIC:{get:async()=>null,list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 async function api(path,method='GET',body,session=''){
  const res=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(session?{cookie:'sid='+session}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});
  return {status:res.status,data:await res.json().catch(()=>null)};
 }
 async function admin(){const token=crypto.randomUUID();const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');db.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+100000,'admin');return token;}
 return {db,DB,env,api,admin};
}
test('Suggestions deduplicate local and HIVE candidates and preserve original credits',()=>{
 const cat={local:[{id:'x',title:'AFRAID TO DIE',artist:'P.O.D.; Jinjer',album:'VERITAS'},{id:'y',title:'Duality',artist:'Slipknot',album:'Vol.3'}],remote:[{id:'p1',origin:'https://peer.example',title:'Afraid To Die',artist:'Jinjer',album:'Single'},{id:'p2',origin:'https://peer.example',title:'New Song',artist:'Remote Artist'}]};
 assert.equal(suggestDelists(cat,{kind:'artist',query:'ji'}).length,1);
 assert.equal(suggestDelists(cat,{kind:'artist',query:'ji'})[0].artist,'Jinjer');
 const songs=suggestDelists(cat,{kind:'song',query:'afraid',artist:'Jinjer'});
 assert.ok(songs.find(x=>x.artist==='Jinjer'&&x.title==='AFRAID TO DIE'));
 assert.equal(suggestDelists(cat,{kind:'song',query:'new'})[0].source,'HIVE');
 assert.deepEqual(suggestDelists(cat,{kind:'artist',query:'x'}),[]);
});
test('Delist search hiding is independent from playback blocking',()=>{
 const song={title:'AFRAID TO DIE',artist:'P.O.D.; Jinjer'};
 const visible={rules:[{kind:'artist',key_artist:'jinjer',hide_search:0}]};
 assert.equal(markDelisted(song,visible).delisted,true);
 assert.equal(hiddenByDelist(song,visible),false);
 const hidden={rules:[{kind:'artist',key_artist:'jinjer',hide_search:1}]};
 assert.equal(markDelisted(song,hidden).delist_hidden,true);
 assert.equal(hiddenByDelist({title:'Other',artist:'P.O.D.'},hidden),false);
 const specific={rules:[{kind:'song',key_title:'afraid to die',key_artist:'jinjer',hide_search:1}]};
 assert.equal(hiddenByDelist(song,specific),true);
 assert.equal(hiddenByDelist({title:'Other',artist:'Jinjer'},specific),false);
});
test('Admin endpoint suggests only authenticated local and peer catalogue candidates',async()=>{
 const f=dbFixture();try{
  await f.api('/api/tracks');f.db.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('id1','My Song','Jinjer','Album',Date.now());
  assert.equal((await f.api('/api/admin/delists/suggest?q=jin&kind=artist')).status,403);
  const admin=await f.admin();const x=await f.api('/api/admin/delists/suggest?q=jin&kind=artist','GET',undefined,admin);
  assert.equal(x.status,200,JSON.stringify(x.data));assert.ok(x.data.candidates.some(v=>v.artist==='Jinjer'));
  const y=await f.api('/api/admin/delists/suggest?q=son&kind=song','GET',undefined,admin);assert.equal(y.data.candidates[0].title,'My Song');
 }finally{f.db.close();}
});
test('Existing global-hidden rules migrate; new rules default visible, per-rule updates persist',async()=>{
 const f=dbFixture();try{
  await f.api('/api/tracks');const admin=await f.admin();
  f.db.exec('DROP TABLE delist_rules');
  f.db.exec(`CREATE TABLE delist_rules (id TEXT PRIMARY KEY,kind TEXT,key_artist TEXT,key_title TEXT DEFAULT '',artist TEXT,title TEXT DEFAULT '',created_at INTEGER,UNIQUE(kind,key_artist,key_title))`);
  const oldId=crypto.randomUUID();f.db.prepare('INSERT INTO delist_rules(id,kind,key_artist,key_title,artist,title,created_at) VALUES(?,?,?,?,?,?,?)').run(oldId,'artist','jinjer','','Jinjer','',Date.now());
  f.db.prepare("INSERT INTO settings(key,value) VALUES('delists_searchable','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  const old=await f.api('/api/admin/delists','GET',undefined,admin);assert.equal(old.status,200);assert.equal(old.data.rules[0].hide_search,1);
  const created=await f.api('/api/admin/delists','POST',{kind:'song',title:'Duality',artist:'Slipknot'},admin);assert.equal(created.status,201);const rule=created.data.rules.find(x=>x.title==='Duality');assert.equal(rule.hide_search,0);
  const edit=await f.api('/api/admin/delists/'+rule.id+'/visibility','PUT',{hide_search:true},admin);assert.equal(edit.status,200);assert.equal(edit.data.rules.find(x=>x.id===rule.id).hide_search,1);
  const add=await f.api('/api/admin/delists','POST',{kind:'song',title:'Duality',artist:'Slipknot',hide_search:false},admin);assert.equal(add.status,201);assert.equal(add.data.rules.filter(x=>x.title==='Duality').length,1);assert.equal(add.data.rules.find(x=>x.id===rule.id).hide_search,1,'duplicate submission does not loosen a hidden rule');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM delist_rules').get().n,2);
 }finally{f.db.close();}
});
