"""Browser test: preview overflow, live subtab 30 cap, uncapped listener count."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]/'public'
css=(ROOT/'style.css').read_text()
index=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',f'<style>{css}</style>',(ROOT/'index.html').read_text())
index=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',index)
art=(ROOT/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(ROOT/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
bb=re.sub(r'^export function ', 'function ', (ROOT/'sidebar-bbcode.js').read_text(), flags=re.M)
app_js=re.sub(r'^import .*?;\n','',(ROOT/'app.js').read_text(),count=3,flags=re.M)
bundle=bb+'\n'+art+'\n'+radio+'\n'+app_js
MOCK=r'''
window.__songCount=40;
window.__listenerCount=47;
window.__streamRows=Array.from({length:40},(_,i)=>({origin:'',track_id:'song'+i,started_at:1700000000000+i*1000,listeners:i===39?8:1}));
window.fetch=async(input,opts={})=>{
 const u=new URL(String(input),'https://wasp.invalid');
 const p=u.pathname;
 let body=[],status=200;
 if(p==='/api/me')body={authenticated:false};
 else if(p==='/api/site')body={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
 else if(p==='/api/catalog-version')body={revision:'a'};
 else if(p==='/api/tracks')body=Array.from({length:41},(_,i)=>({id:'song'+i,title:'Song '+i,artist:'Artist',album:'Album',duration:180,plays:1,created_at:1700000000000}));
 else if(p==='/api/recent-listens')body=Array.from({length:40},(_,i)=>({track_id:'song'+i,origin:'',remote_id:'',title:'Song '+i,artist:'Artist',album:'Album',played_at:Date.now()-i*60000,plays:1}));
 else if(p==='/api/active-streams')body={listener_count:window.__listenerCount,tracks:window.__streamRows.slice().sort((a,b)=>b.started_at-a.started_at).slice(0,30),keys:window.__streamRows.map(x=>({origin:x.origin,track_id:x.track_id}))};
 else if(['/api/network/peers','/api/requests','/api/playlists','/api/user-playlists'].includes(p))body=[];
 else if(['/api/peer-reactions','/api/entity-reactions'].includes(p))body={};
 else if(p==='/api/user/peer-tracks'){body={error:'none'};status=401;}
 return Response.json(body,{status});
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 p=browser.new_page(viewport={'width':1450,'height':870})
 errors=[];p.on('pageerror',lambda e: errors.append(str(e)))
 p.goto('about:blank');p.set_content(index)
 p.evaluate('(s)=>(0,eval)(s)',MOCK)
 p.evaluate('location.hash="#listened"')
 p.evaluate('(s)=>(0,eval)(s)',bundle)
 p.locator('.live-preview-grid').wait_for(timeout=20000)
 p.wait_for_function('document.querySelectorAll(".live-preview-grid .live-track").length>0')
 assert p.locator('#nav a[href="#request"]').count()==1,'Request remains public'
 assert p.locator('.listened-tabs a[aria-current=page]').inner_text()=='Recently listened'
 assert p.locator('.live-preview .live-track').count()<30
 assert p.locator('a.live-more-tile[href="#listened/streaming"]').count()==1
 assert p.locator('.recent-list-divider').count()==1
 assert p.locator('.recent-played-at').count()==40
 assert p.locator('.recent-streaming').count()==40,'history GIF covers songs not in top30'
 p.evaluate('window.__audioBefore=document.querySelector("#audio");window.__pauseCalls=0;document.querySelector("#audio").pause=()=>{window.__pauseCalls++;window.__pauseStack=new Error("pause").stack};void 0')
 p.locator('a.live-more-tile').click()
 p.wait_for_function('location.hash==="#listened/streaming"')
 p.locator('.live-full .live-track').first.wait_for(timeout=10000)
 assert p.locator('.live-full .live-track').count()==30
 assert p.locator('.live-full .live-track').first.locator('b').inner_text()=='Song 39'
 assert p.locator('.live-full .live-track').last.locator('b').inner_text()=='Song 10'
 assert p.locator('.live-listeners').inner_text()=='47'
 assert p.locator('.live-badge').inner_text()=='LIVE'
 assert p.locator('.live-more-tile').count()==0
 assert p.evaluate('document.querySelector("#audio")===window.__audioBefore && window.__pauseCalls===0')
 p.evaluate('window.__listenerCount=87;window.__streamRows.push({origin:"",track_id:"song40",started_at:1700000100000,listeners:1});refreshRecentListens()')
 p.wait_for_function('document.querySelector(".live-listeners")?.innerText.trim()==="87"')
 assert p.locator('.live-full .live-track').count()==30
 assert p.locator('.live-full .live-track').first.locator('b').inner_text()=='Song 40'
 # Query remains functional within the currently streaming subtab.
 p.locator('#q').fill('Song 40')
 assert p.locator('.live-full .live-track').count()==1
 p.locator('.listened-tabs a[href="#listened"]').click()
 p.locator('.recent-list-divider').wait_for(timeout=10000)
 assert p.locator('.live-preview .live-track').count()==1
 assert not [x for x in errors if 'Failed to construct' not in x],errors
 browser.close()
 print('PASS v15.0.9 UI: overflow first row, 30 most recent, red 47/87 listeners, old live indicators, public Request, uninterrupted audio')
