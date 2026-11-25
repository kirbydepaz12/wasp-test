import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {albumReactionKey,parseAlbumReactionKey} from '../public/album-reactions.mjs';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q {constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ss=>{sql.exec('BEGIN');try{const out=[];for(const s of ss)out.push(await s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{throw Error('Unexpected audio write')},delete:async()=>{throw Error('Unexpected audio delete')},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const api=async(path,method='GET',body,visitor='visitor-1234')=>{const response=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{'X-Visitor':visitor,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});return {status:response.status,data:await response.json().catch(()=>null)}};
 return {api,sql};
}
test('album identities normalize Unicode, keep name/artist scope and reject forged identities',()=>{
 const key=albumReactionKey(' Avengers  Assemble ',' Various  Artists ');
 assert.deepEqual(parseAlbumReactionKey(key),{album:'avengers assemble',artist:'various artists'});
 assert.equal(key,albumReactionKey('AVENGERS ASSEMBLE','various artists'));
 assert.notEqual(key,albumReactionKey('Avengers Assemble','Another Artist'));
 assert.equal(parseAlbumReactionKey('album:v1:["movie","wrong"]garbage'),null);
 assert.equal(parseAlbumReactionKey('album:v1:["movie",1]'),null);
});
test('album hearts and star votes persist separately from songs, support removal and rankings',async()=>{
 const f=fixture();try{
  await f.api('/api/tracks');
  f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('t1','Live to Rise','Soundgarden','Avengers Assemble',Date.now());
  f.sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('t2','I’m Alive','Shinedown','Avengers Assemble',Date.now());
  const key=albumReactionKey('Avengers Assemble','Various Artists');
  const send=async(on,visitor)=>f.api('/api/react-entity','POST',{type:'album',key,kind:'heart',on},visitor);
  assert.equal((await send(true,'visitor-1234')).status,200);
  assert.equal((await send(true,'visitor-5678')).status,200);
  assert.equal((await send(true,'visitor-1234')).data.hearts,2);
  assert.equal((await f.api('/api/entity-reactions')).data.album[key].hearts,2);
  assert.equal((await f.api('/api/entity-reactions')).data.artist[key],undefined);
  assert.equal((await f.api('/api/stars','POST',{type:'album',key,stars:5})).status,200);
  assert.equal((await f.api('/api/stars','POST',{type:'album',key,stars:4},'visitor-5678')).status,200);
  const ranks=(await f.api('/api/stars/rankings?type=album')).data.items;
  assert.deepEqual(ranks.map(x=>x.key),[key]);assert.equal(ranks[0].score,9);assert.equal(ranks[0].average,4.5);
  assert.equal((await f.api('/api/stars/batch','POST',{targets:[{type:'album',key}]})).data.items[0].mine,5);
  assert.equal((await f.api('/api/stars/rankings?type=artist')).data.items.length,0);
  assert.equal((await f.api('/api/stars','POST',{type:'album',key,stars:0})).status,200);
  assert.equal((await send(false,'visitor-1234')).status,200);
  assert.equal((await f.api('/api/entity-reactions')).data.album[key].hearts,1);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM tracks').get().n,2);
 }finally{f.sql.close()}
});
test('album votes are rejected for missing albums, untrusted peers and invalid keys',async()=>{
 const f=fixture();try{
  await f.api('/api/tracks');
  const key=albumReactionKey('Unknown Album','Various Artists');
  assert.equal((await f.api('/api/stars','POST',{type:'album',key,stars:5})).status,404);
  assert.equal((await f.api('/api/react-entity','POST',{type:'album',key,kind:'heart',on:true})).status,404);
  assert.equal((await f.api('/api/stars','POST',{type:'album',key:'album:v1:not-json',stars:5})).status,400);
  assert.equal((await f.api('/api/stars','POST',{type:'album',key,origin:'https://unknown.example',stars:5})).status,404);
  f.sql.prepare('INSERT INTO peers(id,url,name,added_at) VALUES(?,?,?,?)').run('peer1','https://peer.example','Peer',Date.now());
  assert.equal((await f.api('/api/stars','POST',{type:'album',key,origin:'https://peer.example',stars:5})).status,200);
  assert.equal((await f.api('/api/react-entity','POST',{type:'album',key,origin:'https://peer.example',kind:'heart',on:true})).status,200);
 }finally{f.sql.close()}
});
