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
    'CREATE TABLE playlists(id TEXT,name TEXT,created_at INTEGER)',
    'CREATE TABLE playlist_tracks(playlist_id TEXT,track_id TEXT,added_at INTEGER)',
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
  db.prepare('INSERT INTO playlists VALUES (?,?,?)').run('server01','WASP server radio',Date.now());
  db.prepare('INSERT INTO playlist_tracks VALUES (?,?,?)').run('server01','local01',Date.now());
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
  assert.match(key.secret,/^[A-Z0-9]{8}$/);
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
  url=endpoint('getMusicFolders',p);
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.musicFolders.musicFolder.length,3);
  const localFolder=body.musicFolders.musicFolder.find(f=>f.id===2);
  assert.equal(localFolder.name,'This WASP server');
  const peerFolder=body.musicFolders.musicFolder.find(f=>f.name.includes('v15.example.com'));
  assert.ok(peerFolder);
  url=endpoint('getMusicDirectory',{...p,id:String(peerFolder.id)});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.directory.child.length,1);
  url=endpoint('getMusicDirectory',{...p,id:body.directory.child[0].id});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.directory.child.length,1);
  url=endpoint('getMusicDirectory',{...p,id:body.directory.child[0].id});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.directory.child.length,1);
  assert.equal(body.directory.child[0].title,'Second Song');
  url=endpoint('getPlaylists',p);
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.playlists.playlist.find(x=>x.id==='playlist01').name,'My Songs');
  assert.equal(body.playlists.playlist.find(x=>x.id==='sv:server01').name,'WASP server radio');
  assert.equal(body.playlists.playlist.find(x=>x.id==='vp:p1:peerpl1').name,'Peer Playlist');
  assert.equal(body.playlists.playlist.find(x=>x.id==='playlist01').songCount,1);
  assert.equal(body.playlists.playlist.find(x=>x.id==='sv:server01').songCount,1);
  url=endpoint('getPlaylist',{...p,id:'vp:p1:peerpl1'});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.playlist.entry[0].id,'p:p1:remote01');
  url=endpoint('getPlaylist',{...p,id:'sv:server01'});
  body=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(body.playlist.entry.length,1);
  assert.equal(body.playlist.entry[0].id,'l:local01');
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

