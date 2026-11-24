import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildArtistIndex } from '../public/artist-index.mjs';
import {artistsOf} from '../public/art.js';
const normalize = v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const make=(id,artists,origin='',created=0,alternates=[])=>({id,artists,title:id,created_at:created,origin,alternates,plays:2});

test('artist index counts groups once, includes local/peer alternate origins and first remote artwork origin',()=>{
 const list=[make('a',['A','B'],'',100,[{origin:'https://hive.example'}]),make('b',['B','C'],'https://peer.example',200),make('c',['A','A'],'',300)];
 const hidden=[make('remote-hidden',['A'],'https://another.example')];
 const index=buildArtistIndex(list,hidden,artistsOf,normalize);
 assert.equal(index.byName.get('A').songs,2);
 assert.equal(index.byName.get('A').id,'A'); // home carousel pickMix deduplication key
 assert.equal(index.byName.get('A').created,300);
 assert.equal(index.byName.get('A').plays,4);
 assert.deepEqual(index.alphabetical.map(i=>i.name),['A','B','C']);
 assert.deepEqual(index.newest.map(i=>i.name),['A','B','C']);
 assert.deepEqual(index.sources.get('a'),{local:true,peer:true});
 assert.deepEqual(index.sources.get('c'),{local:false,peer:true});
 assert.equal(index.coverOrigin.get('B'),'https://peer.example');
 assert.equal(index.coverOrigin.has('A'),false);
 assert.deepEqual(index.tracksByNormalized.get('a').map(t=>t.id),['a','c']);
});

test('artist index source flags cover deduplicated peer-only catalogues without creating extra display tiles',()=>{
 const index=buildArtistIndex([make('local',['Taylor, The Creator'])], [make('peer',['Taylor, The Creator'],'https://peer.example'),make('other',['Only on peer'],'https://peer.example')],artistsOf,normalize);
 assert.deepEqual(index.sources.get('taylor the creator'),{local:true,peer:true});
 assert.equal(index.byName.has('Only on peer'),false);
 assert.deepEqual(index.sources.get('only on peer'),{local:false,peer:true});
});

test('large HIVE catalogue indexes linearly with bounded artist count',()=>{
 const catalogue=Array.from({length:20000},(_,i)=>make('s'+i,['Artist '+i%1400, 'Collaborator '+i%300],i%3?'':'https://peer.example',i));
 const start=performance.now();const index=buildArtistIndex(catalogue,[],artistsOf,normalize);const elapsed=performance.now()-start;
 assert.equal(index.byName.size,1700);
 assert.equal(index.byName.get('Artist 42').songs,15);
 assert.equal(index.alphabetical.length,1700);
 // The functional result matters more than a brittle CI timing threshold.
 console.log('ARTIST_INDEX_BENCHMARK',JSON.stringify({tracks:catalogue.length,artists:index.byName.size,milliseconds:Math.round(elapsed)}));
});
