import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const code=app.slice(app.indexOf('// The album name belongs to the release,'),app.indexOf('function artistPage(el, name) {'));
const sandbox={
  normalizeRecording:s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(),
  albumName:t=>t.album||'',artistsOf:t=>t.artists?.length?t.artists:[t.artist],primaryArtist:t=>t.artists?.[0]||t.artist,
  tracks:[],query:'',match:t=>true,latest:ts=>Math.max(...ts.map(t=>t.created_at||0)),
  noView:()=>{}, art:()=>'<img>',albumArt:()=>'',esc:s=>String(s),enc:encodeURIComponent,
  empty:x=>x,byTrack:(a,b)=>(a.track_no||0)-(b.track_no||0),actions:()=>'',
  plural:(n,w)=>`${n} ${w}s`,numLabel:()=>'',row:t=>`<li>${t.title}</li>`,view:null
};
vm.runInNewContext(code+'\nthis.__album={buildAlbums,albumGrid,albumPage}',sandbox);
const {buildAlbums,albumGrid,albumPage}=sandbox.__album;
test('Multi-artist soundtrack is a single album tile and opens with all performers',()=>{
  sandbox.tracks=[
    {title:'Song One',artist:'Dropkick Murphys',album:"Tony Hawk’s American Wasteland",created_at:5,track_no:1},
    {title:'Song Two',artist:'Alkaline Trio',album:"Tony Hawk's American Wasteland",created_at:4,track_no:2},
    {title:'Song Three',artist:'Hot Snakes',album:"Tony Hawks American Wasteland",created_at:3,track_no:3},
    {title:'Separate',artist:'Tool',album:'Lateralus',created_at:2,track_no:1},
  ];
  const grouped=buildAlbums(sandbox.tracks);
  assert.equal(grouped.length,2);
  assert.equal(grouped[0].tracks.length,3);
  assert.equal(grouped[0].artist,'Various Artists');
  const el={innerHTML:''};albumGrid(el);
  assert.equal((el.innerHTML.match(/Tony Hawk/g)||[]).length,1);
  const opened={innerHTML:''};albumPage(opened,'Various Artists',"Tony Hawk's American Wasteland");
  assert.match(opened.innerHTML,/Song One/);
  assert.match(opened.innerHTML,/Song Two/);
  assert.match(opened.innerHTML,/Song Three/);
});
test('Generic album titles stay artist-scoped to avoid unrelated releases merging',()=>{
 const songs=[{artist:'Band A',album:'Greatest Hits'},{artist:'Band B',album:'Greatest Hits'},
              {artist:'Band A',album:'Greatest Hits'}];
 const grouped=buildAlbums(songs);
 assert.equal(grouped.length,2);
 assert.deepEqual([...grouped.map(x=>x.tracks.length)].sort(),[1,2]);
});
