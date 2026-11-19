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

test('v18 three-node request housekeeping survives re-sync, keeps origin/relay events and preserves completed history',async()=>{
 const A=await setup(),B=await setup(),C=await setup();
 const r1=request('Dismiss me'),r2=request('Keep me'),r3=request('Remove all remote');
 for(const r of [r1,r2,r3]){insertOwn(A,r);await publishHiveRequest(A.env,r);}
 addPeer(B,urlA);addPeer(C,urlA);addPeer(C,urlB);
 const fetcher=async input=>{const u=new URL(input);return hiveRequestFeed(u.hostname==='a.example'?A.env:B.env,u)};
 await syncHiveRequests(B.env,{fetcher,force:true});await syncHiveRequests(C.env,{fetcher,force:true});
 assert.equal((await hiveRequestsForDisplay(B.env)).length,3);assert.equal((await hiveRequestsForDisplay(C.env)).length,3);
 const token=await login(B),other=await login(B,'user');const target=(await hiveRequestsForDisplay(B.env)).find(r=>r.title===r1.title);
 for(const auth of [undefined,other])assert.equal((await B.api(housekeeping,'POST',{mode:'selected',ids:[target.id],confirm:true},auth)).status,403);
 assert.equal((await B.api(housekeeping,'POST',{mode:'selected',ids:[target.id],confirm:false},token)).status,400);
 assert.equal((await B.api(housekeeping,'POST',{mode:'selected',ids:[target.id],confirm:true},token)).body.remote,1);
 assert.equal((await B.api('/api/requests')).body.length,2);assert.equal((await B.api('/api/admin/requests','GET',undefined,token)).body.length,2);
 assert.equal((await B.api(housekeeping,'POST',{mode:'selected',ids:[target.id],confirm:true},token)).body.remote,0);
 assert.equal((await feed(A)).events.length,3);assert.equal((await feed(B)).events.length,3);assert.equal((await hiveRequestsForDisplay(C.env)).length,3);
 // A new event on the original ID must not undo a local dismissal.
 await new Promise(r=>setTimeout(r,2));await publishHiveRequest(A.env,{...r1,title:'Updated title'});await syncHiveRequests(B.env,{fetcher,force:true});
 assert.equal((await hiveRequestsForDisplay(B.env)).length,2);
 assert.equal((await B.api(housekeeping,'POST',{mode:'remote',confirm:true},token)).body.remote,2);
 assert.equal((await B.api('/api/requests')).body.length,0);assert.equal((await hiveRequestsForDisplay(C.env)).length,3);
 const own=request('Own active'),completed=request('Old completed');insertOwn(B,own);insertOwn(B,completed,'done');
 const result=await B.api(housekeeping,'POST',{mode:'all',confirm:true},token);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.local,1);
 assert.equal(B.sql.prepare('SELECT status FROM requests WHERE id=?').get(completed.id).status,'done');assert.equal(B.sql.prepare('SELECT 1 FROM requests WHERE id=?').get(own.id),undefined);
 assert.ok((await feed(B)).events.some(e=>e.request_id===own.id&&e.status==='cancelled'));
 assert.equal(B.io.delete,0);assert.equal(B.io.put,0);
});

test('v18 bulk local removal bounded, selected invalid/unknown IDs safe, previous requests retained',async()=>{
 const f=await setup(),token=await login(f);const entries=Array.from({length:19},(_,i)=>request('Request '+i));for(const r of entries)insertOwn(f,r);
 const history=request('Already done');insertOwn(f,history,'done');
 assert.equal((await f.api(housekeeping,'POST',{mode:'selected',ids:entries.slice(0,9).map(x=>x.id),confirm:true},token)).status,400);
 const partial=await f.api(housekeeping,'POST',{mode:'selected',ids:[entries[0].id,entries[0].id,history.id,'unknown-id'],confirm:true},token);assert.equal(partial.body.local,1);
 let count=0,more=true;while(more){const r=await f.api(housekeeping,'POST',{mode:'all',confirm:true},token);assert.equal(r.status,200);assert.ok(r.body.local<=8);count+=r.body.local;more=r.body.more;}
 assert.equal(count,18);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM requests WHERE status='done'").get().n,1);assert.equal(f.io.delete,0);
});

