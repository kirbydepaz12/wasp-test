import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {metadataAdmin,metadataFeed,runMetadata,lookupMusicbrainz,lookupLastfm,ensureMetadataSchema} from '../src/hive-metadata.js';
import {ensureTelemetrySchema,recordTelemetryListen,telemetrySummary,telemetryFeed} from '../src/telemetry.js';
const stamp=Date.now()-60000, artistId='11111111-1111-4111-8111-111111111111',recordingId='22222222-2222-4222-8222-222222222222';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE artist_info(name TEXT PRIMARY KEY,genres TEXT);CREATE TABLE tracks(id TEXT PRIMARY KEY,artist TEXT,title TEXT,album TEXT);CREATE TABLE recent_listens(id TEXT PRIMARY KEY,track_id TEXT,title TEXT,artist TEXT,album TEXT,played_at INTEGER);CREATE TABLE peers(id TEXT PRIMARY KEY,url TEXT,name TEXT,added_at INTEGER);`);
 class S{constructor(q,a=[]){this.q=q;this.a=a}bind(...a){return new S(this.q,a)}async first(){return sql.prepare(this.q).get(...this.a)||null}async all(){return{results:sql.prepare(this.q).all(...this.a)}}async run(){return{meta:{changes:sql.prepare(this.q).run(...this.a).changes}}}}
 const env={DB:{prepare:q=>new S(q),batch:async ss=>{sql.exec('BEGIN');try{const out=[];for(const s of ss)out.push(await s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e}}},METADATA_SETTINGS_KEY:'example-test-installation-key-with-length'};
 const set=(k,v)=>sql.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k,String(v));
 const reset=()=>set('hive_metadata_next',0);
 const admin=(method,body,action='',options={})=>{const u=new URL('https://example.invalid/api/admin/telemetry/metadata'+action);return metadataAdmin(new Request(u,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})}),env,u,options)};
 return {sql,env,set,reset,admin};
}
const record={id:'sample-listen-unique',artist:'Sample Band',title:'Sample Song',album:'Sample Record',played_at:stamp};
const mbArtist={id:artistId,score:100,name:'Sample Band',country:'PH',tags:[{name:'rock'}]};
const mbTrack={id:recordingId,score:100,title:'Sample Song','artist-credit':[{name:'Sample Band'}],releases:[{title:'Sample Record'}],'first-release-date':'2003-04-01',tags:[{name:'rock'}]};
const lastfm=(artist=true)=>artist?{artist:{name:'Sample Band',url:'https://www.last.fm/music/Sample+Band',tags:{tag:[{name:'alternative rock'}]}}}:{track:{name:'Sample Song',artist:{name:'Sample Band'},album:{title:'Sample Record'},url:'https://www.last.fm/music/Sample+Band/_/Sample+Song',toptags:{tag:[{name:'alternative rock'}]}}};
function mock(calls){return async(input,options)=>{const u=new URL(input);assert.equal(options.redirect,'manual');calls.push({host:u.hostname,path:u.pathname,method:u.searchParams.get('method')});if(u.hostname==='musicbrainz.org'){assert.match(options.headers['User-Agent'],/WASP\/17\.0\.6/);return Response.json(u.pathname.includes('/artist/')?{artists:[mbArtist]}:{recordings:[mbTrack]})}if(u.hostname==='ws.audioscrobbler.com')return Response.json(lastfm(u.searchParams.get('method').startsWith('artist')));throw Error('unexpected upstream')}}

test('MusicBrainz verifies release and country, rejects ambiguous exact matches',async()=>{
 const result=await lookupMusicbrainz(record,{contact:'admin@example.invalid',fetcher:async()=>Response.json({recordings:[mbTrack]})});assert.equal(result.find(x=>x.field==='release_year').value,'2003');
 const artist=await lookupMusicbrainz({artist:'Sample Band',title:''},{contact:'admin@example.invalid',fetcher:async()=>Response.json({artists:[mbArtist]})});assert.equal(artist.find(x=>x.field==='country_code').value,'PHL');
 assert.deepEqual(await lookupMusicbrainz(record,{contact:'admin@example.invalid',fetcher:async()=>Response.json({recordings:[mbTrack,{...mbTrack,id:artistId}]})}),[]);
});
test('Last.fm does not invent release dates from wiki publication dates or artist geography',async()=>{
 const result=await lookupLastfm(record,{apiKey:'mock-key',fetcher:async()=>Response.json({...lastfm(false),wiki:{published:'2013'}})});assert.deepEqual(result.map(x=>x.field),['genre']);assert.equal(result[0].value,'alternative rock');
 assert.deepEqual(await lookupLastfm({...record,album:'different'},{apiKey:'mock-key',fetcher:async()=>Response.json(lastfm(false))}),[]);
});
test('admin provider settings protect credentials and prefer Last.fm; history is enriched without replay',async()=>{
 const f=fixture();await ensureTelemetrySchema(f.env);await recordTelemetryListen(f.env,record);
 assert.equal((await f.admin('PUT',{preferred:'lastfm',lastfm:true,musicbrainz:true,enabled:true,fallback:true,contact:'admin@example.invalid',apiKey:'mock-lastfm-api-key',secret:'mock-private-secret'})).status,200);
 const settings=await(await f.admin('GET')).json();assert.equal(settings.preferred,'lastfm');assert.equal(settings.apiKeyConfigured,true);assert.equal(settings.secretConfigured,true);assert.ok(!JSON.stringify(settings).includes('mock-lastfm-api-key'));
 const encrypted=f.sql.prepare("SELECT value FROM settings WHERE key='hive_lastfm_encrypted'").get().value;assert.ok(!encrypted.includes('mock-private-secret'));
 const calls=[];const first=await runMetadata(f.env,{force:true,fetcher:mock(calls)});assert.equal(first.checked,2);assert.equal(first.verified,2);assert.equal(calls[0].host,'ws.audioscrobbler.com');
 assert.equal((await runMetadata(f.env,{force:true,fetcher:mock(calls)})).skipped,true);
 f.reset();const second=await runMetadata(f.env,{force:true,fetcher:mock(calls)});assert.equal(second.verified,2);
 const summary=await telemetrySummary(f.env,new URL('https://wasp.invalid/api/telemetry?period=all&scope=hive'));assert.equal(summary.plays,1);assert.equal(summary.decades[0].decade,2000);assert.equal(summary.countries[0].code,'PHL');assert.equal(summary.topTags[0].name,'alternative rock');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM telemetry_events').get().n,1);
 assert.equal((await metadataFeed(f.env,new URL('https://wasp.invalid/api/telemetry/metadata/feed'))).status,403);
 f.set('network_share','1');const exported=await(await metadataFeed(f.env,new URL('https://wasp.invalid/api/telemetry/metadata/feed'))).json();assert.equal(exported.entries.length,2);assert.ok(exported.entries.every(e=>e.provider==='musicbrainz'));assert.ok(!JSON.stringify(exported).includes('mock-lastfm-api-key'));
 const ordinary=await(await telemetryFeed(f.env,new URL('https://wasp.invalid/api/telemetry/feed'))).json();assert.equal(ordinary.events[0].genre,'');assert.equal(ordinary.events[0].release_year,0,'metadata has a separate cursor');
 f.set('telemetry_share_enabled','0');assert.equal((await metadataFeed(f.env,new URL('https://wasp.invalid/api/telemetry/metadata/feed'))).status,403);
});
test('trusted direct peer verification is reused and not relayed as local validation',async()=>{
 const f=fixture();await ensureTelemetrySchema(f.env);await ensureMetadataSchema(f.env);await recordTelemetryListen(f.env,record);f.set('network_share','1');
 f.sql.prepare('INSERT INTO peers(id,url,name,added_at) VALUES(?,?,?,?)').run('p','https://peer.invalid','Trusted',1);
 await f.admin('PUT',{trustPeers:true,enabled:true,musicbrainz:false,lastfm:false});
 const entries=[{seq:1,artist:record.artist,title:'',album:'',field:'country_code',value:'PHL',provider:'musicbrainz',reference:'https://musicbrainz.org/artist/'+artistId},{seq:2,artist:record.artist,title:record.title,album:record.album,field:'release_year',value:'2003',provider:'musicbrainz',reference:'https://musicbrainz.org/recording/'+recordingId},{seq:3,artist:record.artist,title:'',album:'',field:'genre',value:'restricted-tag',provider:'lastfm',reference:'https://www.last.fm/music/Sample+Band'}];
 const calls=[];const fetcher=async(input)=>{calls.push(String(input));return Response.json({ok:true,protocol:1,nodeId:artistId,cursor:3,entries})};
 const result=await runMetadata(f.env,{force:true,fetcher});assert.equal(result.imported,2);assert.equal(calls.length,1);assert.match(calls[0],/metadata\/feed/);
 const summary=await telemetrySummary(f.env,new URL('https://example.invalid/api/telemetry?period=all'));assert.equal(summary.plays,1);assert.equal(summary.decades[0].decade,2000);assert.equal(summary.countries[0].code,'PHL');
 const feed=await(await metadataFeed(f.env,new URL('https://example.invalid/api/telemetry/metadata/feed'))).json();assert.equal(feed.entries.length,0);
});

test('metadata hotfix accepts runtime credentials, keeps old encryption fallback and supports explicit replacement',async()=>{
 const f=fixture();const old=f.env.METADATA_SETTINGS_KEY;delete f.env.METADATA_SETTINGS_KEY;f.env.SCANNER_SECRET=old;f.env.LASTFM_API_KEY='runtime-fixture-key';
 let d=await(await f.admin('GET')).json();assert.equal(d.credentialSource,'runtime');assert.equal(d.apiKeyConfigured,true);assert.ok(!JSON.stringify(d).includes('runtime-fixture-key'));
 d=await(await f.admin('PUT',{lastfm:true,apiKey:'saved-fixture-key',secret:'fixture-secret'})).json();assert.equal(d.credentialSource,'saved');assert.equal(d.apiKeyConfigured,true);
 f.env.METADATA_SETTINGS_KEY='new-dedicated-fixture-secret-long-enough';d=await(await f.admin('GET')).json();assert.equal(d.legacyKey,true);assert.equal(d.apiKeyConfigured,true);
 assert.equal((await f.admin('PUT',{apiKey:'replacement-fixture-key'})).status,200);delete f.env.SCANNER_SECRET;d=await(await f.admin('GET')).json();assert.equal(d.legacyKey,false);assert.equal(d.secretConfigured,true);
 f.env.METADATA_SETTINGS_KEY='different-fixture-key-with-length';d=await(await f.admin('GET')).json();assert.equal(d.apiKeyConfigured,false);assert.match(d.credentialError,/cannot be decrypted/);
 const before=f.sql.prepare("SELECT value FROM settings WHERE key='hive_lastfm_encrypted'").get().value;
 assert.equal((await f.admin('PUT',{apiKey:'new-key'})).status,409);assert.equal(f.sql.prepare("SELECT value FROM settings WHERE key='hive_lastfm_encrypted'").get().value,before);
 assert.equal((await f.admin('PUT',{apiKey:'new-key',replaceCredentials:true})).status,200);d=await(await f.admin('GET')).json();assert.equal(d.apiKeyConfigured,true);assert.equal(d.secretConfigured,false);
});
test('provider tests accept entered values without saving and return useful non-JSON errors',async()=>{
 const f=fixture();let calls=0;const fetcher=async(input,options)=>{calls++;const u=new URL(input);assert.equal(options.redirect,'manual');if(u.hostname==='musicbrainz.org'){assert.match(options.headers['User-Agent'],/contact@example.invalid/);return Response.json({artists:[]})}assert.equal(u.searchParams.get('api_key'),'entered-fixture-key');return Response.json({artist:{name:'Cher',tags:{tag:[]}}})};
 let d=await(await f.admin('POST',{provider:'lastfm',apiKey:'entered-fixture-key'},'/test',{fetcher})).json();assert.equal(d.source,'entered');assert.equal(d.ok,true);assert.equal((await(await f.admin('GET')).json()).apiKeyConfigured,false);
 d=await(await f.admin('POST',{provider:'musicbrainz',contact:'contact@example.invalid'},'/test',{fetcher})).json();assert.equal(d.ok,true);assert.equal(d.source,'entered');assert.equal((await(await f.admin('GET')).json()).contact,'');assert.equal(calls,2);
 f.set('hive_metadata_test_next_lastfm',0);const r=await f.admin('POST',{provider:'lastfm',apiKey:'entered-fixture-key'},'/test',{fetcher:async()=>new Response('<!DOCTYPE html>error',{status:200})});assert.equal(r.status,502);assert.match((await r.json()).error,/non-JSON response/);
});
test('admin counters report distinct track and artist cache entities, not listening events',async()=>{
 const f=fixture();await ensureMetadataSchema(f.env);const add=f.sql.prepare("INSERT INTO hive_metadata(artist,title,album,field,value,provider,verified_at) VALUES(?,?,?,?,?,'musicbrainz',1)");add.run('band','song','album','genre','rock');add.run('band','song','album','release_year','2003');add.run('band','','','country_code','PHL');const d=await(await f.admin('GET')).json();assert.equal(d.verified,3);assert.equal(d.verifiedTracks,1);assert.equal(d.verifiedArtists,1);
});
