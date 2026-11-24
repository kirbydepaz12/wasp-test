import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q { constructor(s,a=[]){this.s=s;this.a=a} bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async statements=>{sql.exec('BEGIN');try{const out=[];for(const stmt of statements)out.push(await stmt.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const api=async(path,method='GET',body,token='')=>{
   const res=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(token?{cookie:'sid='+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});
   return {status:res.status,body:await res.json().catch(()=>null)};
 };
 return {sql,api};
}
async function auth(f){const t=crypto.randomUUID();const h=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t)))].map(x=>x.toString(16).padStart(2,'0')).join('');f.sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(h,Date.now()+86400000,'admin');return t;}
function track(f,id,title,artist){f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run(id,title,artist,'Album',Date.now());}
function song(f,id,title,artist,meta={}){f.sql.prepare("INSERT INTO requests(id,kind,title,artist,dedupe,voter,ip,created_at,status,meta) VALUES(?,'song',?,?,?,?,?,?,'active',?)")
  .run(id,title,artist,'req|'+id,'v','i',Date.now(),JSON.stringify(meta));}
function playlist(f,id,tracks){const meta={tracks,total:tracks.length,matched:0,matched_local:0,matched_peer:0,matched_missing:tracks.map((s,index)=>({...s,request_index:index})),availability_checked_at:Date.now()};
 f.sql.prepare("INSERT INTO requests(id,kind,title,artist,dedupe,voter,ip,created_at,status,meta) VALUES(?,'playlist','Test playlist','','pl|test','v','i',?,'active',?)").run(id,Date.now(),JSON.stringify(meta));}
function peer(f){const origin='https://peer-music.example';f.sql.prepare('INSERT INTO peers(id,url,added_at,last_error) VALUES(?,?,?,NULL)').run('p1',origin,Date.now());
 f.sql.prepare('INSERT INTO peer_catalogue_chunks(peer_id,kind,shard,body) VALUES(?,?,?,?)').run('p1','tracks',0,JSON.stringify([{id:'peer1',title:'Are You Ready?',artist:'Creed',album:'Human Clay',duration:240},{id:'peer2',title:'Song from HIVE',artist:'Peer Artist',album:'Remote Album',duration:210}]));return origin;}

test('song candidate search finds both local and connected HIVE peer songs, without changing tracks',async()=>{
 const f=fixture();await f.api('/api/tracks');const t=await auth(f);track(f,'local-1','Are You Ready?','Creed');const origin=peer(f);song(f,'r1','Are You Ready?','Creed');
 assert.equal((await f.api('/api/admin/requests/r1/candidates')).status,403);
 const list=await f.api('/api/admin/requests/r1/candidates','GET',undefined,t);
 assert.equal(list.status,200,JSON.stringify(list.body));assert.equal(list.body.kind,'song');
 assert.equal(list.body.searched.local,1);assert.equal(list.body.searched.peer,2);
 assert.ok(list.body.candidates.some(c=>c.id==='local-1'&&c.origin===''));
 assert.ok(list.body.candidates.some(c=>c.id==='peer1'&&c.origin===origin));
 const search=await f.api('/api/admin/requests/r1/candidates?q=remote','GET',undefined,t);
 assert.ok(search.body.candidates.some(c=>c.id==='peer2'));assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tracks').get().n,1);
 f.sql.close();
});

test('rejecting false song match protects against automatic completion; accepting peer match finishes that song request',async()=>{
 const f=fixture();await f.api('/api/tracks');const t=await auth(f);track(f,'local-1','Are You Ready?','Creed');const origin=peer(f);song(f,'r1','Are You Ready?','Creed');
 const base='/api/admin/requests/r1';
 assert.equal((await f.api(base+'/match','POST',{index:0,action:'reject',id:'local-1',origin:''},t)).status,200);
 assert.ok(!(await f.api(base+'/candidates','GET',undefined,t)).body.candidates.some(c=>c.id==='local-1'));
 const refresh=await f.api('/api/admin/requests/review','POST',{action:'refresh',ids:['r1'],cached_only:true},t);
 assert.equal(refresh.status,200,JSON.stringify(refresh.body));assert.equal(refresh.body.results[0].status,'progress');
 assert.equal(f.sql.prepare("SELECT status FROM requests WHERE id='r1'").get().status,'active');
 assert.equal((await f.api(base+'/match','POST',{action:'skip',index:0},t)).status,400);
 assert.equal((await f.api(base+'/match','POST',{action:'accept',id:'unknown',origin},t)).status,409);
 const confirmed=await f.api(base+'/match','POST',{action:'accept',id:'peer1',origin},t);
 assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));assert.equal(confirmed.body.status,'done');assert.equal(confirmed.body.matched_peer,1);
 assert.equal(f.sql.prepare("SELECT status FROM requests WHERE id='r1'").get().status,'done');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tracks').get().n,1);f.sql.close();
});

