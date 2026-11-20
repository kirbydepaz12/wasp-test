"""v18.0.5 deterministic Chromium tests. No live servers or network required."""
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
 browser=pw.chromium.launch(headless=True, executable_path='/usr/bin/chromium',args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
 p,errors=init(browser)
 p.locator('#radioGenerate').wait_for(timeout=15000)
 assert p.locator('#nav [href="#radio"]').count()==1
 nav=p.locator('#nav a').all_text_contents()
 assert nav.index('Playlists')<nav.index('Radio')<nav.index('Most hearted'),nav
 p.locator('[data-radio-mode="decade"]').click();p.select_option('#radioDecade','1980');p.select_option('#radioCount','50');p.locator('#radioGenerate').click()
 p.locator('#radioOutput .track-detail-row').first.wait_for(timeout=15000)
 assert p.locator('#radioOutput .track-detail-row').count()==2
 assert any('1985' in x for x in p.locator('#radioOutput .track-detail-row').all_text_contents())
 assert 'HIVE availability' in p.locator('#msgT').inner_text();p.locator('#msgOk').click()
 p.locator('#radioSave').click();assert p.locator('#signinRequiredDlg').is_visible();p.locator('#signinRequiredCancel').click()
 p.locator('[data-radio-mode="artist"]').click();p.fill('#radioArtist','Creed');p.select_option('#radioCount','30');p.locator('#radioGenerate').click()
 p.locator('#radioOutput .track-detail-row').first.wait_for();text=p.locator('#radioOutput .row .t').all_text_contents()
 assert any('80s Song' in t for t in text) and any('Related Rock' in t for t in text) and all('Shut Up' not in t for t in text),text
 p.locator('#msgOk').click()
 p.locator('[data-radio-mode="genre"]').click();p.locator('input[name="radioGenre"][value="metal"]').check();p.locator('#radioGenerate').click()
 assert p.locator('#radioOutput .track-detail-row').count()==1;p.locator('#msgOk').click()
 p.locator('[data-radio-mode="top"]').click();p.locator('#radioGenerate').click()
 p.wait_for_function('document.querySelector("#radioOutput .radio-result-head")?.textContent.includes("All-time top songs")',timeout=15000);assert p.locator('#radioOutput .track-detail-row').count()==2;p.locator('#msgOk').click();p.screenshot(path='/mnt/data/wasp_v18work/radio-preview.png',full_page=True)
 p.locator('#radioOutput .track-detail-row').first.click()
 assert 'P.O.D.' in p.locator('#pa').inner_text();p.locator('#pa').click()
 p.wait_for_function('location.hash==="#artists"');assert 'P.O.D., Jinjer' in p.locator('#q').input_value()
 p.wait_for_function('Array.from(document.querySelectorAll("#list a.tile")).filter(a=>a.getAttribute("href").startsWith("#artist/")).length>=2',timeout=10000)
 route(p,'#recent/albums');p.locator('#q').fill('Simple Plan, Creed')
 assert 'No albums yet' in p.locator('#list').inner_text() or 'Nothing matches' in p.locator('#list').inner_text()
 assert not [e for e in errors if "Failed to construct 'URL'" not in e],errors
 p.close();print('PASS anonymous Radio: navigation, decades, genre, similar artists, telemetry top, shortfall warning, registration prompt, multi-artist credit and Artists-only CSV search',flush=True)
 p,errors=init(browser,user=True)
 p.locator('[data-radio-mode="decade"]').click();p.select_option('#radioDecade','1980');p.locator('#radioGenerate').click()
 p.locator('#radioSave').wait_for(timeout=10000);p.locator('#msgOk').click();p.locator('#radioSave').click()
 p.wait_for_function('location.hash.startsWith("#userplaylist/saved1")',timeout=20000)
 assert p.evaluate('window.__fixture.posts.length')==1 and p.evaluate('window.__fixture.posts[0].tracks.length')==2
 p.locator('#msgOk').click();route(p,'#userplaylist/myplaylist');p.locator('#playlistDuplicateScan').wait_for(timeout=15000)
 p.locator('#playlistDuplicateScan').click();assert 'Possible duplicate tracks' in p.locator('#playlistDuplicatePanel').inner_text();p.screenshot(path='/mnt/data/wasp_v18work/playlist-duplicates-preview.png',full_page=True)
 p.locator('[data-dup-remove]').first.click();assert p.locator('#playlistCommit').is_visible()
 assert p.locator('#ownedTrackList .owned-track-line').count()==2
 p.locator('#playlistUndo').click();assert p.locator('#ownedTrackList .owned-track-line').count()==3
 p.locator('[data-dup-remove]').first.click();p.locator('#playlistCommit').click()
 p.wait_for_function('window.__fixture.puts.length===1')
 assert p.evaluate('window.__fixture.puts[0].tracks.length')==2
 assert not [e for e in errors if "Failed to construct 'URL'" not in e],errors;p.close();print('PASS signed-in Radio save and owned playlist review, stage, undo and commit',flush=True)
 p,errors=init(browser,width=390)
 p.locator('#radioGenerate').wait_for(timeout=10000)
 box=p.locator('#radioBuilder').bounding_box();assert box and box['width']<=390,box
 assert not [e for e in errors if "Failed to construct 'URL'" not in e],errors;p.close();browser.close()
 print('PASS mobile Radio width and all Chromium browser checks',flush=True)
