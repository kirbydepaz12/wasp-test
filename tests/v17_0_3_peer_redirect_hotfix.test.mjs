import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {requireNoRedirect} from '../src/peer-fetch.js';
import {ensureTelemetrySchema,recordTelemetryListen,telemetryFeed,syncTelemetryPeers} from '../src/telemetry.js';
import {ensureHiveRequests,publishHiveRequest,hiveRequestFeed,syncHiveRequests} from '../src/hive-requests.js';

function fixture(){
  const sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE recent_listens(id TEXT PRIMARY KEY,track_id TEXT NOT NULL DEFAULT '',origin TEXT NOT NULL DEFAULT '',remote_id TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',artist TEXT NOT NULL DEFAULT '',album TEXT NOT NULL DEFAULT '',cover_url TEXT NOT NULL DEFAULT '',played_at INTEGER NOT NULL);
    CREATE TABLE artist_info(name TEXT PRIMARY KEY,genres TEXT);
    CREATE TABLE peers(id TEXT PRIMARY KEY,url TEXT,added_at INTEGER);
    CREATE TABLE user_peer_permissions(user_id TEXT PRIMARY KEY,enabled INTEGER);
    CREATE TABLE user_published_peers(user_id TEXT,url TEXT,last_ok INTEGER,last_error TEXT,created_at INTEGER);
    CREATE TABLE requests(id TEXT PRIMARY KEY,kind TEXT,title TEXT,artist TEXT,album TEXT,image TEXT,url TEXT,created_at INTEGER,done_at INTEGER,status TEXT DEFAULT 'active',meta TEXT);`);
  class St {
    constructor(q,args=[]){this.q=q;this.args=args;}
    bind(...args){return new St(this.q,args);}
    async first(){return sql.prepare(this.q).get(...this.args)||null;}
    async all(){return {results:sql.prepare(this.q).all(...this.args)};}
    async run(){const r=sql.prepare(this.q).run(...this.args);return {meta:{changes:r.changes}};}
  }
  const DB={prepare:q=>new St(q),batch:async statements=>{
    sql.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sql.exec('COMMIT');return out;}
    catch(e){sql.exec('ROLLBACK');throw e;}
  }};
  return {sql,env:{DB}};
}
function wranglerCompatible(upstream){
  return async (input,options={})=>{
    if(options.redirect==='error')throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    assert.equal(options.redirect,'manual','all peer requests must explicitly disable redirect following');
    return upstream(new URL(input),options);
  };
}

test('Wrangler-compatible manual redirects are accepted only for nonredirect responses',()=>{
  assert.equal(requireNoRedirect(new Response('ok')).status,200);
  for(const status of [301,302,307,308])assert.throws(()=>requireNoRedirect(
    new Response(null,{status,headers:{Location:'http://127.0.0.1/secrets'}})),/Upstream redirect refused/);
  assert.throws(()=>requireNoRedirect({type:'opaqueredirect',status:0}),/Upstream redirect refused/);
  assert.throws(()=>requireNoRedirect({status:200,redirected:true}),/Upstream redirect refused/);
});

test('telemetry sync works with Wrangler redirect rules, saves cursor and imports once',async()=>{
  const source=fixture(),target=fixture();
  await ensureTelemetrySchema(source.env);await ensureTelemetrySchema(target.env);
  source.sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
  target.sql.prepare('INSERT INTO peers VALUES(?,?,?)').run('source','http://100.102.242.55:8081',1);
  await recordTelemetryListen(source.env,{id:crypto.randomUUID(),title:'Kundiman',artist:'Silent Sanctuary',genre:'alternative rock',played_at:Date.now()-60000});
  const fetcher=wranglerCompatible(async u=>u.pathname==='/api/peer'?Response.json({ok:true}):telemetryFeed(source.env,u));
  const first=await syncTelemetryPeers(target.env,{fetcher,force:true});
  assert.equal(first.errors,0);assert.equal(first.checked,1);assert.equal(first.imported,1);
  const state=target.sql.prepare('SELECT cursor,synced_at,last_error FROM telemetry_peer_cursors').get();
  assert.ok(state.cursor>0);assert.ok(state.synced_at>0);assert.equal(state.last_error,'');
  assert.equal((await syncTelemetryPeers(target.env,{fetcher,force:true})).imported,0);
  assert.equal(target.sql.prepare('SELECT COUNT(*) n FROM telemetry_events').get().n,1);
});

test('a redirect from either telemetry endpoint never advances cursor and records an actionable error',async()=>{
  for(const redirectAt of ['/api/peer','/api/telemetry/feed']){
    const target=fixture();await ensureTelemetrySchema(target.env);
    target.sql.prepare('INSERT INTO peers VALUES(?,?,?)').run('source','http://100.102.242.55:8081',1);
    const fetcher=wranglerCompatible(async u=>u.pathname===redirectAt?
      new Response(null,{status:302,headers:{Location:'http://127.0.0.1/secrets'}}):
      u.pathname==='/api/peer'?Response.json({ok:true}):Response.json({ok:true,protocol:1,nodeId:crypto.randomUUID(),cursor:0,events:[]}));
    const outcome=await syncTelemetryPeers(target.env,{fetcher,force:true});
    assert.equal(outcome.errors,1);
    const record=target.sql.prepare('SELECT cursor,synced_at,last_error FROM telemetry_peer_cursors').get();
    assert.equal(record.cursor,0);assert.equal(record.synced_at,0);
    assert.match(record.last_error,/Upstream redirect refused/);
  }
});

test('HIVE request exchange obeys Wrangler redirect rules and refuses redirected feeds',async()=>{
  const source=fixture(),receiver=fixture();
  await ensureHiveRequests(source.env);await ensureHiveRequests(receiver.env);
  source.sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
  receiver.sql.prepare('INSERT INTO peers VALUES(?,?,?)').run('source','http://100.102.242.55:8081',1);
  await publishHiveRequest(source.env,{id:crypto.randomUUID(),kind:'song',title:'Peer request',artist:'Band',created_at:Date.now()});
  const fetcher=wranglerCompatible(u=>hiveRequestFeed(source.env,u));
  const first=await syncHiveRequests(receiver.env,{fetcher,force:true});
  assert.equal(first.errors,0);assert.equal(first.imported,1);
  assert.ok(receiver.sql.prepare('SELECT cursor FROM hive_request_peer_cursors').get().cursor>0);
  const redirect=wranglerCompatible(async()=>new Response(null,{status:307,headers:{Location:'https://untrusted.example/'}}));
  const result=await syncHiveRequests(receiver.env,{fetcher:redirect,force:true});
  assert.equal(result.errors,1);
  assert.match(receiver.sql.prepare('SELECT last_error FROM hive_request_peer_cursors').get().last_error,/redirect refused/);
});

test('all source modules are free of unsupported redirect error mode',()=>{
  for(const module of ['telemetry','hive-requests','index','mobile-bridge']){
    const code=readFileSync(new URL('../src/'+module+'.js',import.meta.url),'utf8');
    assert.doesNotMatch(code,/redirect\s*:\s*['"]error['"]/);
  }
});
