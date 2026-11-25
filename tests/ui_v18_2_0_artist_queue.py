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
 ('artist-discography.mjs',['buildArtistDiscography','artistPopularTracks','featuringArtistPlaylists']),
 ('queue-session.mjs',['QUEUE_KEY','makeQueueSnapshot','parseQueueSnapshot','recoverQueueSnapshot'])]:
 src=(P/filename).read_text().replace('export function ','function ').replace('export const ','const ')
 wrapper+='\n{'+src+'\n'+''.join('window.'+n+'='+n+';\n' for n in names)+'}\n'
# App source and modules execute in the same eval environment after the globals
# are installed. iframe telemetry navigation is intentionally outside this test.
album_mod=(P/'album-reactions.mjs').read_text().replace('export const ', 'const ').replace('export function ', 'function ')
bundle=album_mod+'\n'+bb+'\n'+art+'\n'+radio+'\n'+builder+'\n'+wrapper+'\n'+app+'''\nwindow.__queueInfo=()=>({queue:[...queue],qi,label:qLabel,current:audio.dataset.id,restored:queueRestored,route:playbackRoute?.resume||null});'''
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
  {id:'b',title:'Duality',artist:'Slipknot',artists:['Slipknot'],album:'Vol. 3',release_type:'album',release_year:2004,plays:64,duration:210,created_at:3,track_no:1},
  {id:'c',title:'Before I Forget',artist:'Slipknot',artists:['Slipknot'],album:'Vol. 3',release_type:'album',release_year:2004,plays:31,duration:200,created_at:3,track_no:2},
  {id:'d',title:'Psychosocial',artist:'Slipknot',artists:['Slipknot'],album:'All Hope Is Gone',release_type:'album',release_year:2008,plays:55,duration:230,created_at:4}];
 return Response.json(body);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1360,390):
  page=browser.new_page(viewport={'width':width,'height':900})
  errs=[];page.on('pageerror',lambda e:errs.append(str(e)))
  def launch(snapshot=None,hash='#artist/Slipknot'):
   page.goto('about:blank');page.set_content(html)
   page.evaluate('(s)=>window.__savedStore=s',__import__('json').dumps(snapshot or {}))
   page.evaluate('(s)=>(0,eval)(s)',mock)
   page.evaluate('(value)=>location.hash=value',hash)
   page.evaluate('(s)=>(0,eval)(s)',bundle)
   page.locator('#boot[hidden]').wait_for(timeout=20000)
  launch()
  page.wait_for_timeout(1100)
  page.screenshot(path=f'/mnt/data/WASP-v18.2.0-artist-{width}-preview.png',full_page=True)
  assert page.locator('.artist-popular-row').first.inner_text().find('Duality')>=0
  assert page.locator('.artist-release-tile').count()==3
  assert page.locator('.artist-featured .tile').count()==1
  page.locator('[data-artist-type="singles"]').click()
  assert page.locator('.artist-release-tile').count()==1
  page.locator('[data-artist-type="all"]').click()
  page.locator('[data-artist-display="list"]').click()
  assert page.locator('.artist-release-list-row').count()==3
  assert page.locator('.artist-release-songs .row').count()==4
  page.locator('a.artist-discography-all').click()
  assert '#artist/Slipknot/discography' in page.url
  page.locator('[data-artist-display="grid"]').click()
  page.evaluate('location.hash="#playlists"')
  page.evaluate("document.querySelector('[data-playpl=\"pl\"]').click()")
  page.evaluate("Object.defineProperty(document.querySelector('#audio'),'currentTime',{configurable:true,writable:true,value:23.5});document.querySelector('#audio').dispatchEvent(new Event('seeked'))")
  saved=page.evaluate("window.__storeMap['wasp:playback-session:v1820']")
  assert saved and len(__import__('json').loads(saved)['ids'])==3 and __import__('json').loads(saved)['position']==23.5,saved
  page.locator('#qbtn').click()
  snapshot=page.evaluate('window.__storeMap')
  assert snapshot['wasp:upnext-open:v1820']=='1'
  launch(snapshot,'#playlists')
  assert page.locator('#uplist .qrow').count()==2
  info=page.evaluate('window.__queueInfo()')
  assert info['restored'] and info['current']=='a' and info['qi']==0,info
  assert page.evaluate('window.__plays')==0,'Restoration must not autoplay'
  assert not page.locator('#upnext').evaluate('(e)=>e.classList.contains("hidden")')
  page.locator('#pp').click()
  assert page.evaluate('window.__plays')>=1
  assert page.evaluate('window.__queueInfo().route')==23.5,'Resume should seek to the saved position'
  assert not [e for e in errs if "Failed to construct 'URL'" not in e],errs[:6]
  print('PASS artist UI + simulated refresh-safe queue recovery',width)
  page.close()
 browser.close()