// v16.0.2: one-hop discovery stays within the gateway's administrator-approved
// public peers, and playlist refs resolve to their actual remote origin.
import {syncFederatedFromGateway, publicPeerOrigin} from '../src/mobile-federation.js';
test('federation refuses private IP, HTTP, credentials, redirects and untrusted registries',async()=>{
  for(const input of ['http://peer.example.com','https://127.0.0.1','https://192.168.1.10','https://localhost',
    'https://host.local','https://user:pass@public.example.com','https://public.example.com/private',
    'https://public.example.com:8443','https://[::1]'])assert.equal(publicPeerOrigin(input),'',input);
  assert.equal(publicPeerOrigin('https://music.example.com'),'https://music.example.com');
  const {env}=fixture();const old=globalThis.fetch;
  globalThis.fetch=async()=>new Response('<html>Redirected</html>',{status:302,headers:{location:'http://127.0.0.1/api/tracks'}});
  try{
    const result=await syncFederatedFromGateway(env,{id:'p1',url:'https://v15.example.com'});
    assert.equal(result.sources,0);assert.ok(result.errors.length>0);
    assert.equal((await readVirtualLibrary(env.DB)).tracks.length,2);
  }finally{globalThis.fetch=old;}
});
test('one-hop gateway federation discovers remote catalogues, artists, genres and playlist tracks',async()=>{
  const {env}=fixture();const old=globalThis.fetch;
  const gateway='https://v15.example.com',a='https://music-a.example.net',b='https://music-b.example.org';
  const requests=[];
  const songA={id:'songA',title:'Northern Lights',artist:'Aurora Group',album:'The Horizon',genre:'Ambient',duration:240,track_no:2};
  const songB={id:'songB',title:'Moonlight Trail',artist:'Midnight Duo',album:'Blue Stars',duration:210,track_no:1};
  const publicPl={id:'public01',name:'Across The WASP Network',username:'creator',is_public:1,
    tracks:['songA','peer:sha256ref'],track_sources:{'peer:sha256ref':{origin:b,remote_id:'songB'}}};
  const replies=new Map([
    [gateway+'/api/peer',{ok:true}],
    [a+'/api/peer',{ok:true}],
    [gateway+'/api/network/peers',[
      {id:'alpha',url:a,online:true},{id:'beta',url:b,online:true},
      {id:'bad',url:'http://10.0.0.1:8080',online:true},
      {id:'community',url:'https://random.example.net',online:true,community:true}]],
    [gateway+'/api/peer-catalogue',[
      {origin:a,tracks:[songA],playlists:[],users:[publicPl]}]],
    [gateway+'/api/genres',{'Gateway Artist':['Pop']}],
    [a+'/api/genres',{'Aurora Group':['Ambient']}],
    [b+'/api/peer',{ok:true}],
    [b+'/api/tracks',[songB]],
    [b+'/api/playlists',[]],
    [b+'/api/user-playlists',[]],
    [b+'/api/genres',{'Midnight Duo':['Jazz']}],
  ]);
  globalThis.fetch=async (url,opts={})=>{
    const u=new URL(url);const key=u.origin+u.pathname;requests.push({url:key,opts});
    if(key===b+'/audio/songB')return new Response(new Uint8Array([7,8]),{status:206,headers:{'content-type':'audio/mpeg','content-range':'bytes 0-1/300','content-length':'2'}});
    if(!replies.has(key))return new Response('Not found',{status:404,headers:{'content-type':'text/plain'}});
    return new Response(JSON.stringify(replies.get(key)),{headers:{'content-type':'application/json'}});
  };
  try{
    const synced=await syncFederatedFromGateway(env,{id:'p1',url:gateway});
    assert.equal(synced.sources,2);assert.equal(synced.tracks,2);assert.equal(synced.playlists,1);
    assert.equal(synced.errors.length,0);
    assert.ok(!requests.some(x=>x.url.includes('10.0.0.1')||x.url.includes('random.example.net')));
    const lib=await readVirtualLibrary(env.DB);
    assert.equal(lib.tracks.length,4);assert.ok(lib.tracks.some(x=>x.title==='Moonlight Trail'));
    assert.ok([...lib.artists.values()].some(x=>x.name==='Midnight Duo'));
    const key=await provision(env);const auth={apiKey:key.secret,f:'json'};
    let url=endpoint('search3',{...auth,query:'moonlight'});
    let payload=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
    assert.equal(payload.searchResult3.song.length,1);
    const remoteId=payload.searchResult3.song[0].id;
    assert.match(remoteId,/^f:o:/);
    url=endpoint('getPlaylists',auth);
    payload=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
    const pl=payload.playlists.playlist.find(x=>x.name==='Across The WASP Network');
    assert.ok(pl);
    url=endpoint('getPlaylist',{...auth,id:pl.id});
    payload=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
    assert.deepEqual(payload.playlist.entry.map(x=>x.title),['Northern Lights','Moonlight Trail']);
    url=endpoint('getGenres',auth);
    payload=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
    assert.ok(payload.genres.genre.some(x=>x.value==='Ambient'));
    assert.ok(payload.genres.genre.some(x=>x.value==='Jazz'));
    url=endpoint('getSongsByGenre',{...auth,genre:'Jazz'});
    payload=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
    assert.deepEqual(payload.songsByGenre.song.map(x=>x.title),['Moonlight Trail']);
    url=endpoint('stream',{...auth,id:remoteId});
    let res=await handleMobileRest(new Request(url,{headers:{range:'bytes=0-1',cookie:'private=never'}}),env,url);
    assert.equal(res.status,206);assert.deepEqual([...new Uint8Array(await res.arrayBuffer())],[7,8]);
    const request=requests.find(x=>x.url===b+'/audio/songB');
    assert.ok(request);assert.equal(request.opts.headers.get('cookie'),null);
    assert.equal(request.opts.headers.get('authorization'),null);
    assert.equal(request.opts.headers.get('range'),'bytes=0-1');
  }finally{globalThis.fetch=old;}
});
test('federation deduplicates mirrored songs and preserves a fallback streaming source',async()=>{
  const {env}=fixture();const old=globalThis.fetch;
  const gateway='https://v15.example.com',a='https://mirror-a.example.net',b='https://mirror-b.example.net';
  const row={id:'same01',title:'Northern Sun',artist:'A Musician',album:'Album One',duration:120};
  const responses={
    [gateway+'/api/peer']:{ok:true},
    [a+'/api/peer']:{ok:true},
    [b+'/api/peer']:{ok:true},
    [gateway+'/api/network/peers']:[{url:a},{url:b}],
    [gateway+'/api/peer-catalogue']:[{origin:a,tracks:[row]},{origin:b,tracks:[row]}],
    [gateway+'/api/genres']:{},[a+'/api/genres']:{},[b+'/api/genres']:{},
  };
  const requested=[];let firstSource='';
  globalThis.fetch=async url=>{
    const u=new URL(url),key=u.origin+u.pathname;requested.push(key);
    if(key===firstSource+'/audio/same01')return new Response(null,{status:503});
    if([a+'/audio/same01',b+'/audio/same01'].includes(key))return new Response(new Uint8Array([1,2,3]),{status:206,headers:{'content-type':'audio/mpeg','content-range':'bytes 0-2/300'}});
    return responses[key] ? new Response(JSON.stringify(responses[key]),{headers:{'content-type':'application/json'}}):new Response('{}',{headers:{'content-type':'application/json'}});
  };
  try{
    await syncFederatedFromGateway(env,{id:'p1',url:gateway});
    const lib=await readVirtualLibrary(env.DB);
    assert.equal(lib.tracks.filter(x=>x.title==='Northern Sun').length,1);
    const song=lib.tracks.find(x=>x.title==='Northern Sun');assert.equal(song.alternatives.length,1);firstSource=song.origin;
    const {secret}=await provision(env);const url=endpoint('stream',{apiKey:secret,id:song.id});
    const response=await handleMobileRest(new Request(url),env,url);
    assert.equal(response.status,206);assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3]);
    assert.ok(requested.includes(a+'/audio/same01'));assert.ok(requested.includes(b+'/audio/same01'));
  }finally{globalThis.fetch=old;}
});

