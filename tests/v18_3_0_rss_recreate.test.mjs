import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {parseFeed,safeFeedUrl,feedTab} from '../src/rss-feeds.js';
import {autoRecreateMatch,recreateCandidates} from '../src/collection-recreate.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q{constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ops=>{sql.exec('BEGIN');try{const results=[];for(const op of ops)results.push(await op.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{throw Error('audio writes forbidden')},delete:async()=>{throw Error('audio deletion forbidden')},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
 const api=async(path,method='GET',body,token='')=>{const res=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(token?{cookie:'sid='+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});return {status:res.status,body:await res.json().catch(()=>null)}};
 return {sql,api,env};
}
async function admin(f){const token=crypto.randomUUID();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(b=>b.toString(16).padStart(2,'0')).join('');f.sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+86400000,'admin');return token;}
const fakeAlbum={id:12345,title:'Compilation of Stars',artist:{name:'Various Artists'},nb_tracks:3,tracks:{data:[{title:'One Thing',artist:{name:'Artist A'},track_position:1,duration:210},{title:'Amazing Night',artist:{name:'Artist B'},track_position:2,duration:190},{title:'Missing Forever',artist:{name:'Artist C'},track_position:3,duration:180}]}};
test('safe RSS reader supports RSS and Atom but rejects private URL, scripts, and active embeds',()=>{
 assert.equal(safeFeedUrl('http://localhost/rss'),null);assert.equal(safeFeedUrl('https://127.0.0.1/feed'),null);assert.equal(safeFeedUrl('https://feed.example.org/rss')?.startsWith('https://'),true);
 assert.throws(()=>feedTab({title:'Bad',code:'<script>alert(1)</script>'}));assert.throws(()=>feedTab({title:'Bad',code:'https://localhost/rss'}));
 assert.deepEqual(parseFeed('<rss><channel><item><title>News &amp; Updates</title><description><![CDATA[<p>Safe <b>content</b></p>]]></description><link>https://example.com/a</link></item></channel></rss>').items[0],{title:'News & Updates',description:'Safe content',url:'https://example.com/a',date:'',image:''});
 assert.equal(parseFeed('<feed><entry><title>Atom item</title><link href="https://example.com"/><summary>Updated</summary></entry></feed>').items[0].title,'Atom item');
});
test('RSS OFF by default, persists unlimited tab data while disabled, private admin controls',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await admin(f);
 try{
  assert.deepEqual((await f.api('/api/rss')).body.tabs,[]);
  assert.equal((await f.api('/api/admin/rss')).status,403);
  assert.equal((await f.api('/api/admin/rss','PUT',{enabled:true,position:'left',tabs:[{title:'Unsafe',code:'https://127.0.0.1/data'}]},token)).status,400);
  const update=await f.api('/api/admin/rss','PUT',{enabled:true,position:'right',tabs:[{title:'Music',code:'https://feeds.example.com/music.xml'},{title:'Promo',code:'<div>Static promotions only</div>'}]},token);
  assert.equal(update.status,200,JSON.stringify(update));assert.equal(update.body.tabs.length,2);
  assert.equal((await f.api('/api/rss')).body.tabs.length,2);
  const off=await f.api('/api/admin/rss','PUT',{enabled:false,position:'center',tabs:update.body.tabs},token);
  assert.equal(off.status,200,JSON.stringify(off));assert.equal((await f.api('/api/rss')).body.tabs.length,0);
  assert.equal((await f.api('/api/admin/rss','GET',undefined,token)).body.tabs.length,2,'Saved feed entries must remain while OFF');
 }finally{f.sql.close();}
});
test('RSS feed proxy serves sanitized, cached records without re-fetching each request',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await admin(f);const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('<rss><channel><item><title>WASP &amp; Friends</title><description>New album</description><link>https://example.com/story</link></item></channel></rss>',{status:200,headers:{'content-type':'application/rss+xml'}})};
 try{
  const saved=(await f.api('/api/admin/rss','PUT',{enabled:true,position:'left',tabs:[{title:'WASP News',code:'https://feeds.example.com/rss'}]},token)).body;
  const path='/api/rss/feed/'+saved.tabs[0].id;
  const first=await f.api(path),second=await f.api(path);
  assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.items[0].title,'WASP & Friends');assert.equal(second.status,200);assert.equal(calls,1,'RSS should use cached feed');
 }finally{globalThis.fetch=old;f.sql.close();}
});
test('matching uniquely resolves title and artist, rejects ambiguous editions and unrelated titles',()=>{
 const item={title:'Wonderful Song',artists:['Artist A'],duration:180};
 const same={id:'a',title:'Wonderful Song',artist:'Artist A',duration:181};
 assert.equal(autoRecreateMatch(item,[same],[]).match.id,'a');
 assert.equal(autoRecreateMatch(item,[same,{...same,id:'b'}],[]).match,null);
 assert.equal(autoRecreateMatch(item,[{...same,title:'Different Song'}],[]).match,null);
 assert.equal(recreateCandidates(item,[],[{...same,origin:'https://peer.example',remote_id:'remote'}])[0].source,'peer');
});
test('album recreated from HIVE tracks, resuming and finishing drafts preserves audio and supports fresh recreation',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await admin(f),old=globalThis.fetch;
 globalThis.fetch=async url=>{const u=String(url);if(u.endsWith('/album/12345'))return Response.json(fakeAlbum);throw Error('Unexpected '+u)};
 f.sql.prepare('INSERT INTO tracks(id,title,artist,album,track_no,duration,created_at) VALUES(?,?,?,?,?,?,?)').run('existing','One Thing','Artist A','Old Album',8,210,Date.now());
 const peerId=crypto.randomUUID();f.sql.prepare('INSERT INTO peers(id,url,name,added_at,last_error) VALUES(?,?,?,?,?)').run(peerId,'https://peer.example','Other HIVE',Date.now(),null);
 f.sql.prepare('INSERT INTO peer_catalogue_chunks(peer_id,kind,shard,body) VALUES(?,?,?,?)').run(peerId,'tracks',0,JSON.stringify([{id:'remote',title:'Amazing Night',artist:'Artist B',duration:190}]));
 try{
  const created=await f.api('/api/admin/collection-drafts','POST',{kind:'album',id:'12345'},token);
  assert.equal(created.status,201,JSON.stringify(created));const id=created.body.id;
  const scan=await f.api('/api/admin/collection-drafts/'+id+'/automatch','POST',{offset:0,limit:3},token);
  assert.equal(scan.status,200,JSON.stringify(scan));assert.equal(scan.body.matched,2);assert.equal(scan.body.remaining,1);
  assert.equal(f.sql.prepare('SELECT artist,album FROM tracks WHERE id=?').get('existing').artist,'Artist A');
  assert.equal(f.sql.prepare('SELECT album FROM tracks WHERE id=?').get('existing').album,'Compilation of Stars');
  assert.equal(f.sql.prepare('SELECT COUNT(*) c FROM recreated_album_peer_tracks').get().c,1);
  const list=await f.api('/api/recreated-album-tracks');assert.equal(list.status,200);assert.equal(list.body[0].origin,'https://peer.example');
  const done=await f.api('/api/admin/collection-drafts/'+id+'/done','POST',{},token);assert.equal(done.status,200);assert.equal(done.body.preserved_audio,true);
  const pending=await f.api('/api/admin/collection-drafts','GET',undefined,token);assert.equal(pending.body.items.length,0);
  const recreated=await f.api('/api/admin/collection-drafts','POST',{kind:'album',id:'12345'},token);
  assert.equal(recreated.status,201);assert.notEqual(recreated.body.id,id,'Done must allow recreating the source again');
 }finally{globalThis.fetch=old;f.sql.close();}
});
