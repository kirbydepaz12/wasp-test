"""Offline Chromium artist UI and simulated refreshed-tab state tests.
The sandbox restricts non-about:blank navigation; this validates equivalent
reinitialization with a copied sessionStorage map, not real network reload.
"""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
css=(P/'style.css').read_text()
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',f'<style>{css}</style>',(P/'index.html').read_text())
html=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
art=(P/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(P/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
bb=re.sub(r'^export function ', 'function ', (P/'sidebar-bbcode.js').read_text(), flags=re.M)
builder=(P/'radio-builder.js').read_text().replace('export const ','const ').replace('export function ','function ')
app=re.sub(r'^import .*?;\n','',(P/'app.js').read_text(),flags=re.M)
wrapper=''
for filename,names in [
 ('artist-index.mjs',['buildArtistIndex']),
 ('artist-discography.mjs',['buildArtistDiscography','expandArtistAlbumTracks','artistPopularTracks','featuringArtistPlaylists']),
 ('queue-session.mjs',['QUEUE_KEY','makeQueueSnapshot','parseQueueSnapshot','recoverQueueSnapshot'])]:
 src=(P/filename).read_text().replace('export function ','function ').replace('export const ','const ')
 wrapper+='\n{'+src+'\n'+''.join('window.'+n+'='+n+';\n' for n in names)+'}\n'
# App source and modules execute in the same eval environment after the globals
# are installed. iframe telemetry navigation is intentionally outside this test.
bundle=bb+'\n'+art+'\n'+radio+'\n'+builder+'\n'+wrapper+'\n'+app+'''\nwindow.__queueInfo=()=>({queue:[...queue],qi,label:qLabel,current:audio.dataset.id,restored:queueRestored,route:playbackRoute?.resume||null});'''
mock=r'''
window.__storeMap=JSON.parse(window.__savedStore||'{}');
Object.defineProperty(window,'sessionStorage',{configurable:true,value:{getItem:k=>window.__storeMap[k]??null,setItem:(k,v)=>window.__storeMap[k]=String(v),removeItem:k=>delete window.__storeMap[k]}});
window.__localMap={};
Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>window.__localMap[k]??null,setItem:(k,v)=>window.__localMap[k]=String(v),removeItem:k=>delete window.__localMap[k]}});
window.__plays=0;
HTMLMediaElement.prototype.play=function(){window.__plays++;this.dispatchEvent(new Event('play'));return Promise.resolve();};
HTMLMediaElement.prototype.pause=function(){this.dispatchEvent(new Event('pause'));};
window.fetch=async(input,opts={})=>{
 const p=new URL(String(input),'https://wasp.invalid').pathname;
 let body=[];
 if(p==='/api/me')body={authenticated:false};
 else if(p==='/api/site')body={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
 else if(p==='/api/bio')body={kind:'band',text:'A band with a long line-up.',source:'Wikipedia',url:'https://en.wikipedia.org/wiki/Test',members:Array.from({length:19},(_,i)=>({name:'Member '+(i+1),role:'Instrument '+(i+1),image:'',url:''}))};
 else if(p==='/api/lineup')body={members:Array.from({length:19},(_,i)=>({name:'Member '+(i+1),role:'Instrument '+(i+1),image:'',url:''}))};
 else if(p==='/api/similar')body={artists:Array.from({length:24},(_,i)=>({name:'Related Artist '+(i+1),image:''}))};
 else if(p==='/api/catalog-version')body={revision:'a'};
 else if(p==='/api/entity-reactions')body={};
 else if(p==='/api/peer-catalogue')body=[];
 else if(p==='/api/network/peers')body=[];
 else if(p==='/api/peer-reactions')body=[];
 else if(p==='/api/active-streams')body={listeners:0,songs:[]};
 else if(p==='/api/peer-plays')body=[];
 else if(p==='/api/playlists')body=[{id:'pl',name:'Slipknot HIVE',tracks:['a','b','c'],created_at:4}];
 else if(p==='/api/tracks')body=[
  {id:'a',title:'Arsenal',artist:'Slipknot',artists:['Slipknot'],album:'Arsenal',release_type:'single',release_year:2026,plays:1,duration:180,created_at:5},
  {id:'b',title:'Duality',artist:'Slipknot',artists:['Slipknot','Featured Artist'],album:'Vol. 3',release_type:'album',release_year:2004,plays:64,duration:210,created_at:3,track_no:1},
  {id:'c',title:'Before I Forget',artist:'Slipknot',artists:['Slipknot'],album:'Vol. 3',release_type:'album',release_year:2004,plays:31,duration:200,created_at:3,track_no:2},
  {id:'d',title:'Psychosocial',artist:'Slipknot',artists:['Slipknot'],album:'All Hope Is Gone',release_type:'album',release_year:2008,plays:55,duration:230,created_at:4}];
 return Response.json(body);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1360,768,390):
  page=browser.new_page(viewport={'width':width,'height':920})
  page.set_default_timeout(6000)
  print('START',width,flush=True)
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('about:blank');page.set_content(html)
  page.evaluate('(s)=>(0,eval)(s)',mock)
  page.evaluate('(hash)=>location.hash=hash','#artist/Slipknot')
  page.evaluate('(s)=>(0,eval)(s)',bundle)
  page.locator('#boot[hidden]').wait_for(timeout=20000)
  page.locator('[data-atab="lineup"]').wait_for(timeout=12000)
  page.locator('[data-atab="lineup"]').click()
  print('LINEUP',width,flush=True)
  assert page.locator('.artist-hero-lineup .simtile').count()==19,(width,page.locator('.artist-hero-lineup').inner_text())
  result=page.evaluate('''()=>{const hero=document.querySelector('.artist-hero-banner').getBoundingClientRect();const parts=[...document.querySelectorAll('.artist-hero-lineup .simtile')].map(e=>e.getBoundingClientRect());return {heroBottom:hero.bottom,lastBottom:Math.max(...parts.map(r=>r.bottom)),minLeft:Math.min(...parts.map(r=>r.left)),maxRight:Math.max(...parts.map(r=>r.right)),heroLeft:hero.left,heroRight:hero.right,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth}}''')
  assert result['lastBottom']<=result['heroBottom']+2,f'Lineup clipped vertically {width}: {result}'
  assert result['minLeft']>=result['heroLeft']-2 and result['maxRight']<=result['heroRight']+2,f'Lineup clipped horizontally {width}: {result}'
  page.locator('[data-atab="similar"]').click()
  assert page.locator('.artist-hero-similar .simtile').count()==10,(width,'Similar artists should show nine plus Show more')
  assert page.locator('.artist-similar-more').inner_text().find('Show more')>=0
  page.locator('.artist-similar-more').click()
  print('SHOWMORE',width,flush=True)
  page.wait_for_timeout(900)
  assert '#similar/Slipknot' in page.url
  assert page.locator('#list .grid .tile').count()==24,(width,page.locator('#list .grid .tile').count())
  page.evaluate('location.hash="#artist/Slipknot"')
  print('BACK',width,flush=True)
  page.locator('.artist-image-expand').wait_for()
  page.locator('.artist-image-expand').click()
  print('LIGHTBOX',width,flush=True)
  assert page.locator('dialog#artistPictureDialog[open]').count()==1,'Clicking image must open lightbox'
  page.mouse.click(2,400)
  print('CLOSED',width,flush=True)
  assert page.locator('dialog#artistPictureDialog[open]').count()==0,'Backdrop click must close lightbox'
  # Clicking a visible portion of the photo itself must also open the dialog,
  # not just its small expand control. Avoid the text and controls overlay.
  hero=page.locator('.artist-hero-banner').bounding_box()
  page.mouse.click(hero['x']+hero['width']*0.68,hero['y']+53)
  assert page.locator('dialog#artistPictureDialog[open]').count()==1,'Hero photograph direct click did not open lightbox'
  page.keyboard.press('Escape')
  assert page.locator('dialog#artistPictureDialog[open]').count()==0,'Escape must dismiss image dialog'
  page.locator('.artist-popular-row .artist-inline-link:visible').first.wait_for()
  assert page.locator('.artist-popular-row .artist-inline-link').count()>=2
  page.locator('[data-artist-link="Featured Artist"]:visible').first.click()
  print('ARTIST LINK',width,flush=True)
  assert '#artist/Featured%20Artist' in page.url,('Artist link failed',page.url)
  assert not [error for error in errors if "Failed to construct 'URL'" not in error],errors[:5]
  print('PASS artist hero desktop/tablet/mobile',width,'lineup 19 visible; similar Show more → 24 artists; picture lightbox closes; credited artist links')
  page.close()
 browser.close()