// v16.0.3: Short-key rate limiting and multi-source playlist visibility.
test('eight-character mobile secrets are random uppercase alphanumeric and blocked after repeated bad credentials',async()=>{
  const {env}=fixture();
  const original=await provision(env);
  assert.match(original.secret,/^[A-Z0-9]{8}$/);
  const secrets=new Set([original.secret]);
  for(let i=0;i<8;i++){
    const response=await manageMobileBridge(new Request('https://stage.example.com/api/user/mobile-keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'Device '+i})}),env,'user','user1');
    assert.equal(response.status,201);
    const key=(await data(response)).secret;
    assert.match(key,/^[A-Z0-9]{8}$/);assert.ok(!secrets.has(key));secrets.add(key);
  }
  const good=endpoint('ping',{u:'listener',p:original.secret,f:'json'});
  assert.equal((await data(await handleMobileRest(new Request(good),env,good)))['subsonic-response'].status,'ok');
  for(let i=0;i<12;i++){
    const bad=endpoint('ping',{u:'listener',p:'WRONGKEY',f:'json'});
    const result=(await data(await handleMobileRest(new Request(bad),env,bad)))['subsonic-response'];
    assert.equal(result.status,'failed');
  }
  const blocked=(await data(await handleMobileRest(new Request(good),env,good)))['subsonic-response'];
  assert.equal(blocked.status,'failed');
  assert.match(blocked.error.message,/too many failed/i);
});
test('server, public user and remote peer playlist contents resolve without leaking private playlists',async()=>{
  const {env,db}=fixture();
  db.prepare('INSERT INTO user_accounts VALUES (?,?)').run('user2','publicauthor');
  db.prepare('INSERT INTO user_playlists VALUES (?,?,?,?,?)').run('public01','user2','Community favorites',1,Date.now());
  db.prepare('INSERT INTO user_playlist_tracks VALUES (?,?,?)').run('public01','local01',Date.now());
  db.prepare('INSERT INTO user_playlists VALUES (?,?,?,?,?)').run('private02','user2','Secret private',0,Date.now());
  const {secret}=await provision(env);const p={apiKey:secret,f:'json'};
  let url=endpoint('getPlaylists',p);
  let result=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  const ids=result.playlists.playlist.map(x=>x.id);
  assert.ok(ids.includes('sv:server01'));assert.ok(ids.includes('public01'));assert.ok(ids.includes('playlist01'));
  assert.ok(ids.includes('vp:p1:peerpl1'));assert.ok(!ids.includes('private02'));
  assert.equal(result.playlists.playlist.find(x=>x.id==='public01').owner,'publicauthor');
  url=endpoint('getPlaylist',{...p,id:'public01'});
  result=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(result.playlist.songCount,1);
  url=endpoint('getPlaylist',{...p,id:'private02'});
  result=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(result.status,'failed');
});
test('mobile playlists resolve permitted cross-peer references and stream peer bytes, but discard unauthorized origins',async()=>{
  const {env,db}=fixture();
  db.prepare('INSERT INTO peer_track_refs VALUES (?,?,?)').run('peer:validref','https://v15.example.com','remote01');
  db.prepare('INSERT INTO user_playlist_tracks VALUES (?,?,?)').run('playlist01','peer:validref',Date.now()+1);
  db.prepare('INSERT INTO playlist_tracks VALUES (?,?,?)').run('server01','peer:validref',Date.now()+1);
  db.prepare('INSERT INTO peer_track_refs VALUES (?,?,?)').run('peer:private','http://192.168.1.12','hidden');
  db.prepare('INSERT INTO user_playlist_tracks VALUES (?,?,?)').run('playlist01','peer:private',Date.now()+2);
  const {secret}=await provision(env),p={apiKey:secret,f:'json'};
  for(const id of ['playlist01','sv:server01']){
    const url=endpoint('getPlaylist',{...p,id});
    const response=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
    assert.equal(response.playlist.songCount,2);
    assert.equal(response.playlist.entry[1].id,'p:p1:remote01');
  }
  const originalFetch=globalThis.fetch;let remoteUrl='';
  globalThis.fetch=async(input,init)=>{remoteUrl=String(input);return new Response('abc',{status:206,headers:{'content-type':'audio/mpeg','content-range':'bytes 0-2/100'}});};
  try{
    const url=endpoint('stream',{...p,id:'p:p1:remote01'});
    assert.equal((await handleMobileRest(new Request(url,{headers:{range:'bytes=0-2'}}),env,url)).status,206);
    assert.equal(remoteUrl,'https://v15.example.com/audio/remote01');
  }finally{globalThis.fetch=originalFetch;}
});

test('mobile auth throttle schema initializes when an existing installation has not opened account settings',async()=>{
  const {env,db}=fixture();const {secret}=await provision(env);
  db.prepare('DROP TABLE mobile_auth_limits').run();
  const url=endpoint('ping',{u:'listener',p:secret,f:'json'});
  const result=(await data(await handleMobileRest(new Request(url),env,url)))['subsonic-response'];
  assert.equal(result.status,'ok');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mobile_auth_limits'").get());
});
