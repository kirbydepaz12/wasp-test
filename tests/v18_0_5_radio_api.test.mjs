import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';

function fixture(){
  const sql=new DatabaseSync(':memory:');
  class Q { constructor(s,a=[]){this.s=s;this.a=a} bind(...a){return new Q(this.s,a)} async first(){return sql.prepare(this.s).get(...this.a)||null} async all(){return {results:sql.prepare(this.s).all(...this.a)}} async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
  const DB={prepare:s=>new Q(s),batch:async statements=>{sql.exec('BEGIN');try{const data=await Promise.all(statements.map(s=>s.run()));sql.exec('COMMIT');return data}catch(e){sql.exec('ROLLBACK');throw e}}};
  const env={DB,MUSIC:{get:async()=>null,list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
  const ctx={waitUntil(p){p.catch(()=>{})}};
  return {sql,env,request:async path=>{const res=await worker.fetch(new Request('https://wasp.test'+path),env,ctx);return {status:res.status,data:await res.json()}}};
}

test('anonymous Radio ranks all-time telemetry without exposing listener identities and caches aggregate',async()=>{
  const x=fixture();const first=await x.request('/api/radio/top');assert.equal(first.status,200);assert.deepEqual(first.data,[]);
  const id=x.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_events'").get();assert.equal(id.name,'telemetry_events');
  const origin='server-123',date=Date.now();
  for(const [t,a,n] of [['Song 1','Artist',4],['Song 2','Other',2]])for(let i=0;i<n;i++){
    x.sql.prepare('INSERT INTO telemetry_events(origin_id,event_id,played_at,title,artist,album) VALUES(?,?,?,?,?,?)').run(origin,t+'-'+i,date,t,a,'Album');
  }
  x.sql.prepare('DELETE FROM telemetry_summary_cache WHERE key=?').run('radio_top_all_v185');
  const got=await x.request('/api/radio/top');assert.equal(got.status,200);assert.equal(got.data.length,2);assert.equal(got.data[0].name,'Song 1');assert.equal(got.data[0].plays,4);
  assert.deepEqual(Object.keys(got.data[0]).sort(),['artist','name','plays']);
  x.sql.prepare('DELETE FROM telemetry_events').run();
  const cached=await x.request('/api/radio/top');assert.deepEqual(cached.data,got.data);
  x.sql.close();
});

test('catalogue year/genre augmentation degrades safely on missing metadata tables',async()=>{
  const x=fixture();const initial=await x.request('/api/tracks');assert.equal(initial.status,200);assert.deepEqual(initial.data,[]);
  x.sql.prepare('INSERT INTO tracks(id,title,artist,album,duration,created_at) VALUES(?,?,?,?,?,?)').run('track-1','Example','Band','Album',201,Date.now());
  const got=await x.request('/api/tracks');assert.equal(got.status,200);assert.equal(got.data.length,1);assert.equal(got.data[0].title,'Example');
  x.sql.close();
});