test('v18 country winners are per-origin, top album belongs to winning artist; decades rank independently at scale and cache correctly',async()=>{
 const f=await setup();const now=Date.UTC(2026,10,18,12),local=(await f.env.DB.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").first()).value;
 const foreign=crypto.randomUUID();const insert=f.sql.prepare('INSERT INTO telemetry_events(origin_id,event_id,played_at,title,artist,album,release_year,country_code) VALUES(?,?,?,?,?,?,?,?)');
 const seed=(artist,album,country,year,count=1,origin=local,at=now)=>{for(let i=0;i<count;i++)insert.run(origin,crypto.randomUUID(),at,'Track '+i,artist,album,year,country);};
 seed('Sum 41','Chuck','CAN',2004,6);seed('Sum 41','Does This Look Infected?','CAN',2002,5);seed('Other Artist','Other Album','CAN',2004,10); // winning artist total 11; other album individually 10
 seed('Sepultura','Roots','BRA',1996,4);seed('Sum 41','Incorrect origin','BRA',2000,1);
 seed('Old Band','Early','GBR',1948,3);seed('Old Band','Early','GBR',1953,3);seed('Another Old','Other early','GBR',1959,5);
 seed('Unknown','Undated','',0,4);seed('Foreign artist','Foreign album','CAN',2021,30,foreign);seed('Future artist','Not part of selected year','CAN',2025,20,local,Date.UTC(2025,10,18));
 // More than 250 albums in one decade must not starve a sparsely represented decade.
 for(let i=0;i<260;i++)seed('Big Artist','Album '+i,'USA',2010,2);
 const U=(scope)=>new URL('https://wasp.test/api/telemetry?period=year&year=2026&scope='+scope);
 const localReport=await telemetrySummary(f.env,U('local')),can=localReport.countries.find(r=>r.code==='CAN');
 assert.equal(can.topArtist,'Sum 41');assert.equal(can.topArtistPlays,11);assert.equal(can.topAlbum,'Chuck');assert.equal(can.topAlbumPlays,6);assert.equal(can.plays,21);
 assert.equal(localReport.countries.find(r=>r.code==='BRA').topAlbum,'Roots');assert.equal(localReport.unknownCountryPlays,4);
 assert.equal(localReport.decades.find(r=>r.decade===1990).topAlbum,'Roots');assert.equal(localReport.decades.find(r=>r.decade===1950).topAlbum,'Early');assert.equal(localReport.decades.find(r=>r.decade===1950).topAlbumPlays,6);
 const hive=await telemetrySummary(f.env,U('hive'));assert.equal(hive.countries.find(r=>r.code==='CAN').topArtist,'Foreign artist');assert.equal(hive.decades.find(r=>r.decade===2020).topAlbum,'Foreign album');
 assert.equal((await telemetrySummary(f.env,U('hive'))).generatedAt,hive.generatedAt);
 const all=new URL('https://wasp.test/api/telemetry?period=all&scope=hive');const a=await telemetrySummary(f.env,all);await new Promise(r=>setTimeout(r,3));assert.equal((await telemetrySummary(f.env,all)).generatedAt,a.generatedAt);
});

test('v18 anonymous routing demand counts only live sessions, groups by origin, exposes no account or session identifiers',async()=>{
 const f=await setup();const q=f.sql.prepare('INSERT INTO active_streams(session_id,origin,track_id,started_at,expires_at) VALUES(?,?,?,?,?)');const future=Date.now()+60000;
 q.run(crypto.randomUUID(),'','local1',Date.now(),future);q.run(crypto.randomUUID(),urlA,'remote1',Date.now(),future);q.run(crypto.randomUUID(),urlA,'remote2',Date.now(),future);q.run(crypto.randomUUID(),urlB,'expired',Date.now(),Date.now()-1);
 const r=await f.api('/api/active-streams?routing=1');assert.equal(r.status,200);assert.equal(r.body.sources.find(x=>x.origin===urlA).listeners,2);assert.equal(r.body.sources.find(x=>!x.origin).listeners,1);assert.ok(!r.body.sources.some(x=>x.origin===urlB));assert.ok(!JSON.stringify(r.body).includes('session_id'));
 assert.equal((await f.api('/api/active-streams?routing=1')).body.observed_at,r.body.observed_at);
});

test('v18 manual telemetry pull imports permitted peers and reports actual deduplication and upstream failures',async()=>{
 const f=await setup(),token=await login(f),a=await setup(),b=await setup();
 const hit=Date.now()-10000;
 await recordTelemetryListen(a.env,{id:crypto.randomUUID(),title:'Peer listen',artist:'Band',album:'Album',played_at:hit});
 addPeer(f,urlA);addPeer(f,urlB);addPeer(f,'https://unavailable.example');
 addPeer(b,urlA);
 const {telemetryFeed,syncTelemetryPeers}=await import('../src/telemetry.js');
 const orig=globalThis.fetch;
 const fake=async input=>{const u=new URL(input);if(u.hostname==='unavailable.example')throw Error('Fixture upstream unavailable');const env=u.hostname==='a.example'?a.env:b.env;
   if(u.pathname==='/api/peer')return Response.json({ok:true});if(u.pathname==='/api/telemetry/feed')return telemetryFeed(env,u);if(u.pathname==='/api/hive/requests/feed')return hiveRequestFeed(env,u);return new Response('Not found',{status:404});};
 await syncTelemetryPeers(b.env,{fetcher:fake,force:true});
 globalThis.fetch=fake;
 try{
  const go=async()=>{const r=await f.api('/api/admin/crons/run','POST',{kind:'telemetry'},token);assert.equal(r.status,202);await Promise.all(f.tasks.splice(0));return (await f.api('/api/admin/crons/run-status?id='+r.body.runId,'GET',undefined,token)).body;};
  assert.equal((await f.api('/api/admin/crons/run','POST',{kind:'telemetry'})).status,403);
  const first=await go();assert.equal(first.state,'complete');assert.equal(first.result.imported,1);assert.equal(first.result.checked,2);assert.equal(first.result.totalPeers,3);assert.equal(first.result.errors,1);assert.match(first.message,/1 new events; 2 peer feeds read of 3 eligible; 1 errors/);
  const again=await go();assert.equal(again.result.imported,0);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get().n,1);
 }finally{globalThis.fetch=orig;}
});
