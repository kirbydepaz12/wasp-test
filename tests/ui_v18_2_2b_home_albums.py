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

# Extend the fixture with album vote APIs, preserving the standard music mocks.
bundle+='\nwindow.__albumChartRows=()=>telemetryRankRows(\"hearts\",\"albums\");'
mock += r"""
window.__albumActions=[];
const __fetchWaspBase=window.fetch;
window.fetch=async(input,opts={})=>{
 const url=new URL(String(input),'https://wasp.invalid'),p=url.pathname;
 const body=opts.body?JSON.parse(opts.body):{};
 if(p==='/api/react-entity'){window.__albumActions.push({p,body});return Response.json({hearts:1,likes:0,dislikes:0});}
 if(p==='/api/stars'){window.__albumActions.push({p,body});return Response.json({mine:body.stars,average:body.stars,votes:1});}
 if(p==='/api/tracks'){const rows=await (await __fetchWaspBase(input,opts)).json();return Response.json([...rows,{id:'av1',title:'Live to Rise',artist:'Soundgarden',artists:['Soundgarden'],album:'Avengers Assemble',duration:280,track_no:1},{id:'av2',title:'I’m Alive',artist:'Shinedown',artists:['Shinedown'],album:'Avengers Assemble',duration:220,track_no:2}]);}
 if(p==='/api/stars/batch')return Response.json({items:[]});
 if(p==='/api/stars/rankings')return Response.json({items:[]});
 return __fetchWaspBase(input,opts);
};
"""

with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1360,390):
  page=browser.new_page(viewport={'width':width,'height':900})
  page.set_default_timeout(12000)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('about:blank');page.set_content(html)
  page.evaluate('(s)=>(0,eval)(s)',mock)
  page.evaluate('(hash)=>location.hash=hash','#home')
  page.evaluate('(s)=>(0,eval)(s)',bundle+'\nwindow.__currentView=()=>view;')
  page.locator('#boot[hidden]').wait_for(timeout=25000)
  labels=page.locator('#list .hsec h2').all_text_contents()
  assert labels==['Artists','Albums','Songs','Playlists'],labels
  albums=page.locator('#list .hsec').nth(1)
  assert albums.locator('a.tile.sq').count()>=3,albums.inner_text()
  assert albums.locator('.simtile[href="#recent/albums"]').count()==1
  assert albums.locator('a.tile.sq').filter(has_text='Avengers Assemble').count()==1,('multi-artist grouping should create one album',albums.inner_text())
  assert albums.locator('a.tile.sq').filter(has_text='Avengers Assemble').first.get_attribute('href').startswith('#album/Various%20Artists/Avengers%20Assemble')
  assert 'Various Artists' in albums.inner_text()
  assert albums.locator('a.tile.sq').filter(has_text='Vol. 3').count()==1
  assert page.locator('#list .hsec').nth(2).locator('button.song').count()>=4
  assert page.locator('#list .hsec').nth(3).locator('.simtile').count()==1
  assert page.evaluate('window.__currentView().label')=='Home'
  # All tiles share the same home carousel and navigation behavior.
  albums.locator('a.tile.sq').filter(has_text='Avengers Assemble').click()
  page.locator('.hero h1').wait_for()
  assert page.locator('.hero h1').inner_text()=='Avengers Assemble'
  assert page.locator('#list .row').count()==2,'Different contributing artists must remain together'
  page.evaluate('location.hash="#home"')
  albums=page.locator('#list .hsec').nth(1)
  albums.locator('.simtile[href="#recent/albums"]').click()
  page.locator('#list .grid.s').wait_for()
  assert page.locator('#list .tile.sq').filter(has_text='Avengers Assemble').count()==1
  page.evaluate('location.hash="#home"')
  page.locator('#list .hsec').nth(1).wait_for()
  search=page.locator('#q');search.fill('Shinedown')
  page.wait_for_function('document.querySelectorAll("#list .hsec").length===4')
  page.wait_for_timeout(300)
  assert page.locator('#list .hsec').nth(1).locator('a.tile.sq').filter(has_text='Avengers Assemble').count()==1
  assert not [e for e in errors if "Failed to construct 'URL'" not in e],errors[:5]
  print('PASS /#home Albums carousel, grouped soundtrack, navigation, search, existing rails:',width)
  page.close()
 browser.close()
