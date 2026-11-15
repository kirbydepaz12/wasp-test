import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {legacyMd5, manageMobileBridge, handleMobileRest, readVirtualLibrary, protocolResponse} from '../src/mobile-bridge.js';

function fixture(){
  const db=new DatabaseSync(':memory:');
  for(const sql of [
    'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)',
    'CREATE TABLE user_accounts(id TEXT PRIMARY KEY,username TEXT)',
    'CREATE TABLE tracks(id TEXT PRIMARY KEY,title TEXT,artist TEXT,album TEXT,track_no INTEGER,duration REAL,size INTEGER,plays INTEGER,created_at INTEGER)',
    'CREATE TABLE peers(id TEXT PRIMARY KEY,url TEXT,added_at INTEGER)',
    'CREATE TABLE peer_catalogue_cache(peer_id TEXT PRIMARY KEY,synced_at INTEGER)',
    'CREATE TABLE peer_catalogue_chunks(peer_id TEXT,kind TEXT,shard INTEGER,body TEXT)',
    'CREATE TABLE user_playlists(id TEXT,user_id TEXT,name TEXT,is_public INTEGER,created_at INTEGER)',
    'CREATE TABLE user_playlist_tracks(playlist_id TEXT,track_id TEXT,added_at INTEGER)',
    'CREATE TABLE peer_track_refs(ref TEXT,origin TEXT,remote_id TEXT)',
    'CREATE TABLE user_song_reactions(user_id TEXT,track_id TEXT,kind TEXT)',
    'CREATE TABLE recent_listens(id TEXT,track_id TEXT,origin TEXT,remote_id TEXT,title TEXT,artist TEXT,album TEXT,played_at INTEGER)',
    'CREATE TABLE mobile_scrobble_events(credential_id TEXT,track_id TEXT,reported_at INTEGER,PRIMARY KEY(credential_id,track_id,reported_at))',
    'CREATE TABLE peer_listens(origin TEXT,remote_id TEXT,plays INTEGER,synced_plays INTEGER DEFAULT 0,PRIMARY KEY(origin,remote_id))',
  ])db.exec(sql);
  db.prepare('INSERT INTO user_accounts VALUES (?,?)').run('user1','listener');
  db.prepare('INSERT INTO tracks VALUES (?,?,?,?,?,?,?,?,?)').run('local01','Rose & Thorn','The Singers','The Album',1,213,123456,1,Date.now());
  db.prepare('INSERT INTO peers VALUES (?,?,?)').run('p1','https://v15.example.com',1);
  db.prepare('INSERT INTO peer_catalogue_cache VALUES (?,?)').run('p1',Date.now());
  db.prepare('INSERT INTO peer_catalogue_chunks VALUES (?,?,?,?)').run('p1','tracks',0,JSON.stringify([{id:'remote01',title:'Second Song',artist:'Remote Artists',album:'Another Album',duration:210,plays:12}]));
  db.prepare('INSERT INTO peer_catalogue_chunks VALUES (?,?,?,?)').run('p1','playlists',0,JSON.stringify([{id:'peerpl1',name:'Peer Playlist',tracks:['remote01']}]))

  db.prepare('INSERT INTO user_playlists VALUES (?,?,?,?,?)').run('playlist01','user1','My Songs',0,Date.now());
  db.prepare('INSERT INTO user_playlist_tracks VALUES (?,?,?)').run('playlist01','local01',Date.now());
  const DB={prepare(sql){let args=[];return {bind(...values){args=values;return this;},first(){return db.prepare(sql).get(...args)||null;},all(){return {results:db.prepare(sql).all(...args)};},run(){const x=db.prepare(sql).run(...args);return {meta:{changes:x.changes}};}};},batch(stmts){return stmts.map(x=>x.run());}};
  const env={DB};
  return {db,DB,env};
}
const data=async response=>response.json();
const endpoint=(method,params={},reqMethod='GET')=>{
  const url=new URL('https://stage.example.com/mobile/rest/'+method+'.view');
  for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
  return url;
};
async function enable(env){
  const r=await manageMobileBridge(new Request('https://stage.example.com/api/admin/mobile-bridge',{method:'PUT',headers:{'content-type':'application/json'},body:'{"enabled":true}'}),env,'admin');
  assert.equal((await data(r)).enabled,true);
}
async function provision(env){
  await enable(env);
  await manageMobileBridge(new Request('https://stage.example.com/api/admin/mobile-bridge/secret',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'generate'})}),env,'admin');
  const req=new Request('https://stage.example.com/api/user/mobile-keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'Test Phone'})});
  const res=await manageMobileBridge(req,env,'user','user1');
  assert.equal(res.status,201);return data(res);
}

