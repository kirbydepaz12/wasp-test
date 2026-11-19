import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
let workerCount=0;
import {ensureHiveRequests,publishHiveRequest,hiveRequestFeed,syncHiveRequests,hiveRequestsForDisplay,dismissHiveRequests} from '../src/hive-requests.js';
import {ensureTelemetrySchema,recordTelemetryListen,telemetrySummary} from '../src/telemetry.js';
async function fixture(){
 const {default:worker}=await import('../src/index.js?fixture='+(++workerCount));
 const sql=new DatabaseSync(':memory:');
 class Q{constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ss=>{sql.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 const io={put:0,delete:0};const env={DB,MUSIC:{get:async()=>null,put:async()=>{io.put++},delete:async()=>{io.delete++},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const tasks=[],ctx={waitUntil(p){tasks.push(p)}};
 const api=async(path,method='GET',body,token)=>{const r=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{cookie:'sid='+token}:{})},body:body?JSON.stringify(body):undefined}),env,ctx);return {status:r.status,body:await r.json()}};
 return {sql,env,api,io,tasks};
}
async function setup(){const f=await fixture();const init=await f.api('/api/tracks');assert.equal(init.status,200,JSON.stringify(init.body));await ensureHiveRequests(f.env);f.sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();return f;}
const request=(title)=>({id:crypto.randomUUID(),kind:'song',title,artist:'Band',album:'Album',created_at:Date.now(),meta:null});
function insertOwn(f,r,status='active'){f.sql.prepare('INSERT INTO requests(id,kind,title,artist,album,created_at,dedupe,voter,ip,status) VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.id,r.kind,r.title,r.artist,r.album,r.created_at,r.id,'test-voter','test-ip',status);}
async function login(f,role='admin'){const t=crypto.randomUUID();const h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t)))).map(x=>x.toString(16).padStart(2,'0')).join('');f.sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(h,Date.now()+86400000,role);return t;}
const feed=async(f)=>await(await hiveRequestFeed(f.env,new URL('https://wasp.test/api/hive/requests/feed'))).json();
function addPeer(f,url){f.sql.prepare('INSERT INTO peers(id,url,name,added_at) VALUES(?,?,?,?)').run(crypto.randomUUID(),url,url,Date.now());}
const urlA='https://a.example',urlB='https://b.example';
const housekeeping='/api/admin/requests/housekeeping';

