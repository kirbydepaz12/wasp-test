import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
let workerCount=0;
import {ensureMetadataSchema,metadataScanControl,runMetadata,metadataAdmin,metadataFeed} from '../src/hive-metadata.js';
import {ensureHiveRequests,publishHiveRequest,hiveRequestFeed,syncHiveRequests,hiveRequestsForDisplay,dismissHiveRequests} from '../src/hive-requests.js';
import {ensureTelemetrySchema,recordTelemetryListen,telemetrySummary} from '../src/telemetry.js';
async function fixture(){
 const {default:worker}=await import('../src/index.js?fixture='+(++workerCount));
 const sql=new DatabaseSync(':memory:');
 class Q{constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ss=>{sql.exec('BEGIN');try{const r=[];for(const s of ss){if(DB.fail?.(s)){DB.fail=null;throw Error('simulated interrupted batch');}r.push({meta:{changes:sql.prepare(s.s).run(...s.a).changes}});}sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 const io={put:0,delete:0};const env={DB,MUSIC:{get:async()=>null,put:async()=>{io.put++},delete:async()=>{io.delete++},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const tasks=[],ctx={waitUntil(p){tasks.push(p)}};
 const api=async(path,method='GET',body,token,headers={})=>{const r=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{}),...(token?{cookie:'sid='+token}:{})},body:body?JSON.stringify(body):undefined}),env,ctx);return {status:r.status,body:await r.json()}};
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
const settings=(f,key,value)=>f.sql.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,String(value));
const summary=(f,query='period=all&scope=local')=>telemetrySummary(f.env,new URL('https://wasp.test/api/telemetry?'+query));
const mbid='11111111-1111-4111-8111-111111111111';
test('v18.0.2 atomic listen recording: retry ID is idempotent, repeat ID is new, failed transaction can retry',async()=>{
 const f=await setup();track(f,'song','Song');const id=crypto.randomUUID(),headers={'X-WASP-Play-Id':id};
 f.env.DB.fail=s=>s.s.includes('INSERT OR IGNORE INTO telemetry_events');assert.equal((await f.api('/api/play/song','POST',undefined,undefined,headers)).status,500);
 assert.equal(f.sql.prepare("SELECT plays FROM tracks WHERE id='song'").get().plays,0);
 for(let i=0;i<3;i++)assert.equal((await f.api('/api/play/song','POST',undefined,undefined,headers)).status,200);
 assert.equal((await f.api('/api/play/song','POST',undefined,undefined,{'X-WASP-Play-Id':crypto.randomUUID()})).status,200);
 assert.equal(f.sql.prepare("SELECT plays FROM tracks WHERE id='song'").get().plays,2);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM telemetry_events').get().n,2);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM recent_listens').get().n,2);
});
test('v18.0.2 full-year filter ignores stale month; Docker reports faster refresh cadence',async()=>{
 const f=await setup();f.env.WASP_RUNTIME='docker';const add=f.sql.prepare('INSERT INTO telemetry_events(origin_id,event_id,played_at,title,artist,album,release_year) VALUES(?,?,?,?,?,?,?)');
 for(const m of [0,10])add.run(originId(f),crypto.randomUUID(),Date.UTC(2026,m,15),'Song','Band','Album',2003);
 const y=await summary(f,'period=year&year=2026&month=11&scope=local');assert.equal(y.plays,2);assert.equal(y.decades[0].plays,2);assert.equal(y.refreshMs,60000);
 assert.equal((await summary(f,'period=month&year=2026&month=11&scope=local')).plays,1);
});
test('v18.0.2 Docker continuous scanner persists pause/resume, respects rate limit and enriches hundreds of plays',async()=>{
 const f=await setup();f.env.WASP_RUNTIME='docker';await ensureMetadataSchema(f.env);settings(f,'hive_metadata_config',JSON.stringify({contact:'admin@example.invalid',musicbrainz:true,lastfm:false,wikidata:false,enabled:false}));
 const add=f.sql.prepare('INSERT INTO telemetry_events(origin_id,event_id,played_at,title,artist,album) VALUES(?,?,?,?,?,?)');for(let i=0;i<300;i++)add.run(originId(f),crypto.randomUUID(),Date.now()-1000,'Song','Band','Album');
 const started=await metadataScanControl(f.env,'start');assert.equal(started.state,'running');assert.equal((await metadataScanControl(f.env,'pause')).state,'paused');assert.equal((await runMetadata(f.env,{continuous:true,fetcher:async()=>{throw Error('Must stay paused')}})).disabled,true);assert.equal((await metadataScanControl(f.env,'start')).id,started.id);
 await runMetadata(f.env,{continuous:true,fetcher:async()=>new Response('',{status:429,headers:{'Retry-After':'120'}})});let state=JSON.parse(f.sql.prepare("SELECT value FROM settings WHERE key='hive_metadata_scan_v182'").get().value);assert.ok(state.retryAt>Date.now()+60000);assert.equal((await runMetadata(f.env,{continuous:true,fetcher:async()=>{throw Error('No lookup during cooldown')}})).skipped,true);settings(f,'hive_metadata_scan_v182',JSON.stringify({...state,retryAt:0}));
 const fetcher=async input=>{const u=new URL(input);return Response.json(u.pathname.includes('/artist/')?{artists:[{id:mbid,score:100,name:'Band',country:'PH',tags:[{name:'rock'}]}]}:u.pathname.includes('/release-group/')?{'release-groups':[{id:mbid,score:100,title:'Album','artist-credit':[{name:'Band'}],'first-release-date':'2003-04-01'}]}:{recordings:[{id:mbid,score:100,title:'Song','artist-credit':[{name:'Band'}],releases:[{title:'Album'}],tags:[{name:'rock'}],'first-release-date':'2003-04-01'}]});};
 for(let i=0;i<8;i++){await runMetadata(f.env,{continuous:true,fetcher});state=JSON.parse(f.sql.prepare("SELECT value FROM settings WHERE key='hive_metadata_scan_v182'").get().value);if(state.state==='complete')break;}
 assert.equal(state.state,'complete');assert.equal(state.id,started.id);assert.equal(state.remaining,0);assert.equal(state.discovered,300);const d=await summary(f);assert.equal(d.plays,300);assert.equal(d.yearMetadataPlays,300);assert.equal(d.unknownCountryPlays,0);
 const cloud=await setup();assert.match((await metadataScanControl(cloud.env,'start')).error,/Docker only/);
});
test('v18.0.2 cloud peer-only import prioritizes Docker, paginates 25 verified facts, no external provider lookups',async()=>{
 const docker=await setup(),cloud=await setup();docker.env.WASP_RUNTIME='docker';await ensureMetadataSchema(docker.env);await ensureMetadataSchema(cloud.env);addPeer(cloud,urlB);addPeer(cloud,urlA);
 const sql=docker.sql.prepare("INSERT INTO hive_metadata(artist,title,album,field,value,provider,reference,verified_at,local_verified) VALUES(?,'',?,'release_year','2003','musicbrainz',?,1,1)");for(let i=0;i<25;i++)sql.run('band','album '+i,'https://musicbrainz.org/release-group/'+mbid);
 settings(cloud,'hive_metadata_config',JSON.stringify({trustPeers:true,enabled:false,preferredPeer:urlA}));const calls=[];const fetcher=async input=>{const u=new URL(input);calls.push(u.href);assert.equal(u.origin,urlA);return metadataFeed(docker.env,u);};
 for(const n of [20,5,0])assert.equal((await runMetadata(cloud.env,{force:true,pullOnly:true,fetcher})).imported,n);
 assert.equal(calls.length,3);assert.equal(cloud.sql.prepare('SELECT COUNT(*) n FROM hive_metadata').get().n,25);assert.equal((await(await metadataFeed(cloud.env,new URL('https://cloud.example/api/telemetry/metadata/feed'))).json()).entries.length,0);
});
test('v18.0.2 three-node request completion survives interrupted batch, retry and legacy state repair',async()=>{
 const a=await setup(),b=await setup(),c=await setup();addPeer(b,urlA);addPeer(c,urlB);const r=request('Peer upload');insertOwn(a,r);await publishHiveRequest(a.env,r);const fetcher=async input=>{const u=new URL(input);return hiveRequestFeed(u.hostname==='a.example'?a.env:b.env,u);};
 await syncHiveRequests(b.env,{force:true,fetcher});await syncHiveRequests(c.env,{force:true,fetcher});assert.equal((await c.api('/api/requests')).body.length,1);const prior=c.sql.prepare('SELECT cursor FROM hive_request_peer_cursors WHERE url=?').get(urlB).cursor;
 track(b,'new-track','Peer upload');seedPeer(a,'peer-b',urlB,[{id:'new-track',title:'Peer upload',artist:'Band',album:'Album'}]);const done=await a.api(review,'POST',{action:'refresh',ids:[r.id],cached_only:true},await login(a));assert.equal(done.body.results[0].status,'done');await syncHiveRequests(b.env,{force:true,fetcher});
 c.env.DB.fail=s=>s.s.includes('INSERT INTO hive_request_state');const failed=await syncHiveRequests(c.env,{force:true,fetcher});assert.equal(failed.errors,1);assert.equal(c.sql.prepare('SELECT cursor FROM hive_request_peer_cursors WHERE url=?').get(urlB).cursor,prior);assert.equal((await c.api('/api/requests')).body.length,1);
 await syncHiveRequests(c.env,{force:true,fetcher});assert.equal((await c.api('/api/requests')).body.length,0);assert.equal((await c.api('/api/requests/history')).body.length,1);
 c.sql.exec('DELETE FROM hive_request_state');settings(c,'hive_request_repair_v182','0');await syncHiveRequests(c.env,{force:true,fetcher});assert.equal((await c.api('/api/requests/history')).body.length,1);
});
test('v18.0.2 initialization does not wait on a different request’s stalled database promise',async()=>{
 const f=await setup();await ensureMetadataSchema(f.env);
 for(const [ensure,match] of [[ensureTelemetrySchema,'wasp_telemetry_schema'],[ensureHiveRequests,'hive_request_schema'],[ensureMetadataSchema,'SELECT value FROM settings WHERE key=?']]){
  let release,entered;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);let blocked=false;
  const db={...f.env.DB,prepare(s){const q=f.env.DB.prepare(s);if(!blocked&&s.includes(match)){blocked=true;const first=q.first.bind(q),wrap=async()=>{entered();await held;return first();};if(s.includes('key=?')){const bind=q.bind.bind(q);q.bind=(...args)=>{const bound=bind(...args),actual=bound.first.bind(bound);bound.first=async()=>{entered();await held;return actual();};return bound;};}else q.first=wrap;}return q;}};
  const env={...f.env,DB:db};const a=ensure(env);await started;let timer;try{const b=ensure(env);await Promise.race([b,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Second request blocked by first')),500))]);}finally{clearTimeout(timer);release();await a;}
 }
});
