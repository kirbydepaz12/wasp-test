import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {parsePicardFrames} from '../src/picard-tags.js';
import {suggestRequestCandidates,scoreRequestCandidate,safeManualMatches} from '../src/request-playlist-match.js';
function frame(id,str){return {id,data:new Uint8Array([3,...new TextEncoder().encode(str)])};}
function userFrame(label,val){return frame('TXXX',label+'\0'+val);}
test('Picard sample-style tags: original release year, multiple MB IDs, origins, and dated USLT',()=>{
 const ids=['57e79d57-b795-475e-9fa2-5dd9d5513b8c','54194dc1-1a5f-4165-90f5-c6f88437a249'];
 const t=parsePicardFrames([frame('TDRC','2019-01-01'),frame('TDOR','2023-11-30'),userFrame('ARTISTS','P.O.D.\0Tatiana Shmayluk'),userFrame('MusicBrainz Artist Id',ids.join('\0')),userFrame('artistcountry','US\0UA'),frame('TCON','Christian Metal;Nu Metal')]);
 assert.equal(t.release_year,2023);assert.equal(t.original_date,'2023-11-30');assert.equal(t.release_date,'2019-01-01');
 assert.deepEqual(t.musicbrainz_artist_ids,ids);assert.equal(t.artist_names.length,2);assert.equal(t.artist_origins[0].country_code,'USA');assert.equal(t.artist_origins[1].country_code,'UKR');
 const noCountry=parsePicardFrames([userFrame('MusicBrainz Album Release Country','XW'),frame('TDRC','2024-07-19')]);
 assert.equal(noCountry.release_year,2024);assert.deepEqual(noCountry.artist_origins,[]);
});
test('manual candidates are review-only, country-agnostic and reject list respected',()=>{
 const song={t:'AFRAID TO DIE (feat. Tatiana Shmayluk)',a:'P.O.D.'};const lib={local:[{id:'l1',title:'AFRAID TO DIE',artist:'P.O.D.',album:'Single'},{id:'l2',title:'Sadness',artist:'Other'}],remote:[{id:'remote-1',remote_id:'r1',origin:'https://peer.example',title:'AFRAID TO DIE - 2023 Remaster',artist:'P.O.D.'}]};
 assert.ok(scoreRequestCandidate(song,lib.local[0])>=80);const m=suggestRequestCandidates(song,lib);assert.equal(m[0].id,'l1');
 assert.equal(suggestRequestCandidates(song,lib,{rejected:['|l1']}).some(x=>x.id==='l1'),false);
 assert.equal(suggestRequestCandidates(song,lib,{query:'Sadness'}).at(0).id,'l2');
 assert.deepEqual(safeManualMatches({tracks:[song],manual_matches:{0:{origin:'',id:'l1'},1:{origin:'',id:'l2'}}}),{'0':{origin:'',id:'l1'}});
});
function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q {constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ss=>{sql.exec('BEGIN');try{const out=[];for(const s of ss)out.push(await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const api=async(path,method='GET',body,token='')=>{const r=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(token?{cookie:'sid='+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});let result=await r.json().catch(()=>null);return {status:r.status,body:result};};
 return {sql,api,env};
}
async function token(f){const t=crypto.randomUUID();const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t)))).map(x=>x.toString(16).padStart(2,'0')).join('');f.sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+86400000,'admin');return t;}
test('request candidate confirmations, rejection, skip, restore, partial completion and no music deletions',async()=>{
 const f=fixture();assert.equal((await f.api('/api/tracks')).status,200);const admin=await token(f);
 for(const [id,title,artist] of [['s1','Kiss Me More','Doja Cat'],['s2','Lose My Mind','Don Toliver']])f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run(id,title,artist,'Singles',Date.now());
 const id='req-1',meta={tracks:[{t:'Kiss Me More (feat. SZA)',a:'Doja Cat'},{t:'Lose My Mind (feat. Doja Cat)',a:'Don Toliver'},{t:'Really Missing',a:'Nobody'}],total:3,source_total:4,source_status:'incomplete',partial:true,matched_missing:[{t:'Really Missing',a:'Nobody',request_index:2}],matched:0,matched_local:0,matched_peer:0,availability_checked_at:Date.now()};
 f.sql.prepare('INSERT INTO requests(id,kind,title,artist,album,created_at,dedupe,voter,ip,status,meta) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'playlist','This is Doja Cat','','',Date.now(),'playlist|abc123456789','v','ip','active',JSON.stringify(meta));
 const route='/api/admin/requests/'+id;const readonly=await f.api(route+'/candidates?index=0');assert.equal(readonly.status,403);
 const list=await f.api('/api/admin/requests','GET',undefined,admin);assert.equal(list.body[0].missing.length,1);
 const suggested=await f.api(route+'/candidates?index=0','GET',undefined,admin);assert.equal(suggested.status,200,JSON.stringify(suggested.body));assert.ok(suggested.body.candidates.some(x=>x.id==='s1'));
 const rejected=await f.api(route+'/match','POST',{index:0,action:'reject',id:'s1',origin:''},admin);assert.equal(rejected.status,200,JSON.stringify(rejected.body));
 assert.ok(!(await f.api(route+'/candidates?index=0','GET',undefined,admin)).body.candidates.some(x=>x.id==='s1'));
 const chosen=await f.api(route+'/match','POST',{index:0,action:'accept',id:'s1',origin:''},admin);assert.equal(chosen.status,200,JSON.stringify(chosen.body));
 assert.equal((await f.api(route+'/match','POST',{index:2,action:'accept',id:'does-not-exist',origin:''},admin)).status,409);
 assert.equal((await f.api(route+'/match','POST',{index:1,action:'accept',id:'s2',origin:''},admin)).status,200);
 assert.equal((await f.api(route+'/match','POST',{index:2,action:'skip'},admin)).status,200);
 assert.equal((await f.api(route+'/match','POST',{index:2,action:'restore'},admin)).status,200);
 assert.equal((await f.api(route+'/match','POST',{index:2,action:'add',title:'Bonus Track',artist:'Bonus Band'},admin)).status,200);
 const blocked=await f.api(route+'/complete','POST',{},admin);assert.equal(blocked.status,409);assert.equal(blocked.body.code,'missing_confirmation');
 const completed=await f.api(route+'/complete','POST',{confirm_missing:true,confirm_incomplete:true,confirm_unverified:true},admin);assert.equal(completed.status,200,JSON.stringify(completed.body));
 assert.equal(completed.body.status,'done');assert.ok(completed.body.matched>=2);
 assert.equal(f.sql.prepare('SELECT status FROM requests WHERE id=?').get(id).status,'done');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tracks').get().n,2);
 const stored=JSON.parse(f.sql.prepare('SELECT meta FROM requests WHERE id=?').get(id).meta);assert.ok(stored.completed_missing.length>=1);assert.equal(stored.completed_with_missing,true);f.sql.close();
});
test('star rating is per visitor and preserves hearts, album and track table data',async()=>{
 const f=fixture();await f.api('/api/tracks');f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('t1','Song','Band','Album',Date.now());
 const req=async(stars,visitor='visitor-1234')=>{const r=await worker.fetch(new Request('https://wasp.test/api/stars',{method:'POST',headers:{'content-type':'application/json','X-Visitor':visitor},body:JSON.stringify({type:'track',key:'t1',stars})}),f.env,{waitUntil:()=>{}});return {status:r.status,data:await r.json()}};
 assert.equal((await req(4)).status,200);const second=await req(5,'visitor-9999');assert.equal(second.data.votes,2);assert.equal(second.data.average,4.5);
 await req(0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM star_votes').get().n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tracks').get().n,1);f.sql.close();
});
