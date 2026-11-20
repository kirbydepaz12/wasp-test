import test from 'node:test';
import assert from 'node:assert/strict';
import {createRadioSelection,duplicateCandidates,artistSearchTokens,trackYear} from '../public/radio-builder.js';
const music=[
  {id:'a',title:'A',artists:['Creed'],year:1984,genre:'hard rock'},
  {id:'b',title:'B',artists:['Creed'],release_year:1985,genre:'alternative rock'},
  {id:'c',title:'C',artists:['Other'],year:1989,genre:'hard rock'},
  {id:'d',title:'D',artists:['Third'],year:2020,genre:'pop'},
  {id:'e',title:'E',artists:['Creed'],year:1983,peer_offline:true},
];
test('radio uses only known available decade songs and caps count',()=>{
  const r=createRadioSelection({tracks:music,mode:'decade',decade:1980,count:50,rnd:()=>.5});
  assert.deepEqual(new Set(r.ids),new Set(['a','b','c']));assert.equal(r.limited,true);
  assert.equal(createRadioSelection({tracks:music,mode:'decade',decade:1970,count:20}).ids.length,0);
});
test('genre mixes selected genres but no unrelated filler',()=>{
  const r=createRadioSelection({tracks:music,mode:'genre',selectedGenres:['hard rock'],count:30});assert.deepEqual(new Set(r.ids),new Set(['a','c']));
});
test('artist radio includes selected and similar artists and no unrelated tracks',()=>{
  const r=createRadioSelection({tracks:music,mode:'artist',artist:'Creed',similarArtists:['Other'],count:30});assert.deepEqual(new Set(r.ids),new Set(['a','b','c']));
});
test('top telemetry order preserved and missing songs not invented',()=>{
  const r=createRadioSelection({tracks:music,mode:'top',topTracks:[{name:'C',artist:'Other'},{name:'Nonexistent',artist:'None'},{name:'A',artist:'Creed'}],count:20});assert.deepEqual(r.ids,['c','a']);
});
test('duplicate suggestions require overlapping artists and similar title, never merge versions',()=>{
 const lib={a:{title:'Shut Up!',artist:'Simple Plan'},b:{title:'Shut Up',artists:['Simple Plan']},c:{title:'Shut Up (Live)',artist:'Simple Plan'},d:{title:'Shut Up',artist:'Different Band'},e:{title:'AFRAID TO DIE (feat. Jinjer)',artist:'P.O.D.'},f:{title:'AFRAID TO DIE',artists:['P.O.D.','Jinjer']}};
 assert.deepEqual(duplicateCandidates(['a','b','c','d','e','f'],lib),[[0,1],[4,5]]);
 assert.deepEqual(artistSearchTokens('P.O.D., Tatiana Shmayluk, Jinjer'),['P.O.D.','Tatiana Shmayluk','Jinjer']);
 assert.equal(trackYear({year:0}),0);
});
