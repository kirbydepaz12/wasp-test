import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureHiveRequests,publishHiveRequest,hiveRequestFeed,syncHiveRequests,hiveRequestsForDisplay} from '../src/hive-requests.js';
import {ensureTelemetrySchema,recordTelemetryListen,telemetryFeed,syncTelemetryPeers} from '../src/telemetry.js';
function fixture(){
  const sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE recent_listens(id TEXT PRIMARY KEY,track_id TEXT NOT NULL DEFAULT '',origin TEXT NOT NULL DEFAULT '',remote_id TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',artist TEXT NOT NULL DEFAULT '',album TEXT NOT NULL DEFAULT '',cover_url TEXT NOT NULL DEFAULT '',played_at INTEGER NOT NULL);
    CREATE TABLE artist_info(name TEXT PRIMARY KEY,genres TEXT);
    CREATE TABLE peers(id TEXT PRIMARY KEY,url TEXT,added_at INTEGER);
    CREATE TABLE user_peer_permissions(user_id TEXT PRIMARY KEY,enabled INTEGER);
    CREATE TABLE user_published_peers(user_id TEXT,url TEXT,last_ok INTEGER,last_error TEXT,created_at INTEGER);
    CREATE TABLE requests(id TEXT PRIMARY KEY,kind TEXT,title TEXT,artist TEXT,album TEXT,image TEXT,url TEXT,created_at INTEGER,done_at INTEGER,status TEXT DEFAULT 'active',meta TEXT);
  `);
  class St{constructor(query,args=[]){this.query=query;this.args=args}bind(...a){return new St(this.query,a)}async first(){return sql.prepare(this.query).get(...this.args)||null}async all(){return {results:sql.prepare(this.query).all(...this.args)}}async run(){const x=sql.prepare(this.query).run(...this.args);return {meta:{changes:x.changes}}}}
  const DB={prepare:s=>new St(s),batch:async ss=>{sql.exec('BEGIN');try{const out=[];for(const s of ss)out.push(await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
  return {sql,env:{DB}};
}
const requestRow=(title='Track')=>({id:crypto.randomUUID(),kind:'song',title,artist:'Band',created_at:Date.now(),meta:null});
test('new installs get stable HIVE origin identity and never export unshared requests',async()=>{
  const {sql,env}=fixture();await ensureHiveRequests(env);
  const origin=sql.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").get()?.value;
  assert.match(origin,/^[a-f0-9-]{36}$/);
  const ev=await publishHiveRequest(env,requestRow());assert.equal(ev.origin_id,origin);
  const url=new URL('https://wasp.example/api/hive/requests/feed');
  assert.equal((await hiveRequestFeed(env,url)).status,403);
  sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
  const response=await hiveRequestFeed(env,url);assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.events.length,1);
  assert.ok(!JSON.stringify(body).includes('user_id'));
});
test('request federation relays through multiple peers without duplication or local ownership takeover',async()=>{
  const A=fixture(),B=fixture(),C=fixture();
  await Promise.all([ensureHiveRequests(A.env),ensureHiveRequests(B.env),ensureHiveRequests(C.env)]);
  A.sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
  B.sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
  C.sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
  const entry=requestRow('Another Track'); await publishHiveRequest(A.env,entry);
  B.sql.prepare('INSERT INTO peers VALUES(?,?,?)').run('a','https://a.example',1);
  C.sql.prepare('INSERT INTO peers VALUES(?,?,?)').run('a','https://a.example',1);
  C.sql.prepare('INSERT INTO peers VALUES(?,?,?)').run('b','https://b.example',2);
  const fetcher=async request=>{
    const u=new URL(request);return hiveRequestFeed(u.hostname==='a.example'?A.env:B.env,u);
  };
  assert.equal((await syncHiveRequests(B.env,{fetcher,force:true})).imported,1);
  assert.equal((await syncHiveRequests(C.env,{fetcher,force:true})).imported,1);
  assert.equal(C.sql.prepare('SELECT COUNT(*) AS n FROM hive_request_events').get().n,1);
  const remote=await hiveRequestsForDisplay(C.env);assert.equal(remote.length,1);
  assert.equal(remote[0].title,'Another Track');assert.equal(remote[0].read_only,true);
  assert.equal(C.sql.prepare('SELECT COUNT(*) AS n FROM requests').get().n,0);
});
test('disabling telemetry export still allows pulling from connected peers',async()=>{
  const source=fixture(),receiver=fixture();
  await ensureTelemetrySchema(source.env);await ensureTelemetrySchema(receiver.env);
  source.sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
  receiver.sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
  receiver.sql.prepare("INSERT INTO settings(key,value) VALUES('telemetry_share_enabled','0')").run();
  receiver.sql.prepare('INSERT INTO peers VALUES(?,?,?)').run('remote','https://a.example',1);
  await recordTelemetryListen(source.env,{title:'Peer track',artist:'Band',played_at:Date.now()});
  const fetcher=async request=>{const u=new URL(request);if(u.pathname==='/api/peer')return Response.json({ok:true});return telemetryFeed(source.env,u)};
  const imported=await syncTelemetryPeers(receiver.env,{fetcher,force:true});assert.equal(imported.imported,1);
  assert.equal((await telemetryFeed(receiver.env,new URL('https://wasp.example/api/telemetry/feed'))).status,403);
});
