import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {validMusicRoot,readMusicRoots,saveMusicRoots,combinedMusicRoots,verifyMusicRoot} from '../docker/music-folders.mjs';
import {feedTab} from '../src/rss-feeds.js';
import worker from '../src/index.js';

test('Docker roots require safe container paths; repeated roots dedupe and persist',async()=>{
  assert.equal(validMusicRoot('/music2'),'/music2');
  assert.equal(validMusicRoot('/mnt/music_collection'),'/mnt/music_collection');
  assert.equal(validMusicRoot('/music3/rock'),'/music3/rock');
  for(const v of ['../music2','/','/app/.wrangler','/data/uploads','/music/../../etc','/music2/','/proc/music','/music 2','/music2//abc','https://example.org/music'])assert.equal(validMusicRoot(v),'',v);
  assert.deepEqual(combinedMusicRoots(['/music'],['/music2','/music2','/music3']),['/music','/music2','/music3']);
  const dir=await mkdtemp(path.join(tmpdir(),'wasp-musicfolders-test-'));
  try{const file=path.join(dir,'roots.json');assert.deepEqual(await readMusicRoots(file),[]);await saveMusicRoots(['/music2','/music3'],file);assert.deepEqual(await readMusicRoots(file),['/music2','/music3']);assert.rejects(()=>saveMusicRoots(['/app'],file));}
  finally{await rm(dir,{recursive:true,force:true});}
});

test('Docker directory validator rejects unavailable folders without creating or writing them',async()=>{
  await assert.rejects(()=>verifyMusicRoot('/music2',{fsApi:{lstat:async()=>null}}),/not mounted/);
  const fake={lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false}),realpath:async s=>s,readdir:async()=>[],readFile:async()=> '14 12 0:1 / /music2 ro - ext4 /dev/disk ro'};
  assert.equal(await verifyMusicRoot('/music2',{fsApi:fake}),'/music2');
  await assert.rejects(()=>verifyMusicRoot('/music2',{fsApi:{...fake,realpath:async()=>'/etc'}}),/symbolic-link/);
  await assert.rejects(()=>verifyMusicRoot('/music2',{fsApi:{...fake,readFile:async()=> '14 12 0:1 / /music ro - ext4 /dev/disk ro'}}),/not a Docker mount/);
});

test('RSS icons must use public HTTPS, and optional icons are independent of tab title',()=>{
  assert.equal(feedTab({title:'Pitchfork',code:'https://pitchfork.com/feed/rss',icon_url:'https://cdn.example/icon.png'}).icon_url,'https://cdn.example/icon.png');
  assert.equal(feedTab({title:'Pitchfork',code:'https://pitchfork.com/feed/rss'}).icon_url,'');
  for(const link of ['http://cdn.example/icon.png','javascript:alert(1)','https://127.0.0.1/test.png'])assert.throws(()=>feedTab({title:'Bad',code:'https://news.example/rss',icon_url:link}),/icons must/);
});

function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q{constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ops=>{sql.exec('BEGIN');try{const results=[];for(const op of ops)results.push(await op.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{throw Error('music data changed')},delete:async()=>{throw Error('audio deleted')},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
 const api=async(path,method='GET',body,token='')=>{const res=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(token?{cookie:'sid='+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});return {status:res.status,body:await res.json().catch(()=>null)}};
 return {sql,env,api};
}
async function admin(f){const token=crypto.randomUUID();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(b=>b.toString(16).padStart(2,'0')).join('');f.sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+86400000,'admin');return token;}

test('RSS tab icon order, global show_titles setting and saved feed IDs survive restart and hide',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await admin(f);
 try{
   assert.equal((await f.api('/api/admin/rss')).status,403);
   assert.equal((await f.api('/api/admin/music-folders')).status,403);
   assert.equal((await f.api('/api/admin/music-folders','GET',undefined,token)).status,404);
   const tabs=[{title:'News',code:'https://feed.example/rss',icon_url:'https://cdn.example/news.png'},{title:'Metal',code:'https://metal.example/feed'}];
   const saved=await f.api('/api/admin/rss','PUT',{enabled:true,position:'right',show_titles:false,tabs},token);
   assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.show_titles,false);
   assert.equal(saved.body.tabs[0].icon_url,'https://cdn.example/news.png');
   assert.equal((await f.api('/api/rss')).body.tabs[1].icon_url,'');
   const changed=await f.api('/api/admin/rss','PUT',{enabled:false,position:'center',show_titles:false,tabs:[saved.body.tabs[1],saved.body.tabs[0]]},token);
   assert.equal(changed.status,200,JSON.stringify(changed.body));assert.equal(changed.body.tabs[0].title,'Metal');
   assert.equal(changed.body.tabs[1].id,saved.body.tabs[0].id);
   assert.equal(changed.body.tabs[1].icon_url,'https://cdn.example/news.png');
   assert.equal((await f.api('/api/rss')).body.tabs.length,0);
   const on=await f.api('/api/admin/rss','PUT',{enabled:true,position:'center',show_titles:true,tabs:changed.body.tabs},token);
   assert.equal(on.body.show_titles,true);assert.equal((await f.api('/api/rss')).body.tabs[0].title,'Metal');
   const bad=await f.api('/api/admin/rss','PUT',{enabled:true,position:'left',tabs:[{title:'Unsafe',code:'https://feed.example/rss',icon_url:'http://site.com/icon.png'}]},token);
   assert.equal(bad.status,400);
 }finally{f.sql.close();}
});
