import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';

test('telemetry defaults to 5 minutes, can disable outbound sharing, and admin can trigger each job with status',async()=>{
  const sql=new DatabaseSync(':memory:');
  class Statement{constructor(query,args=[]){this.query=query;this.args=args}bind(...args){return new Statement(this.query,args)}async first(){return sql.prepare(this.query).get(...this.args)||null}async all(){return {results:sql.prepare(this.query).all(...this.args)}}async run(){const x=sql.prepare(this.query).run(...this.args);return {meta:{changes:x.changes}}}}
  const DB={prepare:q=>new Statement(q),batch:async ss=>{sql.exec('BEGIN');try{for(const s of ss)await s.run();sql.exec('COMMIT')}catch(e){sql.exec('ROLLBACK');throw e}}};
  const env={DB,ASSETS:{fetch:async()=>new Response('not found',{status:404})},MUSIC:{put:async()=>{},get:async()=>null,list:async()=>({objects:[],truncated:false})}};
  const api=async(path,method='GET',body,cookie='')=>{
    const response=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined}),env,{});
    return {status:response.status,data:await response.json().catch(()=>null)};
  };
  await api('/api/tracks');
  const token='cron-admin-session';
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('');
  sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+600000,'admin');
  const cookie='sid='+token;
  assert.equal((await api('/api/admin/crons')).status,403);
  const initial=await api('/api/admin/crons','GET',undefined,cookie);
  assert.equal(initial.data.jobs.telemetry.enabled,true);assert.equal(initial.data.jobs.telemetry.minutes,5);
  assert.equal(initial.data.jobs.hash.enabled,false);
  const disabled={...initial.data,jobs:{...initial.data.jobs,telemetry:{enabled:false,minutes:15}}};
  assert.equal((await api('/api/admin/crons','PUT',disabled,cookie)).status,200);
  assert.equal((await api('/api/admin/crons','GET',undefined,cookie)).data.jobs.telemetry.enabled,false);
  assert.equal(sql.prepare("SELECT value FROM settings WHERE key='telemetry_share_enabled'").get().value,'0');
  const feed=await api('/api/telemetry/feed');assert.equal(feed.status,403);
  // Manual telemetry remains possible while automatic export is disabled.
  for(const kind of ['telemetry','peers','artwork','biography','hash']){
    const run=await api('/api/admin/crons/run','POST',{kind},cookie);
    assert.equal(run.status,202,kind+':'+JSON.stringify(run.data));
    const status=await api('/api/admin/crons/run-status?id='+run.data.runId,'GET',undefined,cookie);
    assert.equal(status.status,200);assert.equal(status.data.kind,kind);
    assert.ok(['complete','error'].includes(status.data.state));
  }
});
