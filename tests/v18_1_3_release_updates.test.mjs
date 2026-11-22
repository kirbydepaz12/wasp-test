import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {RELEASE_SOURCES,compareVersions,fetchUpstream,releaseDecision,clearCachedChecks} from '../src/release-updates.js';
const SHA_A='a'.repeat(40),SHA_B='b'.repeat(40),SHA_C='c'.repeat(40);
const response=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json'}});
const fakeGithub=(sha=SHA_A,release=[])=>async url=>{
 const s=String(url);if(!s.startsWith('https://api.github.com/repos/'))throw Error('Unexpected host');
 if(s.includes('/releases'))return response(release);
 if(s.includes('/commits'))return response([{sha,commit:{message:'Fix release checker\nMore details',committer:{date:'2026-11-23T01:00:00Z'}}}]);
 return response({},404);
};
test('v18.1.3 version comparison supports letter patch releases and GitHub releases without credentials',()=>{
 assert.equal(compareVersions('v18.1.2a','18.1.2'),1);
 assert.equal(compareVersions('v18.1.3','18.1.2a'),1);
 assert.equal(compareVersions('v18.1.2a','18.1.3'),-1);
 assert.equal(compareVersions('18.1.3','v18.1.3'),0);
 assert.equal(compareVersions('unknown','v18.1.3'),null);
 assert.deepEqual(Object.keys(RELEASE_SOURCES).sort(),['stable','test']);
});
test('v18.1.3 stable omits prereleases; Test may see prereleases; untrusted links are not reflected',async()=>{
 clearCachedChecks();const releases=[{tag_name:'v18.1.4',name:'Preview',prerelease:true,published_at:'2026-11-23'},
 {tag_name:'v18.1.3',name:'Stable',prerelease:false,body:'Safe notes',published_at:'2026-11-22'}];
 const stable=await fetchUpstream('stable',{fetchImpl:fakeGithub(SHA_A,releases),now:Date.now()});
 assert.equal(stable.release.tag,'v18.1.3');
 const testData=await fetchUpstream('test',{fetchImpl:fakeGithub(SHA_A,releases),now:Date.now()});
 assert.equal(testData.release.tag,'v18.1.4');
 assert.equal(testData.release.url,'https://github.com/kirbydepaz12/wasp-test/releases/tag/v18.1.4');
 assert.equal(releaseDecision({upstream:testData,installedVersion:'18.1.3'}).kind,'release');
 const stableDecision=releaseDecision({upstream:stable,installedVersion:'18.1.3',baselineSha:SHA_A});
 assert.equal(stableDecision.available,false);
});
test('v18.1.3 commit-only notifications use a pinned baseline and never run installations',async()=>{
 clearCachedChecks();const now=Date.now();const first=await fetchUpstream('stable',{fetchImpl:fakeGithub(SHA_A,[]),now});
 assert.equal(releaseDecision({upstream:first,installedVersion:'18.1.3'}).available,false);
 assert.equal(releaseDecision({upstream:first,installedVersion:'18.1.3',baselineSha:SHA_A}).available,false);
 const after=await fetchUpstream('stable',{fetchImpl:fakeGithub(SHA_B,[]),now:now+21600001});
 const decision=releaseDecision({upstream:after,installedVersion:'18.1.3',baselineSha:SHA_A});
 assert.equal(decision.kind,'commit');assert.ok(decision.url.endsWith('/commit/'+SHA_B));
 assert.equal(releaseDecision({upstream:after,installedVersion:'18.1.3',deployedSha:SHA_B}).available,false);
 assert.equal(releaseDecision({upstream:after,installedVersion:'18.1.3',deployedSha:SHA_C}).available,true);
});
test('v18.1.3 invalid channel rejected and partial GitHub failure still checks available sources',async()=>{
 clearCachedChecks();await assert.rejects(()=>fetchUpstream('https://bad.example',{fetchImpl:fakeGithub()}),/Invalid/);
 const mock=async u=>String(u).includes('/releases')?response({},403):fakeGithub(SHA_A)(u);
 const data=await fetchUpstream('stable',{fetchImpl:mock,now:Date.now()});
 assert.equal(data.commit.sha,SHA_A);assert.equal(data.release,null);
});
async function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 class Q{constructor(sql,params=[]){this.sql=sql;this.params=params}bind(...p){return new Q(this.sql,p)}async first(){return sqlite.prepare(this.sql).get(...this.params)||null}async all(){return {results:sqlite.prepare(this.sql).all(...this.params)}}async run(){return {meta:{changes:sqlite.prepare(this.sql).run(...this.params).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async commands=>{sqlite.exec('BEGIN');try{const res=[];for(const c of commands)res.push(await c.run());sqlite.exec('COMMIT');return res;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{},delete:async()=>{},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('Not found',{status:404})}};
 const api=async(path,method='GET',body,cookie='')=>{const res=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env,{waitUntil:()=>{}});return {status:res.status,body:await res.json().catch(()=>null),cookie:res.headers.get('set-cookie')?.split(';')[0]||''};};
 await api('/api/me');
 const salt='1234567890abcdef1234567890abcdef';const pw='release-pw-123';
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
 const hash=[...new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(salt.match(/../g).map(x=>parseInt(x,16))),iterations:100000},key,256))].map(v=>v.toString(16).padStart(2,'0')).join('');
 sqlite.prepare("UPDATE admin SET salt=?,hash=? WHERE id='admin'").run(salt,hash);
 const admin=(await api('/api/login','POST',{id:'admin',password:pw})).cookie;
 return {sqlite,env,api,admin};
}
test('v18.1.3 admin-only channel persists per server; guests cannot change it; commit bootstrap is idempotent',async()=>{
 const previous=globalThis.fetch;clearCachedChecks();globalThis.fetch=fakeGithub(SHA_A,[]);
 const f=await fixture();try{
  assert.equal((await f.api('/api/admin/release-updates')).status,403);
  assert.equal((await f.api('/api/admin/release-updates','PUT',{channel:'test'})).status,403);
  assert.equal((await f.api('/api/admin/release-updates','PUT',{channel:'evil'},f.admin)).status,400);
  const initial=await f.api('/api/admin/release-updates','GET',undefined,f.admin);
  assert.equal(initial.status,200);assert.equal(initial.body.channel,'stable');
  assert.equal(initial.body.decision.available,false);
  assert.equal(f.sqlite.prepare("SELECT value FROM settings WHERE key='release_update_baseline_stable'").get().value,SHA_A);
  const changed=await f.api('/api/admin/release-updates','PUT',{channel:'test'},f.admin);
  assert.equal(changed.status,200);assert.equal(changed.body.repository,'kirbydepaz12/wasp-test');
  const testChannel=await f.api('/api/admin/release-updates','GET',undefined,f.admin);
  assert.equal(testChannel.body.channel,'test');assert.equal(testChannel.body.repository,'kirbydepaz12/wasp-test');
  assert.equal(f.sqlite.prepare("SELECT value FROM settings WHERE key='release_update_baseline_test'").get().value,SHA_A);
  assert.equal(f.sqlite.prepare("SELECT value FROM settings WHERE key='release_update_baseline_stable'").get().value,SHA_A);
  const other=await fixture();try{assert.equal((await other.api('/api/admin/release-updates','GET',undefined,other.admin)).body.channel,'stable');}finally{other.sqlite.close();}
 }finally{f.sqlite.close();globalThis.fetch=previous;clearCachedChecks();}
});
