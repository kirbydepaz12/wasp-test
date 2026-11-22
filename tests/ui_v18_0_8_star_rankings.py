"""In-memory Chromium coverage for Most starred navigation, ranking and rating controls.
No HTTP server or production API access required.
"""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

P=Path(__file__).resolve().parents[1]/'public'
html=(P/'index.html').read_text()
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda m:'<style>'+(P/'style.css').read_text()+'</style>',html)
html=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
bb=re.sub(r'^export function ','function ',(P/'sidebar-bbcode.js').read_text(),flags=re.M)
art=(P/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(P/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
builder=(P/'radio-builder.js').read_text().replace('export const ','const ').replace('export function ','function ')
app=re.sub(r'^import .*?;\n','',(P/'app.js').read_text(),flags=re.M)
# Replace iframe postMessage target for the test only; about:blank has an opaque
# origin and its postMessage targetOrigin is invalid, unlike production HTTPS.
app=app.replace("frame.src='/telemetry.html?v=18.0.8';", "frame.src='about:blank';")
app=app.replace('frame.contentWindow?.postMessage(', 'window.__receiveRankings(')
app=app.replace('frame.contentWindow.postMessage(', 'window.__receiveRankings(')
source='\n'.join((bb,art,radio,builder,app))

with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1380,390):
  p=browser.new_page(viewport={'width':width,'height':850});errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
  p.goto('about:blank');p.set_content(html);p.evaluate('location.hash="#stars"')
  p.evaluate(r'''()=>{
   window.__rankingMessages=[];window.__receiveRankings=(message)=>window.__rankingMessages.push(message);
   window.fetch=async(input,opt={})=>{
     const path=new URL(String(input),'https://wasp.test').pathname;
     let d={};
     if(path==='/api/catalog-version')d={revision:'1'};
     else if(path==='/api/tracks')d=[{id:'song1',title:'Arise',artist:'Sepultura',artists:['Sepultura'],album:'Arise',duration:189,created_at:1}];
     else if(path==='/api/playlists')d=[{id:'srv1',name:'Album Mix',tracks:['song1']}];
     else if(path==='/api/stars/rankings'){
       const type=new URL(String(input),'https://wasp.test').searchParams.get('type');
       d={items: type==='track'?[{key:'song1',score:9,votes:2,average:4.5}]:type==='artist'?[{key:'Sepultura',score:5,votes:1,average:5}]:[{key:'srv1',score:4,votes:1,average:4}]};
     }
     else if(path==='/api/site')d={name:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
     else if(path==='/api/me')d={authenticated:false};
     else if(path==='/api/stars/batch')d={items:[]};
     else if(path==='/api/entity-reactions')d={artist:{},playlist:{}};
     else if(['/api/track-reaction-counts','/api/network/peers','/api/peer-catalogue','/api/active-streams','/api/user-playlists','/api/user/peer-tracks','/api/recent-listens','/api/radio/top','/api/peer-plays'].includes(path))d=[];
     return Response.json(d);
   };
  }''')
  p.evaluate('(s)=>(0,eval)(s)',source)
  p.locator('#boot[hidden]').wait_for(timeout=20000)
  nav=p.locator('#nav .nav-item');hrefs=nav.evaluate_all('(nodes)=>nodes.map(n=>n.getAttribute("href"))')
  assert '#stars' in hrefs and hrefs.index('#stars')==hrefs.index('#hearts')+1,hrefs
  assert p.locator('#nav a[href="#stars"] img[src="/star.png"]').count()==1
  p.wait_for_function('window.__rankingMessages.some(m=>m.mode==="stars" && m.sub==="songs" && m.items.length>0)')
  msgs=p.evaluate('__rankingMessages.filter(m=>m.mode==="stars" && m.sub==="songs" && m.items.length>0)')
  assert msgs[-1]['items'][0]['title']=='Arise' and msgs[-1]['items'][0]['average']==4.5,msgs
  p.evaluate('location.hash="#stars/artists";window.dispatchEvent(new Event("hashchange"))')
  p.wait_for_function('window.__rankingMessages.some(m=>m.mode==="stars" && m.sub==="artists" && m.items.length>0)')
  p.evaluate('location.hash="#stars/playlists";window.dispatchEvent(new Event("hashchange"))')
  p.wait_for_function('window.__rankingMessages.some(m=>m.mode==="stars" && m.sub==="playlists" && m.items.length>0)')
  p.evaluate('location.hash="#artist/Sepultura";window.dispatchEvent(new Event("hashchange"))')
  p.locator('.rating-stars').first.wait_for(timeout=8000)
  assert p.locator('.rating-symbol').count()==0
  assert p.locator('.rating-stars').first.locator('[data-star-value]').count()==5
  p.evaluate('location.hash="#playlist/srv1";window.dispatchEvent(new Event("hashchange"))')
  p.locator('.playlist-ratings .rating-stars').first.wait_for(timeout=8000)
  assert p.locator('.playlist-ratings .rating-symbol').count()==0
  assert p.locator('.playlist-ratings .rate-star').count()==5
  p.evaluate('location.hash="#likes";window.dispatchEvent(new Event("hashchange"))')
  p.wait_for_function('location.hash==="#stars"')
  assert not [e for e in errors if "Failed to construct 'URL'" not in e],errors
  p.close();print(f'PASS most starred nav and 3 ranked categories, 5 unadorned voting stars ({width}px)',flush=True)
 # Verify the actual iframe ranking renderer independently in a same-document harness.
 p=browser.new_page();p.set_content('<main id="telemetryRoot"></main>')
 p.evaluate('(s)=>(0,eval)(s)',(P/'telemetry-view.js').read_text())
 p.evaluate("""()=>window.dispatchEvent(new MessageEvent('message',{origin:'null',source:window,data:{type:'wasp:telemetry-data',mode:'stars',sub:'songs',items:[{kind:'song',id:'song1',title:'Arise',subtitle:'Sepultura',score:9,average:4.5,votes:2,scoreLabel:'stars'}]}}))""")
 p.locator('.browse-tile').first.wait_for(timeout=5000)
 text=p.locator('.browse-tile').first.inner_text()
 assert '★ 9 stars' in text and '4.5/5' in text and '2 votes' in text,text
 print('PASS actual telemetry iframe ranking formatter',flush=True)
 p.close();browser.close()
