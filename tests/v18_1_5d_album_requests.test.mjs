import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {suggestAlbumCandidates} from '../src/request-playlist-match.js';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q {constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async stmts=>{sql.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const api=async(path,method='GET',body,token='')=>{const res=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(token?{cookie:'sid='+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});return {status:res.status,body:await res.json().catch(()=>null)}};
 return {sql,api};
}
async function admin(f){const token=crypto.randomUUID();const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');f.sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+86400000,'admin');return token;}
function track(f,id,title,artist,album){f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run(id,title,artist,album,Date.now())}
function addAlbumRequest(f,id,title,artist){f.sql.prepare("INSERT INTO requests(id,kind,title,artist,dedupe,voter,ip,created_at,status,meta) VALUES(?,'album',?,?,?,?,?,?,'active','{}')").run(id,title,artist,'album|'+id,'v','i',Date.now());}
function peer(f){const origin='https://hive.example';f.sql.prepare('INSERT INTO peers(id,url,added_at,last_error) VALUES(?,?,?,NULL)').run('peer',origin,Date.now());f.sql.prepare('INSERT INTO peer_catalogue_chunks(peer_id,kind,shard,body) VALUES(?,?,?,?)').run('peer','tracks',0,JSON.stringify([{id:'p1',title:'Duet',artist:'Cast',album:'High School Musical: The Musical: The Series (Original Soundtrack)'},{id:'p2',title:'Solo',artist:'Cast',album:'High School Musical: The Musical: The Series (Original Soundtrack)'}]));return origin;}

test('album candidates group local and synchronized HIVE tracks; never consider an album title alone completed',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await admin(f);const origin=peer(f);
 track(f,'l1','Duet','Cast','High School Musical: The Musical: The Series (Original Soundtrack)');
 track(f,'l2','Solo','Cast','High School Musical: The Musical: The Series (Original Soundtrack)');
 addAlbumRequest(f,'a1','High School Musical: The Musical: The Series (Original Soundtrack)','Cast');
 assert.equal((await f.api('/api/admin/requests/a1/candidates')).status,403);
 const response=await f.api('/api/admin/requests/a1/candidates','GET',undefined,token);
 assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.kind,'album');
 assert.equal(response.body.candidates.length,2,JSON.stringify(response.body));
 assert.ok(response.body.candidates.some(r=>r.origin===''&&r.track_count===2));
 assert.ok(response.body.candidates.some(r=>r.origin===origin&&r.track_count===2));
 const yes=await f.api('/api/admin/requests/a1/match','POST',{action:'accept',origin,album:'High School Musical: The Musical: The Series (Original Soundtrack)',index:0},token);
 assert.equal(yes.status,200,JSON.stringify(yes.body));assert.equal(yes.body.status,'active');
 assert.equal(yes.body.confirmed_album.track_count,2);
 assert.equal(f.sql.prepare('SELECT status FROM requests WHERE id=?').get('a1').status,'active');
 const listed=await f.api('/api/admin/requests','GET',undefined,token);
 assert.equal(listed.body.find(r=>r.id==='a1')?.confirmed_album?.origin,origin);
 const refresh=await f.api('/api/admin/requests/review','POST',{action:'refresh',ids:['a1'],cached_only:true},token);
 assert.equal(refresh.status,200);
 const still=await f.api('/api/admin/requests','GET',undefined,token);
 assert.equal(still.body.find(r=>r.id==='a1')?.confirmed_album?.origin,origin);
 f.sql.close();
});

test('album rejection removes a candidate, invalid group cannot be confirmed, explicit completion remains separate',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await admin(f);const origin=peer(f);addAlbumRequest(f,'a2','High School Musical: The Musical: The Series (Original Soundtrack)','Cast');
 const req='/api/admin/requests/a2';
 assert.equal((await f.api(req+'/match','POST',{action:'accept',origin,album:'Another Album'},token)).status,409);
 const reject=await f.api(req+'/match','POST',{action:'reject',origin,album:'High School Musical: The Musical: The Series (Original Soundtrack)'},token);
 assert.equal(reject.status,200);assert.equal(reject.body.status,'active');
 const list=await f.api(req+'/candidates','GET',undefined,token);assert.equal(list.body.candidates.some(c=>c.origin===origin),false);
 assert.equal(f.sql.prepare('SELECT status FROM requests WHERE id=?').get('a2').status,'active');
 f.sql.close();
});

test('album suggestion window includes both local and HIVE, supports explicit search without changing catalogue',()=>{
 const local=Array.from({length:25},(_,i)=>({id:'l'+i,title:'Song '+i,artist:'Cast',album:i%2?'The Musical: Album':'The Musical: Soundtrack'}));
 const remote=Array.from({length:25},(_,i)=>({id:'p'+i,remote_id:'p'+i,origin:'https://hive.example',title:'Song '+i,artist:'Cast',album:i%2?'The Musical: Album':'The Musical: Soundtrack'}));
 const l=suggestAlbumCandidates({t:'The Musical: Album',a:'Cast'},{local,remote});assert.ok(l.some(t=>!t.origin));assert.ok(l.some(t=>t.origin));
 assert.equal(suggestAlbumCandidates({t:'Unrelated',a:'Nobody'},{local,remote},{query:'Soundtrack'}).length,2);
});
