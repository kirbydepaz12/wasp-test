import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {metadataBankApi,ensureBank,audioBounds} from '../src/metadata-bank.js';
const token='s'.repeat(64),source='https://metadata.example.test';
const hash='a'.repeat(64);
function setup(){const sqlite=new DatabaseSync(':memory:');
 class Q{constructor(q,p=[]){this.q=q;this.p=p;}bind(...p){return new Q(this.q,p);}async first(){return sqlite.prepare(this.q).get(...this.p)||null;}async all(){return {results:sqlite.prepare(this.q).all(...this.p)};}async run(){return {meta:{changes:sqlite.prepare(this.q).run(...this.p).changes}};}}
 const DB={prepare:q=>new Q(q),batch:async cmds=>{sqlite.exec('BEGIN');try{const results=[];for(const q of cmds)results.push(await q.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 sqlite.exec(`CREATE TABLE tracks(id TEXT PRIMARY KEY,title TEXT,artist TEXT,artists TEXT,album TEXT,track_no INTEGER,duration REAL,plays INTEGER,created_at INTEGER);CREATE TABLE track_artist_map(track_id TEXT,artist_key TEXT,album TEXT, PRIMARY KEY(track_id,artist_key));CREATE TABLE telemetry_track_metadata(track_id TEXT PRIMARY KEY,release_year INTEGER,genre TEXT);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO settings(key,value) VALUES('wasp_telemetry_schema','17.2');`);
 sqlite.prepare('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)').run('track-1','Track 01','Unknown artist','["Unknown artist"]','Unknown album',1,212.2,123,1);
 const makeArtistIndex=(db,row)=>[db.prepare('DELETE FROM track_artist_map WHERE track_id=?').bind(row.id),db.prepare('INSERT INTO track_artist_map(track_id,artist_key,album) VALUES(?,?,?)').bind(row.id,row.artist.toLowerCase(),row.album)];
 const env={DB,WASP_METADATA_SOURCE_URL:source,WASP_METADATA_PULL_TOKEN:token,MUSIC:{get:()=>{throw Error('No audio objects should be accessed while applying tags');}}};
 const api=async(path,method='GET',body,fetcher)=>{const url=new URL('https://wasp.test/api/admin/metadata-bank/'+path);const req=new Request(url,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const response=await metadataBankApi(req,env,url,{makeArtistIndex,fetcher});return {status:response.status,...await response.json()};};
 return {sqlite,DB,env,api};}
const entry=(overrides={})=>({id:'file-1',seq:1,audio_sha256:hash,tags:{title:'Updated Song',artist:'New Artist',artists:['New Artist'],album:'Correct Album',track_no:3,duration:212.2,genre:['Rock','Alternative'],musicbrainz_recording_id:'01234567-89ab-cdef-0123-456789abcdef',native:{'musicbrainz album id':['01234567-89ab-cdef-0123-456789abcdef']}},...overrides});
const feed=(items)=>async(url,opts)=>{assert.equal(new URL(url).hostname,'metadata.example.test');assert.equal(opts.redirect,'manual');assert.equal(opts.headers['x-wasp-metadata-token'],token);return Response.json({ok:true,protocol:2,cursor:items.at(-1)?.seq||0,more:false,entries:items});};

test('v18.1.5 audio-only fingerprint removes ID3v2 head and ID3v1 tail',()=>{const b=new Uint8Array(10+4+128);b.set([73,68,51,4,0,0,0,0,0,4]);b.set([1,2,3,4],10);b.set([84,65,71],14);assert.deepEqual(audioBounds(b),[14,14]);assert.deepEqual(audioBounds(new Uint8Array([1,2,3])),[0,3]);});

test('v18.1.5 source list never exposes access tokens, unapproved sources forbidden',async()=>{const f=setup();try{const res=await f.api('sources');assert.equal(res.status,200);assert.equal(res.sources[0].url,source);assert.ok(!JSON.stringify(res).includes(token));assert.equal((await f.api('pull','POST',{source:'https://malicious.example',cursor:0},feed([entry()]))).status,403);}finally{f.sqlite.close();}});

test('v18.1.5 unique audio match stages without editing tracks; apply then rollback restores record and keeps plays',async()=>{const f=setup();try{await ensureBank(f.env);f.sqlite.prepare('INSERT INTO pc_metadata_audio_hashes VALUES(?,?,?,?)').run('track-1',hash,'done',Date.now());const p=await f.api('pull','POST',{source,cursor:0},feed([entry()]));assert.equal(p.status,200);assert.equal(p.staged,1);let pending=await f.api('pending?source='+encodeURIComponent(source));assert.equal(pending.audio_matches,1);assert.equal(pending.items[0].match_type,'audio');assert.equal(f.sqlite.prepare('SELECT title FROM tracks').get().title,'Track 01');
 const bad=await f.api('apply','POST',{source,ids:['file-1'],confirm:'not confirmed'});assert.equal(bad.status,400);assert.equal(f.sqlite.prepare('SELECT title FROM tracks').get().title,'Track 01');
 const applied=await f.api('apply','POST',{source,ids:['file-1'],confirm:'apply metadata'});assert.equal(applied.status,200);assert.equal(applied.applied,1);const t=f.sqlite.prepare('SELECT id,title,artist,album,track_no,plays FROM tracks').get();assert.equal(t.id,'track-1');assert.equal(t.title,'Updated Song');assert.equal(t.artist,'New Artist');assert.equal(t.album,'Correct Album');assert.equal(t.track_no,3);assert.equal(t.plays,123);assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT tags_json FROM pc_metadata_tags').get().tags_json).genre,['Rock','Alternative']);assert.equal(f.sqlite.prepare('SELECT genre FROM telemetry_track_metadata').get().genre,'rock');
 const restored=await f.api('undo','POST',{batch_id:applied.batch_id,confirm:'undo metadata'});assert.equal(restored.status,200);assert.equal(restored.undone,1);assert.equal(f.sqlite.prepare('SELECT title FROM tracks').get().title,'Track 01');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM pc_metadata_tags').get().n,0);assert.equal(f.sqlite.prepare('SELECT plays FROM tracks').get().plays,123);
 }finally{f.sqlite.close();}});

test('v18.1.5 metadata similarity is review-only, manual assignment requires deliberate confirmation',async()=>{const f=setup();try{const r=entry({id:'file-2',seq:2,audio_sha256:'b'.repeat(64),tags:{...entry().tags,title:'Track 01',artist:'Unknown artist'}});assert.equal((await f.api('pull','POST',{source,cursor:0},feed([r]))).staged,1);let pending=await f.api('pending?source='+encodeURIComponent(source));assert.equal(pending.items[0].match_type,'review');assert.equal((await f.api('apply','POST',{source,ids:['file-2'],confirm:'apply metadata'})).applied,0);
 assert.equal((await f.api('assign','POST',{source,entry_id:'file-2',track_id:'track-1',confirm:'wrong'})).status,400);assert.equal((await f.api('assign','POST',{source,entry_id:'file-2',track_id:'track-1',confirm:'match manually'})).status,200);pending=await f.api('pending?source='+encodeURIComponent(source));assert.equal(pending.items[0].match_type,'manual');
 }finally{f.sqlite.close();}});

test('v18.1.5 invalid entries and source response are rejected without track modification',async()=>{const f=setup();try{assert.equal((await f.api('pull','POST',{source,cursor:0},feed([{...entry(),audio_sha256:'not-a-hash'}]))).status,502);assert.equal(f.sqlite.prepare('SELECT title FROM tracks').get().title,'Track 01');}finally{f.sqlite.close();}});

test('v18.1.5 worker admin endpoints are denied to guests and PC file scanner is absent on Cloudflare',async()=>{const sqlite=new DatabaseSync(':memory:');class Q{constructor(q,p=[]){this.q=q;this.p=p;}bind(...p){return new Q(this.q,p);}async first(){return sqlite.prepare(this.q).get(...this.p)||null;}async all(){return {results:sqlite.prepare(this.q).all(...this.p)};}async run(){return {meta:{changes:sqlite.prepare(this.q).run(...this.p).changes}};}}const env={DB:{prepare:q=>new Q(q),batch:async ops=>Promise.all(ops.map(x=>x.run()))},MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('Not found',{status:404})}};
 try{const api=async(path,method='GET')=>worker.fetch(new Request('https://wasp.test'+path,{method}),env,{waitUntil:()=>{}});await api('/api/me');assert.equal((await api('/api/admin/metadata-bank/sources')).status,403);const local=await api('/api/admin/pc-source/status');assert.equal(local.status,403);}finally{sqlite.close();}});


test('v18.1.5a authenticated admin metadata-source route resolves implementation and never exposes token',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 class Q { constructor(sql,values=[]){this.sql=sql;this.values=values;} bind(...values){return new Q(this.sql,values);} async first(){return sqlite.prepare(this.sql).get(...this.values)||null;} async all(){return {results:sqlite.prepare(this.sql).all(...this.values)};} async run(){return {meta:{changes:sqlite.prepare(this.sql).run(...this.values).changes}};} }
 const DB={prepare:sql=>new Q(sql),batch:async commands=>{sqlite.exec('BEGIN');try{const result=[];for(const c of commands)result.push(await c.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const env={DB,WASP_METADATA_SOURCE_URL:source,WASP_METADATA_PULL_TOKEN:token,MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('Not found',{status:404})}};
 const request=(url,cookie='')=>worker.fetch(new Request('https://wasp.test'+url,{headers:cookie?{cookie}:undefined}),env,{waitUntil:()=>{}});
 try{
  await request('/api/me');
  const sid='test-admin-session';const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sid)))).map(v=>v.toString(16).padStart(2,'0')).join('');
  sqlite.prepare("INSERT INTO sessions(token,expires,role,user_id) VALUES(?,?,?,?)").run(digest,Date.now()+3600000,'admin','admin');
  const res=await request('/api/admin/metadata-bank/sources','sid='+sid);
  assert.equal(res.status,200,'Admin metadata source endpoint must not fail with a server ReferenceError');
  const payload=await res.json();
  assert.equal(payload.sources.length,1);
  assert.deepEqual(payload.sources[0],{url:source,name:'PC Picard source'});
  assert.ok(!JSON.stringify(payload).includes(token),'Read-only metadata source credential must never be reflected');
  const guests=await request('/api/admin/metadata-bank/sources');assert.equal(guests.status,403);
 }finally{sqlite.close();}
});
