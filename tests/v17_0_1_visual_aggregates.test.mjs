import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureTelemetrySchema,recordTelemetryListen,rememberTrackYear,telemetrySummary,telemetryFeed,syncTelemetryPeers} from '../src/telemetry.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE recent_listens(id TEXT PRIMARY KEY,track_id TEXT,title TEXT,artist TEXT,album TEXT,played_at INTEGER);
 CREATE TABLE artist_info(name TEXT PRIMARY KEY, genres TEXT);
 CREATE TABLE peers(id TEXT PRIMARY KEY,url TEXT,added_at INTEGER);
 CREATE TABLE user_peer_permissions(user_id TEXT,enabled INTEGER);
 CREATE TABLE user_published_peers(user_id TEXT,url TEXT,last_ok INTEGER,last_error TEXT,created_at INTEGER);`);
 class Statement{
  constructor(s,args=[]){this.s=s;this.args=args;}
  bind(...x){return new Statement(this.s,x);}
  async first(){return sql.prepare(this.s).get(...this.args)||null;}
  async all(){return {results:sql.prepare(this.s).all(...this.args)};}
  async run(){const r=sql.prepare(this.s).run(...this.args);return {meta:{changes:r.changes}};}
 }
 const DB={prepare:s=>new Statement(s),batch:async list=>{
  sql.exec('BEGIN');try{const out=[];for(const s of list)out.push(await s.run());sql.exec('COMMIT');return out;}
  catch(e){sql.exec('ROLLBACK');throw e;}}};
 return {sql,env:{DB}};
}
const stamp=Date.UTC(2026,10,16,14);
test('v17.0.1 migrates previous telemetry and adds optional fields without dropping events',async()=>{
 const {sql,env}=fixture();await ensureTelemetrySchema(env);
 sql.prepare("UPDATE settings SET value='17.1' WHERE key='wasp_telemetry_schema'").run();
 const id=sql.prepare("SELECT value FROM settings WHERE key='telemetry_instance_id'").get().value;
 sql.prepare("INSERT INTO telemetry_events(origin_id,event_id,played_at,title,artist) VALUES(?,?,?,?,?)").run(id,'play-1',stamp,'Song','Band');
 // This uses the existing v17 tables and simulates a staged additive schema upgrade.
 const rows=sql.prepare('SELECT * FROM telemetry_events').all();assert.equal(rows.length,1);
 await rememberTrackYear(env,'track-A',2003);
 assert.equal(sql.prepare('SELECT release_year FROM telemetry_track_metadata WHERE track_id=?').get('track-A').release_year,2003);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get().n,1);
});
test('v17.0.1 genre, decade and country totals come from provided metadata, never guesses',async()=>{
 const {sql,env}=fixture();await ensureTelemetrySchema(env);
 sql.prepare('INSERT INTO artist_info(name,genres) VALUES(?,?)').run('Slipknot','["metal","nu metal"]');
 await rememberTrackYear(env,'local-1',1999);
 await recordTelemetryListen(env,{id:'a-unique-play',track_id:'local-1',title:'Wait and Bleed',artist:'Slipknot',album:'Slipknot',played_at:stamp});
 await recordTelemetryListen(env,{id:'b-unique-play',track_id:'local-2',title:'Yen',artist:'Slipknot',album:'The End So Far',played_at:stamp,release_year:2022,country_code:'USA'});
 const report=await telemetrySummary(env,new URL('https://wasp.example/api/telemetry?period=year&year=2026&scope=local'));
 assert.equal(report.plays,2);
 assert.equal(report.topTags.find(x=>x.name==='metal').plays,2);
 assert.equal(report.decades.find(x=>x.decade===1990).plays,1);
 assert.equal(report.decades.find(x=>x.decade===2020).plays,1);
 assert.equal(report.countries.find(x=>x.code==='USA').plays,1);
 assert.equal(report.unknownCountryPlays,1);
 assert.equal(report.yearMetadataPlays,2);
});
test('v17.0.1 feed shares metadata with approved peers without track IDs or private identities',async()=>{
 const {sql,env}=fixture();await ensureTelemetrySchema(env);
 sql.prepare("INSERT INTO settings(key,value) VALUES('network_share','1')").run();
 sql.prepare('INSERT INTO artist_info(name,genres) VALUES(?,?)').run('Band','["rock"]');
 await rememberTrackYear(env,'local-1',2001);
 await recordTelemetryListen(env,{id:'record-001-unique',track_id:'local-1',title:'Song',artist:'Band',album:'Album',played_at:stamp});
 const j=await (await telemetryFeed(env,new URL('https://wasp.example/api/telemetry/feed?cursor=0'))).json();
 assert.equal(j.events[0].release_year,2001);
 assert.equal(j.events[0].genre,'rock');
 assert.equal(j.events[0].track_id,'');
 assert.ok(!JSON.stringify(j).includes('user_id'));
});
