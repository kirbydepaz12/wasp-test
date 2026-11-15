// WASP 15.0.7: per-track relative timestamps and anonymous live presence.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {allowedResource} from '../docker/peer-relay.mjs';

const sqlite=new DatabaseSync(':memory:');
class Q {
  constructor(sql,params=[]){this.sql=sql;this.params=params;}
  bind(...params){return new Q(this.sql,params);}
  async run(){const result=sqlite.prepare(this.sql).run(...this.params);return {meta:{changes:result.changes}};}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.params)};}
  async first(){return sqlite.prepare(this.sql).get(...this.params)||null;}
}
const env={DB:{prepare:sql=>new Q(sql),batch:async stmts=>Promise.all(stmts.map(x=>x.run()))},
  MUSIC:{get:async()=>null},ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
async function request(path,method='GET',body){
  const r=await worker.fetch(new Request('https://wasp.test'+path,{method,
    headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),env,{});
  return {status:r.status,headers:r.headers,json:await r.json().catch(()=>null)};
}
const id='7db13965-9d4b-498d-b6f8-acdcfc726141';
const secondId='fe0bb736-c45b-4fae-a3b7-c713cb20e30e';
assert.equal((await request('/api/tracks')).status,200,'existing Worker API works and migrates schema');
assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='wasp_schema_version'").get().value,'15.3','do not disturb existing schema marker');
assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='wasp_live_streams_schema'").get().value,'2');
sqlite.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('local1','First','Artist','Album',Date.now());
sqlite.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('local2','Second','Artist','Album',Date.now());
sqlite.prepare('INSERT INTO peers(id,url,name,added_at) VALUES(?,?,?,?)').run('peer','https://peer.test','Peer',Date.now());
assert.deepEqual((await request('/api/active-streams')).json,[]);
assert.equal(allowedResource('/api/active-streams'),true,'Docker peer relay must allow read-only live status');
assert.equal(allowedResource('/api/active-streams/anything'),false,'relay stays allowlisted');
assert.equal((await request('/api/active-streams','POST',{session_id:id,action:'playing',track_id:'missing'})).status,400);
assert.equal((await request('/api/active-streams','POST',{session_id:id,action:'playing',origin:'https://untrusted.test',track_id:'other'})).status,400);
assert.equal((await request('/api/active-streams','POST',{session_id:'123',action:'playing',track_id:'local1'})).status,400);
assert.equal((await request('/api/active-streams','POST',{session_id:id,action:'playing',track_id:'local1'})).status,200);
let active=await request('/api/active-streams');
assert.deepEqual(active.json,[{origin:'',track_id:'local1'}]);
assert.equal(active.headers.get('cache-control'),'no-store');
sqlite.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
assert.equal((await request('/api/active-streams')).headers.get('access-control-allow-origin'),'*','public read is available to sharing peers');
assert.ok(!JSON.stringify(active.json).includes(id),'no session or viewer details are exposed');
assert.equal((await request('/api/active-streams','POST',{session_id:secondId,action:'playing',track_id:'local1'})).status,200);
assert.deepEqual((await request('/api/active-streams')).json,[{origin:'',track_id:'local1'}],'no listener count or identity');
assert.equal((await request('/api/active-streams','POST',{session_id:id,action:'playing',origin:'https://peer.test',track_id:'peertrack'})).status,200);
active=await request('/api/active-streams');
assert.deepEqual(active.json,[{origin:'',track_id:'local1'},{origin:'https://peer.test',track_id:'peertrack'}]);
assert.equal((await request('/api/active-streams','POST',{session_id:id,action:'stop'})).status,200);
assert.deepEqual((await request('/api/active-streams')).json,[{origin:'',track_id:'local1'}],'stop only this tab');
assert.equal((await request('/api/active-streams','POST',{session_id:secondId,action:'stop'})).status,200);
assert.deepEqual((await request('/api/active-streams')).json,[]);
await request('/api/active-streams','POST',{session_id:id,action:'playing',track_id:'local2'});
sqlite.prepare('UPDATE active_streams SET expires_at=?').run(Date.now()-1000);
assert.deepEqual((await request('/api/active-streams')).json,[],'stale playback is never visible');
// A media GET must not register streaming: it can be a prefetch/range probe.
await request('/audio/local2');
assert.deepEqual((await request('/api/active-streams')).json,[]);
assert.equal((await request('/api/requests')).status,200,'Request remains publicly visible');
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const func=source.match(/function relativeListenTime\(playedAt,now=Date\.now\(\)\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(func);
const relativeTime=new Function(func+';return relativeListenTime;')();
const now=1_700_000_000_000;
assert.equal(relativeTime(now-5*60*1000,now),'5 mins ago');
assert.equal(relativeTime(now-30*60*1000,now),'30 mins ago');
assert.equal(relativeTime(now-45*1000,now),'Just now');
assert.equal(relativeTime(now-90*60*1000,now),'1 hr ago');
assert.equal(relativeTime(now-2*86400000,now),'2 days ago');
assert.ok(source.includes('src="/streaming.png"'));
assert.ok(source.includes("get('/api/active-streams?summary=1')"));
assert.ok(source.includes("audio.addEventListener('pause',()=>syncLiveStream())"));
console.log('PASS: relative timestamps, multi-tab anonymous live status, peer status, pause, expiry, privacy and public requests');