test('missing playlist song creates one independent song request and keeps original playlist, dedupes, and is admin-only',async()=>{
 const f=fixture();await f.api('/api/tracks');const t=await auth(f);playlist(f,'pl1',[{t:'My Day',a:'HELLMERRY'},{t:'Other Song',a:'Singer'}]);
 assert.equal((await f.api('/api/admin/requests/pl1/request-track','POST',{index:0})).status,403);
 assert.equal((await f.api('/api/admin/requests/pl1/request-track','POST',{index:99},t)).status,400);
 const first=await f.api('/api/admin/requests/pl1/request-track','POST',{index:0},t);
 assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(first.body.title,'My Day');
 const repeat=await f.api('/api/admin/requests/pl1/request-track','POST',{index:0},t);
 assert.equal(repeat.status,200);assert.equal(repeat.body.already_requested,true);assert.equal(repeat.body.id,first.body.id);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM requests WHERE kind='song'").get().n,1);
 assert.equal(f.sql.prepare("SELECT status FROM requests WHERE id='pl1'").get().status,'active');
 assert.equal(JSON.parse(f.sql.prepare("SELECT meta FROM requests WHERE id='pl1'").get().meta).tracks.length,2);
 assert.equal((await f.api('/api/admin/requests/'+first.body.id+'/candidates','GET',undefined,t)).status,200);
 f.sql.close();
});

test('rejecting false playlist match makes entry missing and eligible for separate request even when same title exists locally',async()=>{
 const f=fixture();await f.api('/api/tracks');const t=await auth(f);track(f,'wrong','My Day','HELLMERRY');playlist(f,'pl1',[{t:'My Day',a:'HELLMERRY'}]);
 const first=await f.api('/api/admin/requests/pl1/match','POST',{action:'reject',index:0,id:'wrong',origin:''},t);
 assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.missing.length,1);
 assert.equal(first.body.missing[0].request_index,0);
 assert.equal((await f.api('/api/admin/requests/pl1/candidates?index=0','GET',undefined,t)).body.candidates.some(c=>c.id==='wrong'),false);
 const reviewed=await f.api('/api/admin/requests/review','POST',{action:'refresh',ids:['pl1'],cached_only:true},t);
 assert.equal(reviewed.status,200,JSON.stringify(reviewed.body));assert.equal(reviewed.body.results[0].missing.length,1);
 const separate=await f.api('/api/admin/requests/pl1/request-track','POST',{index:0},t);
 assert.equal(separate.status,201);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM requests WHERE status='active'").get().n,2);
 const newMeta=JSON.parse(f.sql.prepare('SELECT meta FROM requests WHERE id=?').get(separate.body.id).meta);
 assert.equal(newMeta.require_manual_match,true);
 assert.ok(newMeta.rejected_candidates.includes('|wrong'));
 const auto=await f.api('/api/admin/requests/review','POST',{action:'refresh',ids:[separate.body.id],cached_only:true},t);
 assert.equal(auto.body.results[0].status,'progress');
 assert.equal(f.sql.prepare('SELECT status FROM requests WHERE id=?').get(separate.body.id).status,'active');
 f.sql.close();
});

test('candidate window preserves local and HIVE peer suggestions even with many results',async()=>{
 const {suggestRequestCandidates}=await import('../src/request-playlist-match.js');
 const catalogue={local:Array.from({length:30},(_,i)=>({id:'l'+i,title:'Song',artist:'Band',album:'A'})),remote:Array.from({length:30},(_,i)=>({id:'p'+i,remote_id:'p'+i,origin:'https://peer.example',title:'Song',artist:'Band',album:'B'}))};
 const result=suggestRequestCandidates({t:'Song',a:'Band'},catalogue,{limit:12});
 assert.equal(result.length,12);
 assert.ok(result.some(c=>c.origin===''), 'local songs should remain selectable');
 assert.ok(result.some(c=>c.origin==='https://peer.example'), 'connected peer songs should remain selectable');
});
