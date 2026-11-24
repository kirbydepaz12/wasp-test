import test from 'node:test';
import assert from 'node:assert/strict';
import {buildArtistDiscography,artistPopularTracks,featuringArtistPlaylists} from '../public/artist-discography.mjs';
import {makeQueueSnapshot,parseQueueSnapshot,recoverQueueSnapshot} from '../public/queue-session.mjs';
const song=(id,album,year,plays=0,extra={})=>({id,title:'Song '+id,artists:['Slipknot'],artist:'Slipknot',album,release_year:year,created_at:Date.UTC(year||2020,1,1),plays,...extra});
test('HIVE popular tracks sort by actual plays and fall back to available catalogue songs',()=>{
 const list=[song('a','A',2022,0),song('b','B',2020,19),song('c','C',2025,5)];
 assert.deepEqual(artistPopularTracks(list).tracks.map(t=>t.id),['b','c','a']);
 assert.equal(artistPopularTracks(list).hasPlays,true);
 assert.equal(artistPopularTracks(list.map(x=>({...x,plays:0}))).hasPlays,false);
});
test('Discography groups releases, respects years, tag types and album-incomplete safety',()=>{
 const tracks=[song('one','We Are Not Your Kind',2019,9),song('two','We Are Not Your Kind',2019,2),
   song('new','Arsenal',2026,0,{release_type:'single'}),song('old','The End, So Far',2022,0,{release_type:'album'}),
   song('ep','Brand New EP',2024,0,{release_type:'ep'}),song('untagged','Missing Album',0,0)];
 const releases=buildArtistDiscography(tracks);
 assert.deepEqual(releases.slice(0,4).map(r=>r.name),['Arsenal','Brand New EP','The End, So Far','We Are Not Your Kind']);
 assert.equal(releases.find(r=>r.name==='Arsenal').kind,'single');
 assert.equal(releases.find(r=>r.name==='Brand New EP').kind,'single');
 assert.equal(releases.find(r=>r.name==='Missing Album').kind,'album');
 assert.equal(releases.find(r=>r.name==='We Are Not Your Kind').tracks.length,2);
});
test('Featuring playlists counts actual artist tracks across local and peer IDs without duplicates',()=>{
 const lookup={'l1':song('l1','A',2022),'https://peer.example|x':song('x','B',2025),'other':{id:'other',artists:['Elsewhere']}};
 const pls=[{id:'p1',name:'HIVE',tracks:['l1','other']},{id:'p2',name:'Peer',origin:'https://peer.example',tracks:['x']},{id:'p2',name:'Duplicate',tracks:['l1']},{id:'p3',name:'Unrelated',tracks:['other']}];
 const out=featuringArtistPlaylists('slipknot',pls,lookup,t=>t.artists);
 assert.deepEqual(out.map(x=>[x.playlist.id,x.count]),[['p1',1],['p2',1]]);
});
test('Playback snapshot saves ordered queue, same-tab position, repeat, shuffle and playlist scope',()=>{
 const now=Date.now();const payload={queue:['p|1','l2','p|1'],qi:2,qLabel:'Radio · Metal',playlistScope:{id:'a',name:'Playlist',ids:['p|1','l2']},ctxPl:'a',shufKind:'radio',repeat:2,left:1,counted:true,position:126.75};
 const saved=makeQueueSnapshot(payload,now);
 assert.equal(saved.position,126.75);assert.equal(saved.index,2);assert.equal(saved.scope.ids.length,2);
 const parsed=parseQueueSnapshot(JSON.stringify(saved),now+2500);
 const restored=recoverQueueSnapshot(parsed,{'p|1':{id:'p|1'},l2:{id:'l2'}});
 assert.deepEqual(restored.ids,['p|1','l2','p|1']);assert.equal(restored.index,2);assert.equal(restored.current,'p|1');assert.equal(restored.position,126.75);assert.equal(restored.counted,true);
 assert.equal(parseQueueSnapshot(JSON.stringify(saved),now+31*86400000),null);
});
test('Invalid or unavailable session data never invents tracks or starts playback',()=>{
 assert.equal(parseQueueSnapshot('{broken'),null);
 const snap=makeQueueSnapshot({queue:['gone','still'],qi:0,qLabel:'Radio',position:20});
 assert.equal(recoverQueueSnapshot(snap,{'still':{id:'still'}}).current,'still');
 assert.equal(recoverQueueSnapshot(snap,{'still':{id:'still'}}).position,0);
 assert.equal(recoverQueueSnapshot(snap,{}),null);
});
