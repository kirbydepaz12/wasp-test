import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureTelemetrySchema,recordTelemetryListen,telemetryFeed,telemetrySummary,syncTelemetryPeers} from '../src/telemetry.js';

function makeEnv(){
  const sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE artist_info(name TEXT PRIMARY KEY, genres TEXT);
    CREATE TABLE recent_listens(id TEXT PRIMARY KEY,track_id TEXT NOT NULL,origin TEXT NOT NULL DEFAULT '',remote_id TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',artist TEXT NOT NULL DEFAULT '',album TEXT NOT NULL DEFAULT '',cover_url TEXT NOT NULL DEFAULT '',played_at INTEGER NOT NULL);
    CREATE TABLE peers(id TEXT PRIMARY KEY,url TEXT,name TEXT,added_at INTEGER);
    CREATE TABLE user_peer_permissions(user_id TEXT PRIMARY KEY,enabled INTEGER);
    CREATE TABLE user_published_peers(user_id TEXT,url TEXT,last_ok INTEGER,last_error TEXT,created_at INTEGER);`);
  class Statement {
    constructor(statement,args=[]){this.statement=statement;this.args=args;}
    bind(...args){return new Statement(this.statement,args);}
    async first(){return sql.prepare(this.statement).get(...this.args)||null;}
    async all(){return {results:sql.prepare(this.statement).all(...this.args)};}
    async run(){const x=sql.prepare(this.statement).run(...this.args);return {meta:{changes:x.changes}};}
  }
  const db={prepare:s=>new Statement(s),batch:async queries=>{
    sql.exec('BEGIN');try{const results=[];for(const q of queries)results.push(await q.run());sql.exec('COMMIT');return results;}
    catch(e){sql.exec('ROLLBACK');throw e;}
  }};
  return {sql,env:{DB:db}};
}
const stamp=Date.UTC(2026,10,16,13,15);

test('v17 migrates only available historical listens and caches accurate summaries',async()=>{
  const {sql,env}=makeEnv();
  sql.prepare('INSERT INTO recent_listens (id,track_id,title,artist,album,played_at) VALUES (?,?,?,?,?,?)')
    .run('play-0001','song-1','First Song','Band','Album',stamp);
  await ensureTelemetrySchema(env);await ensureTelemetrySchema(env);
  assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM telemetry_events').get().count,1);
  await recordTelemetryListen(env,{id:'play-0002',title:'Second Song',artist:'Band',album:'Album',played_at:stamp,duration:200});
  await recordTelemetryListen(env,{id:'play-0002',title:'Second Song',artist:'Band',album:'Album',played_at:stamp,duration:200});
  const url=new URL('https://wasp.example/api/telemetry?period=month&year=2026&month=11&offset=480&scope=local');
  const report=await telemetrySummary(env,url);
  assert.equal(report.plays,2);assert.equal(report.artists,1);assert.equal(report.tracks,2);
  assert.equal(report.topArtists[0].plays,2);
  const before=sql.prepare('SELECT COUNT(*) AS n FROM telemetry_summary_cache').get().n;
  await telemetrySummary(env,url);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM telemetry_summary_cache').get().n,before);
});

test('v17 feed is public only if network sharing is enabled; never carries users',async()=>{
  const {sql,env}=makeEnv();await ensureTelemetrySchema(env);
  await recordTelemetryListen(env,{title:'Anonymous music',artist:'Band',played_at:stamp});
  const feed=new URL('https://wasp.example/api/telemetry/feed?cursor=0');
  assert.equal((await telemetryFeed(env,feed)).status,403);
  sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
  const response=await telemetryFeed(env,feed);assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.events.length,1);
  assert.equal(body.events[0].title,'Anonymous music');
  assert.ok(!JSON.stringify(body).includes('user_id'));
  assert.ok(!JSON.stringify(body).includes('credential'));
});

test('v17 sync imports origin IDs once even over multiple paths, and catches up incrementally',async()=>{
  const {sql,env}=makeEnv();await ensureTelemetrySchema(env);
  sql.prepare('INSERT INTO peers(id,url,added_at) VALUES(?,?,?)').run('one','https://alpha.example',1);
  sql.prepare('INSERT INTO peers(id,url,added_at) VALUES(?,?,?)').run('two','https://beta.example',2);
  const sourceId='11111111-1111-4111-8111-111111111111';
  const event={seq:1,origin_id:sourceId,event_id:'22222222-2222-4222-8222-222222222222',played_at:stamp,
    track_id:'song-peer',title:'Remote song',artist:'Peer artist',album:'Peer album',duration:0};
  const requests=[];
  const fetcher=async input=>{
    const u=new URL(input);requests.push(u.pathname);
    if(u.pathname==='/api/peer')return Response.json({ok:true});
    if(u.pathname==='/api/telemetry/feed')return Response.json({ok:true,protocol:1,nodeId:
      u.hostname==='alpha.example'?'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa':'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',cursor:1,events:[event]});
    return new Response('404',{status:404});
  };
  const first=await syncTelemetryPeers(env,{fetcher,force:true});assert.equal(first.imported,1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get().n,1);
  const second=await syncTelemetryPeers(env,{fetcher,force:true});assert.equal(second.imported,0);
  const data=await telemetrySummary(env,new URL('https://wasp.example/api/telemetry?period=year&year=2026&scope=hive'));
  assert.equal(data.plays,1);assert.equal(data.nodes,1);
  assert.ok(requests.includes('/api/telemetry/feed'));
});

test('v17 rotates bounded sync batches across all connected admin peers',async()=>{
  const {sql,env}=makeEnv();await ensureTelemetrySchema(env);
  for(let i=0;i<23;i++)sql.prepare('INSERT INTO peers(id,url,added_at) VALUES(?,?,?)').run('peer'+i,'https://peer'+i+'.example',i);
  const seen=new Set();
  const fetcher=async input=>{
    const url=new URL(input);
    if(url.pathname==='/api/peer'){seen.add(url.hostname);return Response.json({ok:true});}
    return Response.json({ok:true,protocol:1,nodeId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',cursor:0,events:[]});
  };
  for(let tick=0;tick<3;tick++)await syncTelemetryPeers(env,{fetcher,force:true});
  assert.equal(seen.size,23,'all registered peers must be visited by the third bounded sync cycle');
});
