import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {parseFeed, safeFeedUrl} from '../src/rss-feeds.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 class Q{constructor(s,a=[]){this.s=s;this.a=a}bind(...a){return new Q(this.s,a)}async first(){return sql.prepare(this.s).get(...this.a)||null}async all(){return {results:sql.prepare(this.s).all(...this.a)}}async run(){return {meta:{changes:sql.prepare(this.s).run(...this.a).changes}}}}
 const DB={prepare:s=>new Q(s),batch:async ops=>{sql.exec('BEGIN');try{const results=[];for(const op of ops)results.push(await op.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,MUSIC:{get:async()=>null,put:async()=>{throw Error('unexpected audio writes')},delete:async()=>{throw Error('unexpected audio delete')},list:async()=>({objects:[]})},ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
 const api=async(path,method='GET',body,token='')=>{const res=await worker.fetch(new Request('https://wasp.test'+path,{method,headers:{...(token?{cookie:'sid='+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env,{waitUntil:()=>{}});return {status:res.status,body:await res.json().catch(()=>null),headers:res.headers}};
 return {sql,api};
}
async function admin(f){const token=crypto.randomUUID();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(b=>b.toString(16).padStart(2,'0')).join('');f.sql.prepare('INSERT INTO sessions(token,expires,role) VALUES(?,?,?)').run(hash,Date.now()+86400000,'admin');return token;}

test('RSS artwork comes from image media and HTML article content, not audio enclosures or embedded SVG',()=>{
 const xml=`<rss xmlns:media="http://search.yahoo.com/mrss/"><channel>
 <item><title>Media thumbnail</title><link>https://news.example/a</link><media:thumbnail height="320" url="https://images.example/art.jpg"/></item>
 <item><title>Image attachment</title><link>https://news.example/b</link><enclosure url="https://cdn.example/podcast.mp3" type="audio/mpeg"/><media:content medium="image" url="https://cdn.example/photo.webp" /></item>
 <item><title>HTML image</title><link>https://news.example/c</link><description><![CDATA[<p>Hello</p><img loading="lazy" src="https://news.example/cover.jpg"/>]]></description></item>
 <item><title>SVG not rendered</title><link>https://news.example/d</link><media:thumbnail url="https://news.example/tracker.svg"/></item>
 </channel></rss>`;
 const entries=parseFeed(xml).items;
 assert.deepEqual(entries.map(x=>x.image),['https://images.example/art.jpg','https://cdn.example/photo.webp','https://news.example/cover.jpg','']);
 assert.equal(entries[2].description.includes('Hello'),true);
 assert.equal(safeFeedUrl('https://127.0.0.1/rss'),null);
});

test('RSS optional title is stored, editable and hidden when blank; tab entries survive OFF',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await admin(f);
 try{
  const v=await f.api('/api/admin/rss','PUT',{enabled:true,heading:'Music news & events',position:'center',tabs:[{title:'Billboard',code:'https://example.org/feed'}]},token);
  assert.equal(v.status,200,JSON.stringify(v.body));assert.equal(v.body.heading,'Music news & events');
  assert.equal((await f.api('/api/rss')).body.heading,'Music news & events');
  assert.equal((await f.api('/api/site')).body.rss.heading,'Music news & events');
  assert.equal((await f.api('/api/admin/rss','PUT',{enabled:true,heading:'X'.repeat(81),position:'center',tabs:v.body.tabs},token)).status,400);
  const off=await f.api('/api/admin/rss','PUT',{enabled:false,heading:'',position:'right',tabs:v.body.tabs},token);
  assert.equal(off.status,200);assert.equal(off.body.heading,'');assert.equal((await f.api('/api/rss')).body.tabs.length,0);
  assert.equal((await f.api('/api/admin/rss','GET',undefined,token)).body.tabs.length,1);
 }finally{f.sql.close();}
});

test('RSS public refresh respects cooldown, authenticated refresh updates publisher cache, and media bytes are never touched',async()=>{
 const f=fixture();await f.api('/api/tracks');const token=await admin(f),original=globalThis.fetch;let fetches=0;
 globalThis.fetch=async()=>{fetches++;return new Response(`<rss><channel><item><title>Story ${fetches}</title><media:thumbnail url="https://news.example/${fetches}.jpg"/></item></channel></rss>`,{status:200,headers:{'content-type':'application/rss+xml'}})};
 try{
  const saved=(await f.api('/api/admin/rss','PUT',{enabled:true,position:'left',heading:'Headlines',tabs:[{title:'News',code:'https://example.org/rss'}]},token)).body;
  const id=saved.tabs[0].id,url='/api/rss/feed/'+id;
  assert.equal((await f.api(url)).body.items[0].title,'Story 1');
  const recent=await f.api(url+'?refresh=1');assert.equal(recent.body.refresh_throttled,true);assert.equal(fetches,1);
  assert.equal((await f.api('/api/admin/rss/refresh','POST',{id})).status,403,'only admin refreshes saved feed without public cooldown');
  f.sql.prepare('UPDATE rss_feed_cache SET fetched_at=? WHERE tab_id=?').run(Date.now()-65000,id);
  const refreshed=await f.api(url+'?refresh=1');assert.equal(refreshed.body.items[0].title,'Story 2');assert.equal(fetches,2);
  const adminSoon=await f.api('/api/admin/rss/refresh','POST',{id},token);assert.equal(adminSoon.body.refresh_throttled,true);assert.equal(fetches,2);
  f.sql.prepare('UPDATE rss_feed_cache SET fetched_at=? WHERE tab_id=?').run(Date.now()-15000,id);
  const adminForce=await f.api('/api/admin/rss/refresh','POST',{id},token);assert.equal(adminForce.status,200);assert.equal(adminForce.body.items[0].image,'https://news.example/3.jpg');assert.equal(fetches,3);
  assert.equal((await f.api(url)).body.items[0].title,'Story 3');assert.equal(fetches,3);
  assert.equal((await f.api('/api/admin/rss/refresh','POST',{id:'wrong'},token)).status,400);
 }finally{globalThis.fetch=original;f.sql.close();}
});
