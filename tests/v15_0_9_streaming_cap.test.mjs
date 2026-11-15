// WASP 15.0.9 — 30 most recently started songs, never cap listener totals.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
const sqlite=new DatabaseSync(':memory:');
class Q {
  constructor(sql,params=[]){this.sql=sql;this.params=params;}
  bind(...params){return new Q(this.sql,params);}
  async run(){const r=sqlite.prepare(this.sql).run(...this.params);return {meta:{changes:r.changes}};}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.params)};}
  async first(){return sqlite.prepare(this.sql).get(...this.params)||null;}
}
const env={DB:{prepare:s=>new Q(s),batch:async ss=>Promise.all(ss.map(s=>s.run()))},MUSIC:{get:async()=>null},ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
async function request(url,method='GET',body){
  const res=await worker.fetch(new Request('https://wasp.test'+url,{method,
    headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),env,{});
  return {status:res.status,json:await res.json(),headers:res.headers};
}
assert.equal((await request('/api/tracks')).status,200);
assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='wasp_live_streams_schema'").get().value,'2');
assert.ok(sqlite.prepare('PRAGMA table_info(active_streams)').all().some(x=>x.name==='started_at'));
assert.deepEqual((await request('/api/active-streams?summary=1')).json,{listener_count:0,tracks:[],keys:[]});
const now=Date.now();
const insert=sqlite.prepare('INSERT INTO active_streams(session_id,origin,track_id,expires_at,started_at) VALUES(?,?,?,?,?)');
const uid=i=>`2a135e88-0000-4000-8000-${String(i).padStart(12,'0')}`;
for(let i=0;i<40;i++)insert.run(uid(i),'',`song${i}`,now+35000,now-100000+i*1000);
// Seven listeners on a song already in the top 30: they increase the count,
// but never occupy seven additional cards.
for(let i=40;i<47;i++)insert.run(uid(i),'','song39',now+35000,now+3000);
let summary=(await request('/api/active-streams?summary=1')).json;
assert.equal(summary.listener_count,47,'count all playback sessions past thirty');
assert.equal(summary.tracks.length,30,'never exceed thirty stream cards');
assert.equal(summary.keys.length,40,'history GIF lookup continues for older live songs');
assert.equal(summary.tracks[0].track_id,'song39','sort by start time, newest first');
assert.equal(summary.tracks[0].listeners,8,'duplicate active listeners dedupe to one song');
assert.equal(summary.tracks.at(-1).track_id,'song10','oldest 10 songs excluded');
assert.equal(summary.tracks.some(x=>x.track_id==='song0'),false);
assert.ok(!JSON.stringify(summary).includes(uid(0)),'API must not expose listener/session identifiers');
assert.equal((await request('/api/active-streams')).json.length,40,'legacy GET API remains compatible');
assert.equal((await request('/api/active-streams?summary=1')).headers.get('cache-control'),'no-store');
// A heartbeat for the same song must not make an older song appear newest.
sqlite.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('live1','Live','Singer','Album',now);
const session=uid(47);
assert.equal((await request('/api/active-streams','POST',{session_id:session,action:'playing',track_id:'live1'})).status,200);
const firstStart=sqlite.prepare('SELECT started_at FROM active_streams WHERE session_id=?').get(session).started_at;
assert.equal((await request('/api/active-streams','POST',{session_id:session,action:'playing',track_id:'live1'})).status,200);
assert.equal(sqlite.prepare('SELECT started_at FROM active_streams WHERE session_id=?').get(session).started_at,firstStart);
assert.equal((await request('/api/active-streams?summary=1')).json.listener_count,48);
assert.equal((await request('/api/active-streams','POST',{session_id:session,action:'stop'})).status,200);
assert.equal((await request('/api/active-streams?summary=1')).json.listener_count,47);
// The expiry filter governs both the list and the count.
sqlite.prepare("UPDATE active_streams SET expires_at=? WHERE track_id='song0'").run(now-100);
summary=(await request('/api/active-streams?summary=1')).json;
assert.equal(summary.listener_count,46);
assert.equal(summary.tracks.length,30);
assert.equal(summary.keys.length,39);
// Upgrade an actual v15.0.8-shaped table with live streams already present.
const prior=new DatabaseSync(':memory:');
prior.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  INSERT INTO settings(key,value) VALUES('wasp_schema_version','15.3'),('wasp_live_streams_schema','1');
  CREATE TABLE active_streams(session_id TEXT PRIMARY KEY,origin TEXT NOT NULL DEFAULT '',track_id TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
prior.prepare('INSERT INTO active_streams VALUES(?,?,?,?)').run('33333333-3333-4333-8333-333333333333','','prior-song',Date.now()+35000);
const oldEnv={...env,DB:{prepare:s=>new class {
  constructor(sql,params=[]){this.sql=sql;this.params=params;}
  bind(...params){return new this.constructor(this.sql,params);}
  async run(){const r=prior.prepare(this.sql).run(...this.params);return {meta:{changes:r.changes}};}
  async all(){return {results:prior.prepare(this.sql).all(...this.params)};}
  async first(){return prior.prepare(this.sql).get(...this.params)||null;}
}(s)}};
const distinctWorker=(await import('../src/index.js?legacy-migration-v15-0-9')).default;
const upgraded=await distinctWorker.fetch(new Request('https://wasp.test/api/active-streams?summary=1'),oldEnv,{});
assert.equal(upgraded.status,200);
assert.equal((await upgraded.json()).listener_count,1,'preserve pre-upgrade active sessions');
assert.equal(prior.prepare("SELECT value FROM settings WHERE key='wasp_live_streams_schema'").get().value,'2');
assert.ok(prior.prepare('PRAGMA table_info(active_streams)').all().some(x=>x.name==='started_at'));
assert.equal(prior.prepare('SELECT track_id FROM active_streams').get().track_id,'prior-song');
console.log('PASS v15.0.9: 30 newest titles, 47+ live listeners, full history statuses, privacy, expiry, heartbeat, legacy GET and additive v15.0.8 migration');
