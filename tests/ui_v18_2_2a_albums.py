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
  page.set_default_timeout(10000)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('about:blank');page.set_content(html)
  page.evaluate('(s)=>(0,eval)(s)',mock)
  page.evaluate('(hash)=>location.hash=hash','#artist/Slipknot')
  page.evaluate('(s)=>(0,eval)(s)',bundle)
  page.locator('#boot[hidden]').wait_for(timeout=20000)
  page.locator('.artist-release-tile').filter(has_text='Vol. 3').first.click()
  page.locator('.artist-release-expanded .album-rating').wait_for()
  assert page.locator('.artist-release-expanded .album-rating [data-ent="album"][data-r="heart"]').count()==1
  assert page.locator('.artist-release-expanded [data-star-type="album"] [data-star-value]').count()==5
  page.locator('.artist-release-expanded [data-ent="album"][data-r="heart"]').click()
  page.wait_for_function('window.__albumActions.some(x=>x.p==="/api/react-entity")')
  key=page.evaluate('window.__albumActions.find(x=>x.p==="/api/react-entity").body.key')
  assert key.startswith('album:v1:') and 'vol. 3' in key,key
  page.locator('.artist-release-expanded [data-star-value="4"]').click()
  page.wait_for_function('window.__albumActions.some(x=>x.p==="/api/stars")')
  assert page.evaluate('window.__albumActions.find(x=>x.p==="/api/stars").body.stars')==4
  page.locator('.artist-release-expanded [data-artist-release-play]').click()
  page.locator('#qbtn').click()
  page.locator('#uql a').wait_for()
  assert page.locator('#uql a').get_attribute('href').startswith('#album/Slipknot/Vol.'),page.locator('#uql a').get_attribute('href')
  page.locator('#uql a').click()
  page.locator('.album-page-actions .album-rating').wait_for()
  assert page.locator('.album-page-actions [data-star-type="album"] [data-star-value]').count()==5
  page.locator('#qbtn').click()
  page.evaluate('location.hash="#artist/Soundgarden"')
  page.locator('.artist-release-tile').first.click()
  page.locator('.artist-release-expanded [data-artist-release-play]').click()
  page.locator('#qbtn').click()
  assert page.locator('#uql a').get_attribute('href')=='#album/Soundgarden/Avengers%20Assemble'
  page.locator('#uql a').click()
  page.locator('.hero h1').wait_for()
  assert page.locator('#list .row').count()==2,('Album opened under current artist must include all soundtrack contributors', page.locator('#list').inner_text()[:350])
  page.evaluate('location.hash="#hearts/albums"')
  album_rows=page.evaluate('window.__albumChartRows()')
  assert len(album_rows)==1 and album_rows[0]['kind']=='album' and album_rows[0]['score']==1 and album_rows[0]['title']=='Vol. 3',album_rows
  assert page.locator('#subbar a').all_text_contents()==['Songs','Albums','Artists','Playlists']
  page.evaluate('location.hash="#stars/albums"')
  assert page.locator('#subbar a').all_text_contents()==['Songs','Albums','Artists','Playlists']
  assert not [e for e in errors if "Failed to construct 'URL'" not in e],errors[:4]
  print('PASS album hearts/stars in artist and album pages; release queue link; four ranking tabs:',width)
  page.close()
 browser.close()
