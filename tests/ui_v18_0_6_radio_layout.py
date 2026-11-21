"""v18.0.6 deterministic Chromium tests. No live servers or network required."""
from pathlib import Path
import re, json
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
def inline():
    s=(P/'index.html').read_text()
    s=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">', lambda m:'<style>'+(P/'style.css').read_text()+'</style>',s)
    return re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',s)
bb=re.sub(r'^export function ', 'function ', (P/'sidebar-bbcode.js').read_text(), flags=re.M)
art=(P/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(P/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
builder=(P/'radio-builder.js').read_text().replace('export const ','const ').replace('export function ','function ')
app=re.sub(r'^import .*?;\n','',(P/'app.js').read_text(),flags=re.M)
source='\n'.join([bb,art,radio,builder,app])
tracks=[
 {'id':'a','title':'Shut Up!','artist':'Simple Plan','artists':['Simple Plan'],'album':'Still Not Getting Any...','release_year':2004,'genre':'pop punk','duration':202,'created_at':10},
 {'id':'b','title':'Shut Up','artist':'Simple Plan','artists':['Simple Plan'],'album':'Live Version','release_year':2005,'genre':'pop punk','duration':203,'created_at':9},
 {'id':'c','title':'AFRAID TO DIE','artist':'P.O.D.','artists':['P.O.D.','Jinjer'],'album':'New','release_year':2024,'genre':'metal','duration':190,'created_at':8},
 {'id':'d','title':'80s Song','artist':'Creed','artists':['Creed'],'album':'Vintage','release_year':1985,'genre':'hard rock','duration':195,'created_at':7},
 {'id':'e','title':'Related Rock','artist':'Other','artists':['Other'],'album':'Other','release_year':1988,'genre':'hard rock','duration':196,'created_at':6},
 {'id':'f','title':'Unknown Year','artist':'Creed','artists':['Creed'],'album':'Mystery','release_year':0,'genre':'hard rock','duration':210,'created_at':5},
]
fixture=r'''(songs)=>{
 window.__fixture={songs,auth:false,posts:[],puts:[]};
 const pl={id:'myplaylist',name:'My List',is_public:false,tracks:['a','b','c'],created_at:1};
 window.fetch=async(input,opt={})=>{
 const raw=String(input),url=new URL(raw,'https://wasp.test');const key=url.pathname;
 let d=[],status=200;
 if(key==='/api/catalog-version') d={revision:'fixture-1'};
 else if(key==='/api/tracks') d=window.__fixture.songs;
 else if(key==='/api/playlists') d=[];
 else if(key==='/api/site') d={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
 else if(key==='/api/entity-reactions') d={artist:{},playlist:{}};
 else if(key==='/api/network/peers'||key==='/api/peer-catalogue') d=[];
 else if(key==='/api/user-playlists'||key==='/api/user/peer-tracks') d=[];
 else if(key==='/api/track-reaction-counts') d=[];
 else if(key==='/api/me') d={authenticated:window.__fixture.auth,role:window.__fixture.auth?'user':null,username:'fixture'};
 else if(key==='/api/user/playlists') d=window.__fixture.auth?[pl]:[];
 else if(key==='/api/genres') d={'Simple Plan':['pop punk'],'Creed':['hard rock'],'Other':['hard rock'],'P.O.D.':['metal'],'Jinjer':['metal']};
 else if(key==='/api/similar') d={artists:[{name:'Other'}]};
 else if(key==='/api/radio/top') d=[{name:'AFRAID TO DIE',artist:'P.O.D.',plays:90},{name:'Shut Up!',artist:'Simple Plan',plays:30},{name:'Unknown',artist:'Absent',plays:999}];
 else if(key==='/api/user/playlists/copy'&&opt.method==='POST') {window.__fixture.posts.push(JSON.parse(opt.body));d={id:'saved1',copied:window.__fixture.posts.at(-1).tracks.length,skipped:0};status=201;}
 else if(key==='/api/user/playlists/myplaylist/tracks'&&opt.method==='PUT') {window.__fixture.puts.push(JSON.parse(opt.body));d={ok:true};}
 else if(key==='/api/active-streams')d={sources:[]};
 else if(key==='/api/recent-listens')d=[];
 else if(key.startsWith('/api/'))d={};
 return Response.json(d,{status});
 };
}'''

def init(browser, route='#radio', user=False, width=1480):
 p=browser.new_page(viewport={'width':width,'height':900});errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
 p.goto('about:blank');p.set_content(inline());p.evaluate('(h)=>{location.hash=h}',route)
 p.evaluate(fixture,tracks);p.evaluate('(u)=>window.__fixture.auth=u',user)
 p.evaluate('(s)=>(0,eval)(s)',source)
 p.locator('#boot[hidden]').wait_for(timeout=25000)
 return p,errors

def route(p,hash):
 p.evaluate('(h)=>{location.hash=h;window.dispatchEvent(new Event("hashchange"))}',hash)


with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
 for width in (1480,390):
  p,errors=init(browser,width=width)
  p.locator('#radioGenerate').wait_for(timeout=15000)
  artist=p.locator('#radioArtist')
  assert not artist.get_attribute('list'),'Native datalist still enabled'
  artist.fill('cre')
  p.locator('#radioArtistSuggestions').wait_for(state='visible')
  options=p.locator('#radioArtistSuggestions [role=option]')
  assert options.count()>0 and options.count()<=8
  assert 'Creed' in options.all_text_contents()
  if width==1480:
   a=artist.bounding_box();b=p.locator('#radioArtistSuggestions').bounding_box()
   assert b['y']>=a['y']+a['height']-1 and abs(b['x']-a['x'])<2 and abs(b['width']-a['width'])<3,(a,b)
   p.screenshot(path='/mnt/data/WASP-v18.0.6-radio-artist-desktop.png',full_page=True)
  artist.press('ArrowDown');assert artist.get_attribute('aria-activedescendant')
  artist.press('Enter');assert artist.input_value()=='Creed',artist.input_value()
  assert p.locator('#radioArtistSuggestions').is_hidden()
  artist.fill('cr');artist.press('Escape');assert p.locator('#radioArtistSuggestions').is_hidden()
  # Desktop input alignment is measured on their actual form controls.
  p.locator('[data-radio-mode="decade"]').click();p.select_option('#radioCount','custom')
  for a,b in [('radioDecade','radioCount'),('radioDecade','radioCustom')]:
   x=p.locator('#'+a).bounding_box();y=p.locator('#'+b).bounding_box()
   if width==1480:assert abs(x['y']-y['y'])<3,(a,b,x,y)
  if width==1480:
   first=p.locator('#radioDecade').bounding_box();generate=p.locator('#radioGenerate').bounding_box()
   assert abs(first['y']-generate['y'])<3,(first,generate)
   p.screenshot(path='/mnt/data/WASP-v18.0.6-radio-decade-desktop.png',full_page=True)
  else:
   assert p.locator('#radioBuilder').bounding_box()['width']<=390
  # Genre chips instantly track checkboxes, and removing does not submit the form.
  p.locator('[data-radio-mode="genre"]').click()
  p.locator('input[name="radioGenre"][value="metal"]').check()
  p.locator('input[name="radioGenre"][value="hard rock"]').check()
  assert p.locator('#radioSelectedGenres [data-selected-genre]').count()==2
  assert p.locator('#radioSelectedGenres').is_visible()
  if width==1480:
   top=p.locator('.radio-modes').bounding_box();chips=p.locator('#radioSelectedGenres').bounding_box()
   assert abs(top['y']-chips['y'])<14,(top,chips)
   p.screenshot(path='/mnt/data/WASP-v18.0.6-radio-genres-desktop.png',full_page=True)
  p.locator('[data-selected-genre="metal"]').click()
  assert not p.locator('input[name="radioGenre"][value="metal"]').is_checked()
  assert p.locator('input[name="radioGenre"][value="hard rock"]').is_checked()
  assert p.locator('#radioSelectedGenres [data-selected-genre]').count()==1
  # Selecting genre remains consistent after switching tabs.
  p.locator('[data-radio-mode="decade"]').click();p.locator('[data-radio-mode="genre"]').click()
  assert p.locator('#radioSelectedGenres [data-selected-genre]').count()==1
  p.locator('[data-selected-genre="hard rock"]').click()
  assert p.locator('#radioSelectedGenres').is_hidden()
  # The existing playlist/player flow should still work after interacting with chips.
  p.locator('input[name="radioGenre"][value="metal"]').check()
  p.locator('#radioGenerate').click();p.locator('#radioOutput .track-detail-row').first.wait_for(timeout=15000)
  assert p.locator('#radioOutput .track-detail-row').count()==1
  assert not [e for e in errors if "Failed to construct 'URL'" not in e],errors
  p.close();print(f'PASS radio artist autocomplete, genre chips, aligned controls, and generation at {width}px',flush=True)
 browser.close()
