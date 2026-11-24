import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {buildArtistDiscography,expandArtistAlbumTracks} from '../public/artist-discography.mjs';
const work=(id,artist,album)=>({id,title:'Song '+id,artist,artists:[artist],album,release_year:2024});
test('a compilation appears in each credited artist discography with every contributing track, not generic titles',()=>{
  const a=work('a','Artist One','Original Film Soundtrack');const b=work('b','Artist Two','Original Film Soundtrack');const c=work('c','Artist Three','Other Release');
  const list=expandArtistAlbumTracks([a],[a,b,c]);
  assert.deepEqual(list.map(x=>x.id),['a','b']);
  assert.equal(buildArtistDiscography(list)[0].tracks.length,2);
  assert.deepEqual(expandArtistAlbumTracks([work('d','Artist One','Greatest Hits')],[work('d','Artist One','Greatest Hits'),work('e','Artist Two','Greatest Hits')]).map(x=>x.id),['d']);
});
function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q{constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ops=>{sql.exec('BEGIN');try{const results=[];for(const op of ops)results.push(await op.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB,SPOTIFY_CLIENT_ID:'test_client_id',SPOTIFY_CLIENT_SECRET:'test_secret',MUSIC:{get:async()=>null,put:async()=>{throw Error('Unexpected audio write')},delete:async()=>{throw Error('Unexpected music delete')},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const api=async(path,method='GET',body,token='')=>{const res=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(token?{cookie:'sid='+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});return {status:res.status,body:await res.json().catch(()=>null)};};
 return {sql,api,env};
}
async function auth(f){const token=crypto.randomUUID();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(b=>b.toString(16).padStart(2,'0')).join('');f.sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+86400000,'admin');return token;}
test('album attachment is administrator-only, keeps artist/track ID and audio; history can undo',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await auth(f);
 f.sql.prepare('INSERT INTO tracks(id,title,artist,album,track_no,created_at) VALUES(?,?,?,?,?,?)').run('existing','Song','Original Contributor','Original Album',8,Date.now());
 const path='/api/admin/collection-attach',body={track_id:'existing',kind:'album',album:'Various Artists Movie Soundtrack',track_no:3};
 assert.equal((await f.api(path,'POST',body)).status,403);
 const changed=await f.api(path,'POST',body,token);
 assert.equal(changed.status,200,JSON.stringify(changed));
 assert.equal(changed.body.artist_preserved,true);
 assert.deepEqual({...f.sql.prepare('SELECT id,artist,album,track_no FROM tracks WHERE id=?').get('existing')},{id:'existing',artist:'Original Contributor',album:'Various Artists Movie Soundtrack',track_no:3});
 const saved=await f.api('/api/admin/collection-attach/history','GET',undefined,token);
 assert.equal(saved.status,200);assert.equal(saved.body.items.length,1);
 const undo=await f.api('/api/admin/collection-attach/'+saved.body.items[0].id+'/undo','POST',{},token);
 assert.equal(undo.status,200,JSON.stringify(undo.body));
 assert.equal(f.sql.prepare('SELECT album FROM tracks WHERE id=?').get('existing').album,'Original Album');
 f.sql.close();
});
test('Spotify catalogue search is admin gated and album metadata has no Spotify audio',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await auth(f);
 assert.equal((await f.api('/api/admin/collection-spotify/search?type=album&q=Soundtrack')).status,403);
 let seen=[];const old=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{seen.push(String(url));if(String(url).includes('accounts.spotify.com'))return Response.json({access_token:'fake',expires_in:3600});
   if(String(url).includes('/search?'))return Response.json({albums:{items:[{id:'abcdefghijklmnopqrstuv',name:'Movie Soundtrack',artists:[{name:'Various Artists'}],images:[],total_tracks:2}]}});
   if(String(url).includes('/albums/abcdefghijklmnopqrstuv'))return Response.json({name:'Movie Soundtrack',artists:[{name:'Various Artists'}],album_type:'compilation',release_date:'2024-09-20',total_tracks:2,tracks:{items:[{name:'Track A',artists:[{name:'Artist One'}],track_number:1,duration_ms:185000},{name:'Track B',artists:[{name:'Artist Two'}],track_number:2,duration_ms:210000}]}});
   throw Error('Unexpected external request '+url);
 };
 try{
   const result=await f.api('/api/admin/collection-spotify/search?type=album&q=Soundtrack','GET',undefined,token);
   assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.items[0].title,'Movie Soundtrack');
   const detail=await f.api('/api/admin/collection-spotify/resolve?type=album&id=abcdefghijklmnopqrstuv','GET',undefined,token);
   assert.equal(detail.status,200,JSON.stringify(detail.body));assert.equal(detail.body.tracks.length,2);assert.deepEqual(detail.body.tracks.map(x=>x.artists[0]),['Artist One','Artist Two']);
   assert.equal(detail.body.kind,'album');assert.equal(detail.body.complete,true);
 }finally{globalThis.fetch=old;f.sql.close();}
});
test('missing song from collection creates only one authorized request, no audio changes',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await auth(f);
 const payload={title:'Track Unavailable',artist:'Featured Performer'};
 assert.equal((await f.api('/api/admin/collection-request-song','POST',payload)).status,403);
 const first=await f.api('/api/admin/collection-request-song','POST',payload,token);
 assert.equal(first.status,201,JSON.stringify(first.body));
 const again=await f.api('/api/admin/collection-request-song','POST',payload,token);
 assert.equal(again.status,200);assert.equal(again.body.already_requested,true);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM requests WHERE kind='song'").get().n,1);
 const row=f.sql.prepare("SELECT meta FROM requests WHERE kind='song'").get();assert.equal(JSON.parse(row.meta).require_manual_match,true);
 f.sql.close();
});
