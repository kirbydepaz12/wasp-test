"""Browser regression: album requests and playlist track-artwork picker."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
PUB=ROOT/'public'
style=(PUB/'style.css').read_text()
s=(PUB/'app.js').read_text()
cover_code=s[s.index('function albumCollage9(p) {'):s.index('// Resolve covers relative to the server')]
admin_code=re.sub(r'^import .*?;\n','',(PUB/'admin.js').read_text(),flags=re.M)
bb_code=re.sub(r'^export function ', 'function ', (PUB/'sidebar-bbcode.js').read_text(),flags=re.M)
admin_html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">','<style>'+style+'</style>',(PUB/'admin.html').read_text())
admin_html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',admin_html)
for width in [1440,390]:
 with sync_playwright() as p:
  b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox']);page=b.new_page(viewport={'width':width,'height':900});errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('dialog',lambda d:d.accept())
  page.goto('about:blank');page.set_content(admin_html);page.evaluate('location.hash="#requests"')
  page.evaluate(r'''()=>{
   window.__albumFixture={actions:[],requests:[{id:'album1',kind:'album',title:'High School Musical: The Musical: The Series (Original Soundtrack)',artist:'Cast',created_at:1,matched_local:0,matched_peer:0}]};
   window.fetch=async(input,opt={})=>{
    const url=new URL(String(input),'https://wasp.test'),k=url.pathname,body=opt.body?JSON.parse(opt.body):{};let d={};
    if(k==='/api/me')d={admin:true,authenticated:true,role:'admin'};
    else if(k==='/api/admin/version')d={version:'18.1.5d',label:'Album matching'};
    else if(k==='/api/admin/requests')d=__albumFixture.requests;
    else if(k.endsWith('/candidates'))d={searched:{local:3,peer:5},index:0,kind:'album',candidates:[
      {origin:'',album:'High School Musical: The Musical: The Series (Original Soundtrack)',title:'High School Musical: The Musical: The Series (Original Soundtrack)',artist:'Cast',track_count:3,score:100},
      {origin:'https://hive.example',album:'High School Musical: The Musical: The Series (Original Soundtrack)',title:'High School Musical: The Musical: The Series (Original Soundtrack)',artist:'Cast',track_count:5,score:100}]};
    else if(k.endsWith('/match')){__albumFixture.actions.push(body);d={ok:true,kind:'album',status:'active',confirmed_album:{album:body.album,origin:body.origin,track_count:5}};if(body.action==='accept'){__albumFixture.requests[0].confirmed_album=d.confirmed_album;}}
    else if(k==='/api/admin/network')d={share:true,peers:[]};
    else if(k==='/api/admin/telemetry/metadata')d={runtime:'docker',preferred:'musicbrainz',musicbrainz:true,coverage:{total:1}};
    else if(k==='/api/admin/telemetry/metadata/status')d={runtime:'docker',scan:{state:'idle'}};
    else if(k==='/api/admin/telemetry/metadata/offline-status')d={installed:{version:'demo'},state:'ready',active:false,freeBytes:20000000000};
    else if(k==='/api/site')d={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
    else if(k==='/api/admin/tracks'||k==='/api/admin/playlists')d=[];
    return Response.json(d);
   };
  }''')
  page.evaluate('(code)=>(0,eval)(code)',bb_code+'\n'+admin_code)
  page.locator('tr[data-r="album1"] [data-a="album-scan"]').click()
  page.locator('tr[data-d="album1"] .req-candidate').first.wait_for(timeout=12000)
  assert page.locator('tr[data-d="album1"] .req-candidate').count()==2
  assert 'HIVE peer' in page.locator('tr[data-d="album1"] .req-candidate').last.inner_text()
  page.locator('tr[data-d="album1"] .req-candidate').last.locator('[data-a="match-accept"]').click()
  page.wait_for_function('__albumFixture.actions.some(x=>x.action==="accept"&&x.origin==="https://hive.example"&&x.album)')
  assert page.locator('tr[data-r="album1"]').count()==1,'Album must not auto-complete'
  assert page.locator('tr[data-d="album1"]').inner_text().find('Confirmed album candidate')>=0
  assert not errors,errors
  page.close();b.close()
 print(f'PASS album request search and manual confirmation at {width}px')
 with sync_playwright() as p:
  b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox']);page=b.new_page(viewport={'width':width,'height':900});errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content('<style>'+style+'</style><base href="https://wasp.test/"><div id="root"></div>')
  js=r'''const byId={"a":{"id":"a","title":"My Song","artist":"The Band","album":"Release"},"b":{"id":"b","title":"Other Song","artist":"Singer","album":"Other"}};
   const peerTrackLookup=new Map();const enc=encodeURIComponent;
   const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   const albumArt=t=>'/art/album?artist='+encodeURIComponent(t.artist)+'&album='+encodeURIComponent(t.album);
   const albumName=t=>t.album||'';const playlistCoverUrl=p=>p.cover_url||'';
   window.__coverCalls=[];const load=async()=>{};const render=()=>{};const popup=()=>{};
   window.fetch=async(url,opts={})=>{
    const path=String(url);if(path.startsWith('/art/'))return new Response(new Uint8Array([137,80,78,71,13,10,26,10,0,0]),{status:200,headers:{'content-type':'image/png'}});
    __coverCalls.push({url:path,method:opts.method,type:opts.headers?.['content-type']||'',body:opts.body instanceof Blob?'blob':JSON.parse(opts.body||'{}')});
    return Response.json({ok:true});
   };
  '''+cover_code
  page.add_script_tag(content=js)
  page.evaluate('openEditPlaylist({id:"pl",name:"Playlist",is_public:false,cover_mode:"mosaic",cover_url:"",tracks:["a","b"]})')
  page.locator('#chooseTrackCover').click()
  page.locator('#playlistCoverTrackChoices [data-cover-ref]').first.click()
  assert 'My Song' in page.locator('#playlistCoverTrackSelected').inner_text()
  page.locator('#savePlaylist').click()
  page.wait_for_function('__coverCalls.length===2')
  calls=page.evaluate('__coverCalls')
  assert calls[0]['url']=='/api/user/playlists/pl/cover' and calls[0]['body']=='blob',calls
  assert calls[1]['body']['cover_mode']=='copied',calls
  page.evaluate('openEditPlaylist({id:"pl",name:"Playlist",is_public:false,cover_mode:"copied",cover_url:"/art/user-playlist/pl",tracks:["a","b"]})')
  page.locator('#useAlbumGrid').click();page.locator('#savePlaylist').click()
  page.wait_for_function('__coverCalls.length===3');assert page.evaluate('__coverCalls[2].body.cover_mode')=='mosaic'
  assert not errors,errors
  page.close();b.close()
 print(f'PASS playlist cover picker and grid restoration at {width}px')