// Web Crypto is available in Workers and Node 22.
test('MD5 legacy app-secret token uses Subsonic salt algorithm',()=>{
  assert.equal(legacyMd5('sesamec19b2d'),'26719a1196d2a940705a59634eb18eab');
  assert.equal(legacyMd5(''),'d41d8cd98f00b204e9800998ecf8427e');
});
test('mobile bridge starts disabled and does not reveal data without enabling',async()=>{
  const {env}=fixture();
  const res=await handleMobileRest(new Request(endpoint('ping',{apiKey:'anything',f:'json'})),env,endpoint('ping',{apiKey:'anything',f:'json'}));
  assert.equal(res.status,503);
  assert.equal((await data(await manageMobileBridge(new Request('https://stage.example.com/api/admin/mobile-bridge'),env,'admin'))).enabled,false);
});
test('key creation, API key authentication, XML, POST, legacy password and salted MD5',async()=>{
  const {env}=fixture();const key=await provision(env);
  assert.match(key.secret,/^wm_[a-f0-9]{64}$/);
  const url=endpoint('ping',{apiKey:key.secret,f:'json',v:'1.16.1',c:'Test'});
  assert.equal((await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'].status,'ok');
  const xmlUrl=endpoint('ping',{apiKey:key.secret});
  const xml=await(await handleMobileRest(new Request(xmlUrl),env,xmlUrl)).text();
  assert.match(xml,/<subsonic-response status="ok"/);
  const salt='myR4nd0mSalt';const md5=legacyMd5(key.secret+salt);
  const tokenUrl=endpoint('ping',{u:'listener',t:md5,s:salt,f:'json'});
  assert.equal((await data(await handleMobileRest(new Request(tokenUrl),env,tokenUrl)))['subsonic-response'].status,'ok');
  const legacyUrl=endpoint('ping',{u:'listener',p:'enc:'+Buffer.from(key.secret).toString('hex'),f:'json'});
  assert.equal((await data(await handleMobileRest(new Request(legacyUrl),env,legacyUrl)))['subsonic-response'].status,'ok');
  const formUrl=endpoint('ping',{f:'json'});
  const post=new Request(formUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({apiKey:key.secret,v:'1.16.1',c:'mobile-client'})});
  assert.equal((await data(await handleMobileRest(post,env,formUrl)))['subsonic-response'].status,'ok');
  const fail=endpoint('ping',{apiKey:'invalid',f:'json'});
  const error=(await data(await handleMobileRest(new Request(fail),env,fail)))['subsonic-response'];
  assert.equal(error.status,'failed');assert.equal(error.error.code,40);
  const extUrl=endpoint('getOpenSubsonicExtensions',{f:'json'});
  assert.deepEqual((await data(await handleMobileRest(new Request(extUrl),env,extUrl)))['subsonic-response'].openSubsonicExtensions[0],{name:'apiKeyAuthentication',versions:[1]});
});
test('catalogue contains local tracks and synced read-only v15 peer tracks',async()=>{
  const {env}=fixture();const lib=await readVirtualLibrary(env.DB);
  assert.deepEqual(lib.tracks.map(t=>t.id),['l:local01','p:p1:remote01']);
  assert.equal(lib.artists.size,2);assert.equal(lib.albums.size,2);
  const key=await provision(env);
  const p={apiKey:key.secret,f:'json'};
  let url=endpoint('search3',{...p,query:'Song'});
  let body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.searchResult3.song.length,1);assert.equal(body.searchResult3.song[0].id,'p:p1:remote01');
  url=endpoint('search3',{...p,query:'Thorn'});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.searchResult3.song.length,1);
  url=endpoint('getArtists',p);
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.artists.index.length,2);
  url=endpoint('getAlbumList2',p);
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.albumList2.album.length,2);
  url=endpoint('getAlbumList2',{...p,size:1,offset:1,type:'alphabeticalByName'});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.albumList2.album.length,1);
  assert.equal(body.albumList2.album[0].name,'The Album');
  url=endpoint('getMusicDirectory',{...p,id:'1'});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.directory.child.length,2);
  url=endpoint('getPlaylists',p);
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.playlists.playlist[0].name,'My Songs');
  assert.equal(body.playlists.playlist[1].name,'Peer Playlist');
  url=endpoint('getPlaylist',{...p,id:'vp:p1:peerpl1'});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.playlist.entry[0].id,'p:p1:remote01');
  url=endpoint('getPlaylist',{...p,id:'playlist01'});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.playlist.entry[0].title,'Rose & Thorn');
  const escaped=await protocolResponse({song:{title:'A&B <Music>'}}).text();
  assert.match(escaped,/title="A&amp;B &lt;Music&gt;"/);
});
test('peer range streaming forwards bytes but never mobile credentials or cookies',async()=>{
  const {env}=fixture();const {secret}=await provision(env);
  const original=globalThis.fetch;let peerRequest=null;
  globalThis.fetch=async (request,options)=>{
    peerRequest=new Request(request,options);
    return new Response(new Uint8Array([4,5,6]),{status:206,headers:{'content-type':'audio/mpeg','accept-ranges':'bytes','content-range':'bytes 0-2/100','content-length':'3'}});
  };
  try{
    let url=endpoint('stream',{apiKey:secret,id:'p:p1:remote01'});
    let res=await handleMobileRest(new Request(url,{headers:{range:'bytes=0-2',cookie:'session=should-not-forward'}}),env,url);
    assert.equal(res.status,206);assert.equal(res.headers.get('content-range'),'bytes 0-2/100');
    assert.equal(peerRequest.url,'https://v15.example.com/audio/remote01');
    assert.equal(peerRequest.headers.get('range'),'bytes=0-2');
    assert.equal(peerRequest.headers.get('cookie'),null);
    assert.equal(peerRequest.headers.get('authorization'),null);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())],[4,5,6]);
    url=endpoint('stream',{apiKey:secret,id:'l:local01'});
    res=await handleMobileRest(new Request(url,{redirect:'manual'}),env,url);
    assert.equal(res.status,307);assert.equal(res.headers.get('location'),'https://stage.example.com/audio/local01');
  }finally{globalThis.fetch=original;}
});
test('revocation blocks further API use; secret is never listed again',async()=>{
  const {env}=fixture();const key=await provision(env);
  const list=await data(await manageMobileBridge(new Request('https://stage.example.com/api/user/mobile-keys'),env,'user','user1'));
  assert.equal(list.keys.length,1);assert.equal(list.keys[0].secret,undefined);
  const r=await manageMobileBridge(new Request('https://stage.example.com/api/user/mobile-keys/'+key.id,{method:'DELETE'}),env,'user','user1');
  assert.equal((await data(r)).ok,true);
  const url=endpoint('ping',{apiKey:key.secret,f:'json'});
  assert.equal((await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'].status,'failed');
});
test('scrobble writes only staging data; does not write to upstream peer',async()=>{
  const {env,db}=fixture();const {secret}=await provision(env);
  let url=endpoint('scrobble',{apiKey:secret,id:'p:p1:remote01',submission:'false',f:'json'});
  await handleMobileRest(new Request(url),env,url);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_listens').get().n,0);
  url=endpoint('scrobble',{apiKey:secret,id:'p:p1:remote01',submission:'true',f:'json'});
  await handleMobileRest(new Request(url),env,url);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_listens').get().n,1);
  await handleMobileRest(new Request(url),env,url); // retry must not double count
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_listens').get().n,1);
  assert.equal(db.prepare('SELECT plays FROM peer_listens').get().plays,1);
});

async function secretAction(env,body){
  return manageMobileBridge(new Request('https://stage.example.com/api/admin/mobile-bridge/secret',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),env,'admin');
}
test('without a configured secret, members cannot generate keys even with mobile bridge enabled',async()=>{
  const {env,db}=fixture();await enable(env);
  const before=await data(await manageMobileBridge(new Request('https://stage.example.com/api/admin/mobile-bridge'),env,'admin'));
  assert.equal(before.secret_ready,false);assert.equal(before.secret_source,'none');
  const list=await data(await manageMobileBridge(new Request('https://stage.example.com/api/user/mobile-keys'),env,'user','user1'));
  assert.equal(list.secret_ready,false);assert.equal(list.keys.length,0);
  const denied=await manageMobileBridge(new Request('https://stage.example.com/api/user/mobile-keys',{method:'POST',headers:{'content-type':'application/json'},body:'{"label":"My Phone"}'}),env,'user','user1');
  assert.equal(denied.status,503);
  assert.match((await data(denied)).error,/setup required/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mobile_bridge_keys').get().n,0);
});
test('administrator can generate or import a managed server secret; neither status endpoint returns its value',async()=>{
  const {env,db}=fixture();
  const invalid=await secretAction(env,{action:'import',secret:'password'.repeat(10)});
  assert.equal(invalid.status,400);
  const accepted=await secretAction(env,{action:'generate'});
  assert.equal(accepted.status,200);const status=await data(accepted);
  assert.equal(status.secret_ready,true);assert.equal(status.secret_source,'wasp');
  assert.equal(status.secret,undefined);
  const row=db.prepare("SELECT value FROM settings WHERE key='mobile_bridge_secret_v1'").get();
  assert.match(row.value,/^[a-f0-9]{64}$/);
  const duplicate=await secretAction(env,{action:'generate'});assert.equal(duplicate.status,409);
  const admin=await data(await manageMobileBridge(new Request('https://stage.example.com/api/admin/mobile-bridge'),env,'admin'));
  assert.equal(admin.secret,undefined);assert.equal(admin.secret_ready,true);
  const other=fixture();
  const imported=await secretAction(other.env,{action:'import',secret:'a'.repeat(64)});
  assert.equal(imported.status,200);assert.equal((await data(imported)).secret_source,'wasp');
});
test('reset requires exact confirmation and atomically revokes previous mobile keys',async()=>{
  const {env,db}=fixture();const {secret}=await provision(env);
  const denied=await secretAction(env,{action:'rotate',confirm:'reset'});
  assert.equal(denied.status,400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mobile_bridge_keys').get().n,1);
  const reset=await secretAction(env,{action:'rotate',confirm:'RESET'});
  assert.equal(reset.status,200);assert.equal((await data(reset)).revoked_all,true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mobile_bridge_keys').get().n,0);
  const url=endpoint('ping',{apiKey:secret,f:'json'});
  const result=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(result.status,'failed');
  const newer=await manageMobileBridge(new Request('https://stage.example.com/api/user/mobile-keys',{method:'POST',headers:{'content-type':'application/json'},body:'{"label":"Replacement phone"}'}),env,'user','user1');
  assert.equal(newer.status,201);
});
test('existing Docker and Cloudflare runtime secrets can migrate into D1 without invalidating mobile keys',async()=>{
  const {env,db}=fixture();env.MOBILE_BRIDGE_SECRET='migratable-legacy-secret-value-that-is-long-enough';
  const {secret}=await provision(env);
  // Provision generated a WASP secret in this fixture. Exercise a true older
  // configuration by dropping its managed setting and re-sealing as v16.0.0.
  db.prepare("DELETE FROM settings WHERE key='mobile_bridge_secret_v1'").run();
  db.prepare('DELETE FROM mobile_bridge_keys').run();
  const old=await manageMobileBridge(new Request('https://stage.example.com/api/user/mobile-keys',{method:'POST',headers:{'content-type':'application/json'},body:'{"label":"Old app"}'}),env,'user','user1');
  assert.equal(old.status,201);const oldKey=(await data(old)).secret;
  const result=await data(await secretAction(env,{action:'migrate'}));
  assert.equal(result.secret_source,'wasp');
  delete env.MOBILE_BRIDGE_SECRET;
  const salt='abc123';const url=endpoint('ping',{u:'listener',t:legacyMd5(oldKey+salt),s:salt,f:'json'});
  assert.equal((await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'].status,'ok');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mobile_bridge_keys').get().n,1);
});
