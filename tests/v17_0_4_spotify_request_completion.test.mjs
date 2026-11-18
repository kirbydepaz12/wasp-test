import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
let instanceCounter=0;

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  let worker=null;const queries=[];
  class Query{constructor(sql,args=[]){this.sql=sql;this.args=args}bind(...args){return new Query(this.sql,args)}
    async first(){if(this.sql.includes('SUM(created_at > ?1')){const sql=this.sql.replaceAll('?1','?').replaceAll('?2','?').replaceAll('?3','?');return sqlite.prepare(sql).get(this.args[0],this.args[1],this.args[0],this.args[2])||null;}return sqlite.prepare(this.sql).get(...this.args)||null}
    async all(){return {results:sqlite.prepare(this.sql).all(...this.args)}}
    async run(){const r=sqlite.prepare(this.sql).run(...this.args);return {meta:{changes:r.changes}}}}
  const DB={prepare:sql=>{queries.push(sql);return new Query(sql);},batch:async stmts=>{
    sqlite.exec('BEGIN');try{for(const st of stmts)await st.run();sqlite.exec('COMMIT')}catch(e){sqlite.exec('ROLLBACK');throw e;}
  }};
  const images=new Map();const env={DB,ASSETS:{fetch:async()=>new Response('not found',{status:404})},
    MUSIC:{put:async(k,data)=>images.set(k,data),get:async k=>images.get(k)||null,delete:async k=>images.delete(k),list:async()=>({objects:[],truncated:false})}};
  const call=async(path,method='GET',body,cookie='',headers={})=>{
    const response=await worker.fetch(new Request('https://wasp.example'+path,{method,
      headers:{...(cookie?{cookie:'sid='+cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},
      body:body!==undefined?JSON.stringify(body):undefined}),env,{});
    return {status:response.status,data:await response.json().catch(()=>null)};
  };
  const init=async()=>{
    worker=(await import('../src/index.js?fixture17_04='+ ++instanceCounter)).default;
    await call('/api/site');const token='test-admin-token';
    const h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))))
      .map(x=>x.toString(16).padStart(2,'0')).join('');
    sqlite.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(h,Date.now()+600000,'admin');
    return token;
  };
  return {sqlite,call,init,images,queries};
}
const playlistId='7LQWEN3CgFCE9Q2gZ5Q7Zv';
const playlistUrl=`https://open.spotify.com/playlist/${playlistId}`;
function mockSpotify({reportedCount,visible=50}={}){
  const original=globalThis.fetch;
  const tracks=Array.from({length:visible},(_,i)=>({title:`Song ${String(i+1).padStart(2,'0')}`,subtitle:'Test Artist'}));
  globalThis.fetch=async(input)=>{
    const u=String(input);
    if(u.startsWith('https://open.spotify.com/oembed?'))return Response.json({title:'Test Mix',thumbnail_url:'https://i.scdn.co/image/mock'});
    if(u===`https://open.spotify.com/embed/playlist/${playlistId}`){
      const entity={name:'Test Mix',...(reportedCount!==undefined?{trackCount:reportedCount}:{})};
      const state={entity,trackList:tracks,coverArt:{sources:[]}};
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script>`,{headers:{'content-type':'text/html'}});
    }
    if(u==='https://i.scdn.co/image/mock')return new Response(new Uint8Array([1,2,3,4]),{headers:{'content-type':'image/jpeg'}});
    throw Error('Unexpected network request '+u);
  };
  return ()=>{globalThis.fetch=original;};
}
function seedSongs(db,n){for(let i=1;i<=n;i++)db.prepare('INSERT INTO tracks(id,title,artist,album,created_at) VALUES(?,?,?,?,?)')
  .run(`local${i}`,`Song ${String(i).padStart(2,'0')}`,'Test Artist','Demo',Date.now())}
async function submit(f){const res=await f.call('/api/request','POST',{kind:'playlist',url:playlistUrl},'',{ 'X-Visitor':'visitor-test-1234567'});
  assert.equal(res.status,201,JSON.stringify(res.data));
  const row=f.sqlite.prepare("SELECT * FROM requests WHERE kind='playlist'").get();assert.ok(row);return row;}

for(const scenario of [
  {name:'verified 50-track playlist finishes normally',reportedCount:50,visible:50,expectedStatus:200,requiresAck:false},
  {name:'unknown 50-track source requires explicit admin acknowledgement',visible:50,expectedStatus:409,requiresAck:true},
  {name:'known 70-track playlist with only 50 entries cannot be overridden',reportedCount:70,visible:50,expectedStatus:409,requiresAck:false,knownIncomplete:true},
  {name:'unknown 100-track source requires acknowledgement',visible:100,expectedStatus:409,requiresAck:true},
])test(scenario.name,async()=>{
  const restore=mockSpotify(scenario);try{
    const f=fixture();const token=await f.init();seedSongs(f.sqlite,scenario.visible);
    const request=await submit(f);const meta=JSON.parse(request.meta);
    assert.equal(meta.total,scenario.visible);
    assert.equal(meta.source_total,scenario.reportedCount??null);
    assert.equal(meta.partial,scenario.reportedCount===50?false:true);
    const get=await f.call('/api/admin/requests','GET',undefined,token);
    assert.equal(get.status,200);assert.equal(get.data[0].matched,scenario.visible);
    const base=`/api/admin/requests/${request.id}/complete`;
    const regular=await f.call(base,'POST',undefined,token);
    assert.equal(regular.status,scenario.expectedStatus,JSON.stringify(regular.data));
    if(scenario.knownIncomplete){
      assert.equal(regular.data.code,'spotify_list_incomplete');
      const bypass=await f.call(base,'POST',{confirm_unverified:true},token);
      assert.equal(bypass.status,409);assert.equal(bypass.data.code,'spotify_list_incomplete');
      assert.equal(f.sqlite.prepare("SELECT status FROM requests WHERE id=?").get(request.id).status,'active');
      return;
    }
    if(scenario.requiresAck){
      assert.equal(regular.data.code,'spotify_list_unverified');
      assert.equal(f.sqlite.prepare("SELECT status FROM requests WHERE id=?").get(request.id).status,'active');
      const done=await f.call(base,'POST',{confirm_unverified:true},token);
      assert.equal(done.status,200,JSON.stringify(done.data));assert.equal(done.data.completed_unverified,true);
      const saved=JSON.parse(f.sqlite.prepare('SELECT meta FROM requests WHERE id=?').get(request.id).meta);
      assert.equal(saved.completed_unverified,true);assert.equal(saved.completed_retrieved,scenario.visible);
    }else assert.equal(regular.data.completed_unverified,false);
    const status=f.sqlite.prepare('SELECT status,playlist_id FROM requests WHERE id=?').get(request.id);
    assert.equal(status.status,'done');assert.ok(status.playlist_id);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM playlist_tracks WHERE playlist_id=?').get(status.playlist_id).n,scenario.visible);
    assert.equal((await f.call('/api/admin/requests','GET',undefined,token)).data.length,0);
    const history=await f.call('/api/requests/history','GET');
    assert.equal(history.status,200);
  }finally{restore();}
});

test('unverified override is refused while a retrieved song is still missing',async()=>{
  const restore=mockSpotify({visible:50});try{
    const f=fixture();const token=await f.init();seedSongs(f.sqlite,49);
    const request=await submit(f);
    const completed=await f.call(`/api/admin/requests/${request.id}/complete`,'POST',{confirm_unverified:true},token);
    assert.equal(completed.status,409);assert.match(completed.data.error,/1 Spotify songs are still missing/);
    assert.equal(f.sqlite.prepare('SELECT status FROM requests WHERE id=?').get(request.id).status,'active');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM playlists').get().n,0);
  }finally{restore();}
});

test('legacy 50-track partial requests remain finalizable with admin acknowledgement, no schema migration',async()=>{
  const restore=mockSpotify({visible:50});try{
    const f=fixture();const token=await f.init();seedSongs(f.sqlite,50);
    const id=crypto.randomUUID();const tracks=Array.from({length:50},(_,i)=>({t:`Song ${String(i+1).padStart(2,'0')}`,a:'Test Artist'}));
    f.sqlite.prepare('INSERT INTO requests(id,kind,title,artist,album,image,url,dedupe,voter,ip,created_at,status,meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,'playlist','Old Mix','','','','',`playlist|${playlistId}`,'voter','ip',Date.now(),'active',JSON.stringify({tracks,total:50,partial:true}));
    const attempt=await f.call(`/api/admin/requests/${id}/complete`,'POST',undefined,token);
    assert.equal(attempt.status,409);assert.equal(attempt.data.code,'spotify_list_unverified');
    const done=await f.call(`/api/admin/requests/${id}/complete`,'POST',{confirm_unverified:true},token);
    assert.equal(done.status,200,JSON.stringify(done.data));
    assert.equal(f.sqlite.prepare('SELECT status FROM requests WHERE id=?').get(id).status,'done');
  }finally{restore();}
});

// v17.0.5: queue page must use persisted availability and never load catalogues.
test('admin request queue reads cached availability, legacy items are pending, completion still verifies',async()=>{
 const restore=mockSpotify({reportedCount:50,visible:50});try{
 const f=fixture(),token=await f.init();seedSongs(f.sqlite,50);const request=await submit(f);
 f.queries.length=0;const cached=await f.call('/api/admin/requests','GET',undefined,token);assert.equal(cached.status,200);assert.equal(cached.data[0].matched,50);assert.ok(cached.data[0].availability_checked_at);
 assert.ok(!f.queries.some(q=>/FROM tracks|peer_catalogue_chunks/i.test(q)),f.queries.join('\n'));
 const meta=JSON.parse(request.meta);delete meta.matched_missing;delete meta.availability_checked_at;f.sqlite.prepare('UPDATE requests SET meta=? WHERE id=?').run(JSON.stringify(meta),request.id);
 const legacy=await f.call('/api/admin/requests','GET',undefined,token);assert.equal(legacy.data[0].matched,null);assert.equal(legacy.data[0].missing,null);
 f.sqlite.prepare('DELETE FROM tracks WHERE id=?').run('local1');
 const complete=await f.call(`/api/admin/requests/${request.id}/complete`,'POST',undefined,token);assert.equal(complete.status,409);assert.match(complete.data.error,/1 Spotify songs are still missing/);
 }finally{restore();}
});
