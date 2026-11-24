import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q{constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ops=>{sql.exec('BEGIN');try{const results=[];for(const op of ops)results.push(await op.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{throw Error('Unexpected audio write')},delete:async()=>{throw Error('Unexpected music delete')},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const api=async(path,method='GET',body,token='')=>{const res=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(token?{cookie:'sid='+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});return {status:res.status,body:await res.json().catch(()=>null)};};
 return {sql,api,env};
}
async function auth(f){const token=crypto.randomUUID();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(b=>b.toString(16).padStart(2,'0')).join('');f.sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+86400000,'admin');return token;}
const MOCK_ALBUM={id:12345,title:'Movie Album',artist:{name:'Various Artists'},nb_tracks:2,cover_medium:'https://e-cdns-images.dzcdn.net/images/cover/test/250x250.jpg',tracks:{data:[{title:'Opening Theme',artist:{name:'Artist One'},track_position:1,duration:150},{title:'Final Theme',artist:{name:'Artist Two'},track_position:2,duration:170}]}};
const mockDeezer=async url=>{const u=String(url);if(u.includes('/search/album?'))return Response.json({data:[MOCK_ALBUM]});if(u.endsWith('/album/12345'))return Response.json(MOCK_ALBUM);if(u.includes('/search/playlist?'))return Response.json({data:[]});throw Error('Unexpected external URL '+u);};
test('public album lookup mirrors user request autocomplete; no Spotify credentials required; guest blocked',async()=>{
 const f=fixture();await f.api('/api/tracks');const admin=await auth(f),old=globalThis.fetch;globalThis.fetch=mockDeezer;
 try{
  assert.equal((await f.api('/api/admin/collection-guide/search?type=album&q=movie')).status,403);
  const result=await f.api('/api/admin/collection-guide/search?type=album&q=movie','GET',undefined,admin);
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.items[0].provider,'deezer');
  const resolved=await f.api('/api/admin/collection-guide/resolve?type=album&id=12345','GET',undefined,admin);
  assert.equal(resolved.status,200);assert.equal(resolved.body.complete,true);assert.deepEqual(resolved.body.tracks.map(t=>t.artists[0]),['Artist One','Artist Two']);
 }finally{globalThis.fetch=old;f.sql.close();}
});
test('pending draft persists, reopens, preserves contributing artists and audio, rejects incorrect/duplicate slot assignments',async()=>{
 const f=fixture();await f.api('/api/tracks');const admin=await auth(f),old=globalThis.fetch;globalThis.fetch=mockDeezer;
 f.sql.prepare('INSERT INTO tracks(id,title,artist,album,track_no,created_at) VALUES(?,?,?,?,?,?)').run('old-one','Retagged First','Artist One','Old Album',8,Date.now());
 f.sql.prepare('INSERT INTO tracks(id,title,artist,album,track_no,created_at) VALUES(?,?,?,?,?,?)').run('old-two','Retagged Second','Artist Two','Old Album',9,Date.now());
 try{
  assert.equal((await f.api('/api/admin/collection-drafts','POST',{kind:'album',id:'12345'})).status,403);
  const created=await f.api('/api/admin/collection-drafts','POST',{kind:'album',id:'12345'},admin);
  assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.status,'pending');assert.equal(created.body.remaining,2);
  const id=created.body.id;
  assert.equal((await f.api('/api/admin/collection-drafts','POST',{kind:'album',id:'12345'},admin)).body.id,id,'same source should resume');
  assert.equal((await f.api('/api/admin/collection-drafts/'+id+'/assign','POST',{slot:0,track_id:'missing'},admin)).status,404);
  const first=await f.api('/api/admin/collection-drafts/'+id+'/assign','POST',{slot:0,track_id:'old-one'},admin);
  assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.status,'pending');assert.equal(first.body.remaining,1);
  assert.equal(f.sql.prepare('SELECT artist FROM tracks WHERE id=?').get('old-one').artist,'Artist One','artist must be preserved');
  assert.equal((await f.api('/api/admin/collection-drafts/'+id+'/assign','POST',{slot:1,track_id:'old-one'},admin)).status,409);
  const reopened=await f.api('/api/admin/collection-drafts/'+id,'GET',undefined,admin);
  assert.equal(reopened.body.matches['0'],'old-one');assert.equal(reopened.body.remaining,1);
  const completed=await f.api('/api/admin/collection-drafts/'+id+'/assign','POST',{slot:1,track_id:'old-two'},admin);
  assert.equal(completed.status,200,JSON.stringify(completed));assert.equal(completed.body.status,'complete');
  assert.deepEqual(f.sql.prepare('SELECT artist,album FROM tracks ORDER BY id').all().map(r=>r.artist),['Artist One','Artist Two']);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM album_attach_history').get().n,2,'undo history retained');
  const undoID=f.sql.prepare('SELECT id FROM album_attach_history WHERE track_id=?').get('old-two').id;
  assert.equal((await f.api('/api/admin/collection-attach/'+undoID+'/undo','POST',{},admin)).status,200);
  const reverted=await f.api('/api/admin/collection-drafts/'+id,'GET',undefined,admin);
  assert.equal(reverted.body.status,'pending','Undo must reopen the associated source slot');
  assert.equal(reverted.body.remaining,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tracks').get().n,2,'draft assignment never creates duplicate audio tracks');
 }finally{globalThis.fetch=old;f.sql.close();}
});
test('partial source stays pending even with all exposed tracks matched',async()=>{
 const f=fixture();await f.api('/api/tracks');const admin=await auth(f),old=globalThis.fetch;
 globalThis.fetch=async url=>Response.json({...MOCK_ALBUM,nb_tracks:3});
 f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('old-one','Track One','Artist One','Old Album',Date.now());
 f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('old-two','Track Two','Artist Two','Old Album',Date.now());
 try{
  const draft=(await f.api('/api/admin/collection-drafts','POST',{kind:'album',id:'12345'},admin)).body;
  assert.equal(draft.source.complete,false);
  await f.api('/api/admin/collection-drafts/'+draft.id+'/assign','POST',{slot:0,track_id:'old-one'},admin);
  const end=await f.api('/api/admin/collection-drafts/'+draft.id+'/assign','POST',{slot:1,track_id:'old-two'},admin);
  assert.equal(end.body.status,'pending');assert.equal(end.body.source.source_total,3);
  assert.equal((await f.api('/api/admin/collection-drafts/'+draft.id+'/verify','POST',{confirm:'wrong'},admin)).status,400);
  const verified=await f.api('/api/admin/collection-drafts/'+draft.id+'/verify','POST',{confirm:'complete'},admin);
  assert.equal(verified.status,200);assert.equal(verified.body.status,'complete','manual source verification explicitly completes a partial catalogue');
 }finally{globalThis.fetch=old;f.sql.close();}
});
test('public Spotify album/playlist URLs use the existing embed reader without developer credentials and flag uncertainty',async()=>{
 const f=fixture();await f.api('/api/tracks');const admin=await auth(f),old=globalThis.fetch,spotifyId='abcdefghijklmnopqrstuvwxyz';
 const embedded=JSON.stringify({props:{pageProps:{entity:{name:'Movie Music',trackCount:2,trackList:[{title:'Track A',subtitle:'Artist One'},{title:'Track B',subtitle:'Artist Two'}]}}}});
 globalThis.fetch=async url=>{
  const target=String(url);
  if(target.includes('accounts.spotify.com')||target.includes('api.spotify.com'))throw Error('Must not request a credentialed Spotify token');
  if(target.includes('/oembed?'))return Response.json({title:'Movie Music',thumbnail_url:'https://i.scdn.co/image/test'});
  if(target.includes('/embed/'))return new Response(`<html><script id="__NEXT_DATA__">${embedded}</script></html>`);
  throw Error('Unexpected external URL '+target);
 };
 try{
  const url=`https://open.spotify.com/album/${spotifyId}`;
  const res=await f.api('/api/admin/collection-guide/resolve?'+new URLSearchParams({type:'album',url}),'GET',undefined,admin);
  assert.equal(res.status,200,JSON.stringify(res.body));assert.equal(res.body.tracks.length,2);assert.equal(res.body.provider,'spotify-public-embed');assert.equal(res.body.complete,false);
  const created=await f.api('/api/admin/collection-drafts','POST',{kind:'album',url},admin);
  assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.status,'pending');
  const plurl=`https://open.spotify.com/playlist/${spotifyId}`;
  const playlist=await f.api('/api/admin/collection-drafts','POST',{kind:'playlist',url:plurl},admin);
  assert.equal(playlist.status,201,JSON.stringify(playlist.body));assert.equal(playlist.body.kind,'playlist');assert.equal(playlist.body.source.tracks.length,2);
  assert.ok(playlist.body.playlist_id,'A partial playlist must exist and accept matched songs');
 }finally{globalThis.fetch=old;f.sql.close();}
});
