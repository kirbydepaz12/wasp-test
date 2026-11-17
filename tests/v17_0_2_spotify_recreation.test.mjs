import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
function fixture(){
  const sql=new DatabaseSync(':memory:');
  class Q{constructor(query,args=[]){this.query=query;this.args=args}bind(...args){return new Q(this.query,args)}async first(){return sql.prepare(this.query).get(...this.args)||null}async all(){return {results:sql.prepare(this.query).all(...this.args)}}async run(){const r=sql.prepare(this.query).run(...this.args);return {meta:{changes:r.changes}}}}
  const DB={prepare:s=>new Q(s),batch:async st=>{sql.exec('BEGIN');try{for(const q of st)await q.run();sql.exec('COMMIT')}catch(e){sql.exec('ROLLBACK');throw e}}};
  const saved=new Map(); const env={DB,ASSETS:{fetch:async()=>new Response('Missing',{status:404})},MUSIC:{put:async(k,b)=>saved.set(k,b),get:async k=>saved.get(k)||null,delete:async k=>saved.delete(k),list:async()=>({objects:[],truncated:false})}};
  const api=async(path,method='GET',payload,cookie='')=>{
    const response=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(cookie?{cookie}:{}),...(payload!==undefined?{'content-type':'application/json'}:{})},body:payload!==undefined?JSON.stringify(payload):undefined}),env,{});
    const body=await response.json().catch(()=>null);return {status:response.status,body,cookie:response.headers.get('set-cookie')?.split(';')[0]||''};
  };
  return {sql,api,env,saved};
}
const spotifyId='7LQWEN3CgFCE9Q2gZ5Q7Zv';
const originalFetch=globalThis.fetch;
test('Spotify playlist recreates private user playlist, links local+peer tracks, requests missing songs, and only owner finishes',async()=>{
  const {sql,api,saved}=fixture();
  globalThis.fetch=async(input)=>{
    const url=String(input);
    if(url.startsWith('https://open.spotify.com/oembed?'))return Response.json({title:'My Favorite Mix',thumbnail_url:'https://i.scdn.co/image/abc123'});
    if(url===`https://open.spotify.com/embed/playlist/${spotifyId}`){
      const data={entity:{name:'My Favorite Mix'},coverArt:{sources:[]},trackList:[
        {title:'Available Locally',subtitle:'The Band'},
        {title:'Remote Song',subtitle:'Another Band'},
        {title:'Missing Song',subtitle:'Missing Artist'}
      ]};
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`,{headers:{'content-type':'text/html'}});
    }
    if(url==='https://i.scdn.co/image/abc123')return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/jpeg'}});
    throw Error('Not available in test');
  };
  try {
    await api('/api/site');
    const register=await api('/api/register','POST',{username:'importer',password:'a-secure-pass-123',confirm:'a-secure-pass-123'});
    assert.equal(register.status,201,JSON.stringify(register.body));
    const login=await api('/api/login','POST',{id:'importer',password:'a-secure-pass-123'});
    assert.ok(login.cookie);
    sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('local-track','Available Locally','The Band','Album',Date.now());
    sql.prepare('INSERT INTO peers(id,url,name,added_at) VALUES(?,?,?,?)').run('remote-peer','https://remote.example','Remote',Date.now());
    sql.prepare('INSERT INTO peer_catalogue_chunks(peer_id,kind,shard,body) VALUES(?,?,?,?)')
      .run('remote-peer','tracks',0,JSON.stringify([{id:'remote-track',title:'Remote Song',artist:'Another Band',album:'Remote Album',cover_url:'https://remote.example/art/1'}]));
    const importReq=await api('/api/user/spotify-import','POST',{url:`https://open.spotify.com/playlist/${spotifyId}`},login.cookie);
    assert.equal(importReq.status,201,JSON.stringify(importReq.body));
    assert.equal(importReq.body.local,1);assert.equal(importReq.body.peer,1);assert.equal(importReq.body.missing,1);
    const playlist=sql.prepare('SELECT * FROM user_playlists WHERE id=?').get(importReq.body.playlist_id);
    assert.equal(playlist.is_public,0);assert.equal(playlist.name,'My Favorite Mix');
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM user_playlist_tracks WHERE playlist_id=?').get(playlist.id).n,2);
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM requests WHERE status='active'").get().n,1);
    assert.ok(saved.has('art/user-playlist/'+playlist.id));
    const doneEarly=await api(`/api/user/spotify-imports/${importReq.body.id}/complete`,'POST',{},login.cookie);
    assert.equal(doneEarly.status,409);
    sql.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)').run('later-track','Missing Song','Missing Artist','Album',Date.now());
    const refresh=await api(`/api/user/spotify-imports/${importReq.body.id}/refresh`,'POST',{},login.cookie);
    assert.equal(refresh.status,200,JSON.stringify(refresh.body));assert.equal(refresh.body.missing,0);
    const done=await api(`/api/user/spotify-imports/${importReq.body.id}/complete`,'POST',{},login.cookie);
    assert.equal(done.status,200,JSON.stringify(done.body));
    assert.equal(sql.prepare('SELECT state FROM spotify_user_imports WHERE id=?').get(importReq.body.id).state,'complete');
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM user_playlist_tracks WHERE playlist_id=?').get(playlist.id).n,3);
    assert.equal((await api('/api/user/spotify-imports')).status,401);
  }finally{globalThis.fetch=originalFetch;}
});