const review='/api/admin/requests/review';
const originId=f=>f.sql.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").get().value;
const track=(f,id,title,artist='Band',album='Album')=>f.sql.prepare('INSERT INTO tracks(id,title,artist,album,duration,created_at) VALUES(?,?,?,?,?,?)').run(id,title,artist,album,180,Date.now());
const seedPeer=(f,id,url,songs)=>{f.sql.prepare('INSERT INTO peers(id,url,name,added_at) VALUES(?,?,?,?)').run(id,url,url,Date.now());f.sql.prepare('INSERT INTO peer_catalogue_chunks(peer_id,kind,shard,body) VALUES(?,?,?,?)').run(id,'tracks',0,JSON.stringify(songs));};
const user=async(f,name='tester')=>{const r=await f.api('/api/register','POST',{username:name,password:'secure-pass-123',confirm:'secure-pass-123'});assert.equal(r.status,201,JSON.stringify(r.body));const row=f.sql.prepare('SELECT id FROM user_accounts WHERE username=?').get(name);const token=crypto.randomUUID(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(x=>x.toString(16).padStart(2,'0')).join('');f.sql.prepare('INSERT INTO sessions(token,expires,role,user_id) VALUES(?,?,?,?)').run(hash,Date.now()+600000,'user',row.id);return {token,id:row.id};};
test('v18.0.1 selected song completion is exact, artist counts are deduplicated, only manual completion moves artist/album',async()=>{
 const f=await setup(),admin=await login(f);track(f,'local1','Local song');track(f,'local2','Other song');track(f,'live','Version (Live)');
 seedPeer(f,'p1',urlA,[{id:'r1',title:'Peer song',artist:'Band',album:'Album'},{id:'r2',title:'Other song',artist:'Band',album:'Album'}]);seedPeer(f,'p2',urlB,[{id:'otherid',title:'Peer song',artist:'Band',album:'Album'}]);
 const rs=[request('Local song'),request('Peer song'),request('Version'),{...request('Band'),kind:'artist',artist:''},{...request('Album'),kind:'album'}];rs.forEach(r=>insertOwn(f,r));
 const payload={action:'refresh',ids:rs.map(r=>r.id),cached_only:true};assert.equal((await f.api(review,'POST',payload)).status,403);
 const result=await f.api(review,'POST',payload,admin);assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(result.body.results.map(r=>r.status),['done','done','progress','progress','progress']);
 assert.equal(result.body.results[3].matched_local,3);assert.equal(result.body.results[3].matched_peer,2);
 assert.equal((await f.api('/api/admin/requests','GET',undefined,admin)).body.find(r=>r.kind==='artist').matched_peer,2);
 const blocked=await f.api(review,'POST',{action:'complete',ids:[rs[2].id],confirm:true},admin);assert.ok(blocked.body.results[0].error);
 const done=await f.api(review,'POST',{action:'complete',ids:[rs[3].id,rs[4].id],confirm:true},admin);assert.equal(done.body.results.filter(r=>r.status==='done').length,2);
 assert.equal((await f.api('/api/requests/history')).body.length,4);assert.equal((await f.api('/api/requests')).body.length,1);assert.equal(f.io.delete,0);
});

test('v18.0.1 origin is admin only, unknown relay is not misidentified, offline hide returns on verified direct reconnect',async()=>{
 const a=await setup(),b=await setup(),c=await setup();const r=request('Remote song');r.image='https://a.example/private.jpg';r.url='https://a.example/secret';insertOwn(a,r);await publishHiveRequest(a.env,r);addPeer(b,urlA);addPeer(c,urlB);
 const fetcher=async input=>{const u=new URL(input);return hiveRequestFeed(u.hostname==='a.example'?a.env:b.env,u)};
 await syncHiveRequests(b.env,{force:true,fetcher});await syncHiveRequests(c.env,{force:true,fetcher});
 const bt=await login(b),ct=await login(c);let pub=(await b.api('/api/requests')).body[0];assert.ok(!JSON.stringify(pub).includes(urlA));assert.equal(pub.source_url,undefined);
 const br=(await b.api('/api/admin/requests','GET',undefined,bt)).body[0];assert.equal(br.origin_domain,urlA);assert.equal(br.origin_status,'online');const cr=(await c.api('/api/admin/requests','GET',undefined,ct)).body[0];assert.equal(cr.origin_domain,null);assert.equal(cr.origin_status,'unknown');
 const refuse=await c.api(review,'POST',{action:'hide-offline',ids:[cr.id]},ct);assert.ok(refuse.body.results[0].error);
 // A sharing-disabled peer is unknown, not offline.
 await syncHiveRequests(b.env,{force:true,fetcher:async()=>new Response('Forbidden',{status:403})});assert.equal((await b.api('/api/admin/requests','GET',undefined,bt)).body[0].origin_status,'unknown');
 await syncHiveRequests(b.env,{force:true,fetcher:async()=>{throw Error('unreachable')}});assert.equal((await b.api('/api/admin/requests','GET',undefined,bt)).body[0].origin_status,'offline');
 const hidden=await b.api(review,'POST',{action:'hide-offline',ids:[br.id]},bt);assert.equal(hidden.body.results[0].status,'hidden');assert.equal((await b.api('/api/requests')).body.length,0);assert.equal((await a.api('/api/requests')).body.length,1);
 await syncHiveRequests(b.env,{force:true,fetcher});assert.equal((await b.api('/api/requests')).body.length,1);
 track(b,'newlocal','Remote song');const done=await b.api(review,'POST',{action:'refresh',ids:[br.id],cached_only:true},bt);assert.equal(done.body.results[0].status,'done');assert.equal((await b.api('/api/requests/history')).body[0].local_completion,true);assert.equal((await a.api('/api/requests')).body.length,1);
 assert.equal((await b.api('/api/admin/requests','GET',undefined,(await user(b,'other')).token)).status,403);
});
const spotifyId='7LQWEN3CgFCE9Q2gZ5Q7Zv',spotifyURL='https://open.spotify.com/playlist/'+spotifyId;
function spotifyMock(visible,total){const original=globalThis.fetch;globalThis.fetch=async input=>{const u=String(input);if(u.startsWith('https://open.spotify.com/oembed?'))return Response.json({title:'Long Mix'});if(u.includes('/embed/playlist/'))return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({entity:{name:'Long Mix',trackCount:total},trackList:Array.from({length:visible},(_,i)=>({title:'Song '+(i+1),subtitle:'Band'}))})}</script>`);throw Error('Offline fixture '+u);};return ()=>globalThis.fetch=original;}

test('v18.0.1 325 song import, exact missing names, owner-only confirmation and recovery after partial finalization',async()=>{
 const restore=spotifyMock(325,325);try{const f=await setup(),u=await user(f),v=await user(f,'second');for(let i=1;i<=320;i++)track(f,'song'+i,'Song '+i);
 seedPeer(f,'p1',urlA,[{id:'r321',title:'Song 321',artist:'Band',album:'Album'},{id:'r322',title:'Song 322',artist:'Band',album:'Album'}]);
 const r=await f.api('/api/user/spotify-import','POST',{url:spotifyURL},u.token);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.total,325);assert.equal(r.body.matched,322);assert.equal(r.body.missing,3);const id=r.body.id,pid=r.body.playlist_id,base='/api/user/spotify-imports/'+id;
 assert.equal((await f.api(base+'/missing','GET',undefined,v.token)).status,404);assert.equal((await f.api(base+'/search','POST',{title:'Song 323',artist:'Band'},v.token)).status,404);const noHit=await f.api(base+'/search','POST',{title:'Song 323',artist:'Band'},u.token);assert.equal(noHit.status,200);assert.equal(noHit.body.found,false);const hit=await f.api(base+'/search','POST',{title:'Song 321',artist:'Band'},u.token);assert.equal(hit.body.found,true);assert.deepEqual((await f.api(base+'/missing','GET',undefined,u.token)).body.songs.map(t=>t.t),['Song 323','Song 324','Song 325']);assert.equal((await f.api(base+'/complete','POST',{},u.token)).status,409);assert.equal((await f.api(base+'/complete','POST',{confirm_partial:true},v.token)).status,404);
 assert.equal((await f.api(base+'/complete','POST',{confirm_partial:true},u.token)).status,200);assert.equal(f.sql.prepare('SELECT completed_partial FROM spotify_user_imports WHERE id=?').get(id).completed_partial,1);
 f.sql.prepare('DELETE FROM user_playlist_tracks WHERE playlist_id=? AND track_id=?').run(pid,'song1');track(f,'song323','Song 323');const next=await f.api(base+'/refresh','POST',{},u.token);assert.equal(next.status,200,JSON.stringify(next.body));assert.equal(next.body.missing,2);assert.ok(f.sql.prepare('SELECT 1 FROM user_playlist_tracks WHERE playlist_id=? AND track_id=?').get(pid,'song323'));assert.ok(!f.sql.prepare('SELECT 1 FROM user_playlist_tracks WHERE playlist_id=? AND track_id=?').get(pid,'song1'));
 assert.equal(f.io.delete,0);
 }finally{restore();}
});

test('v18.0.1 partial Spotify 100 of 325: user supplies 225 titles, duplicates ignored, no claim of verified completion',async()=>{
 const restore=spotifyMock(100,325);try{const f=await setup(),u=await user(f);for(let i=1;i<=325;i++)track(f,'song'+i,'Song '+i);
 const r=await f.api('/api/user/spotify-import','POST',{url:spotifyURL},u.token);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.total,100);assert.equal(r.body.source_total,325);assert.equal(r.body.partial,true);
 const base='/api/user/spotify-imports/'+r.body.id;const text='Title\tArtist\nSong 1\tBand\n'+Array.from({length:225},(_,i)=>'Song '+(i+101)+'\tBand').join('\n');const partial=await f.api(base+'/supplement','POST',{text},u.token);assert.equal(partial.status,200,JSON.stringify(partial.body));assert.equal(partial.body.total,325);assert.equal(partial.body.added,225);assert.equal(partial.body.matched,325);assert.equal(partial.body.partial,true);assert.equal((await f.api(base+'/complete','POST',{},u.token)).status,409);assert.equal((await f.api(base+'/complete','POST',{confirm_partial:true},u.token)).status,200);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM user_playlist_tracks WHERE playlist_id=?').get(r.body.playlist_id).n,325);
 }finally{restore();}
});

test('v18.0.1 unavailable saved reference can search and explicitly relink without deleting music, and unknown legacy reference accepts user-provided names',async()=>{
 const f=await setup(),u=await user(f),v=await user(f,'second');const pid='playlist-recovery',ref='peer:'+'f'.repeat(64),unknown='peer:'+'e'.repeat(64);track(f,'replacement','Saved song');track(f,'legacy','Legacy song');
 f.sql.prepare('INSERT INTO user_playlists(id,user_id,name,created_at) VALUES(?,?,?,?)').run(pid,u.id,'Recovery',1);f.sql.prepare('INSERT INTO user_playlist_tracks(playlist_id,track_id,added_at) VALUES(?,?,?)').run(pid,ref,31);f.sql.prepare('INSERT INTO user_playlist_tracks(playlist_id,track_id,added_at) VALUES(?,?,?)').run(pid,unknown,32);
 f.sql.prepare('INSERT INTO peer_track_refs(ref,origin,remote_id,title,artist,album,duration) VALUES(?,?,?,?,?,?,?)').run(ref,urlA,'old','Saved song','Band','Album',180);
 const path='/api/user/playlist-track-search',body={playlist_id:pid,ref};assert.equal((await f.api(path,'POST',body,v.token)).status,404);const hit=await f.api(path,'POST',body,u.token);assert.equal(hit.status,200,JSON.stringify(hit.body));assert.equal(hit.body.candidates[0].id,'replacement');assert.equal((await f.api(path,'POST',{...body,replace:'legacy'},u.token)).status,409);
 const relink=await f.api(path,'POST',{...body,replace:'replacement'},u.token);assert.equal(relink.status,200);assert.equal(f.sql.prepare('SELECT track_id FROM user_playlist_tracks WHERE playlist_id=? AND added_at=31').get(pid).track_id,'replacement');
 assert.equal((await f.api(path,'POST',{playlist_id:pid,ref:unknown},u.token)).status,404);const manual=await f.api(path,'POST',{playlist_id:pid,ref:unknown,title:'Legacy song',artist:'Band'},u.token);assert.equal(manual.body.candidates[0].id,'legacy');assert.equal(f.io.delete,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tracks').get().n,2);
});
