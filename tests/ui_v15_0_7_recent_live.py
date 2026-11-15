"""Browser regression: public Request, relative listening times and live icon."""
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
window.__isLive=true;
window.__presence=[];
window.fetch=async(input,opts={})=>{
 const path=new URL(String(input),'https://wasp.invalid').pathname;
 let value=[],status=200;
 if(path==='/api/me')value={authenticated:false};
 else if(path==='/api/site')value={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
 else if(path==='/api/catalog-version')value={revision:'a'};
 else if(path==='/api/tracks')value=[{id:'song1',title:'Example song',artist:'Example singer',album:'Example album',duration:210,plays:4,created_at:1700000000000}];
 else if(path==='/api/recent-listens')value=[{track_id:'song1',origin:'',remote_id:'',title:'Example song',artist:'Example singer',album:'Example album',played_at:Date.now()-300000,plays:4}];
 else if(path==='/api/active-streams'){
    if(opts.method==='POST'){window.__presence.push(JSON.parse(opts.body));value={ok:true};}
    else value=window.__isLive?[{origin:'',track_id:'song1'}]:[];
 }
 else if(path==='/api/requests')value=[];
 else if(path==='/api/peer-reactions'||path==='/api/entity-reactions')value={};
 else if(path==='/api/user/peer-tracks'){value={error:'No tracks'};status=401;}
 return Response.json(value,{status});
};
'''
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  p=browser.new_page(viewport={'width':1410,'height':870})
  errors=[];p.on('pageerror',lambda e: errors.append(str(e)))
  p.goto('about:blank');p.set_content(index)
  p.evaluate('(s)=>(0,eval)(s)',MOCK)
  p.evaluate('location.hash="#listened"')
  p.evaluate('(s)=>(0,eval)(s)',bundle)
  row=p.locator('.recent-listen-meta');row.wait_for(timeout=16000)
  assert row.locator('time').inner_text()=='5 mins ago',row.inner_text()
  assert row.locator('.recent-streaming[aria-label="Streaming now"]').count()==1
  assert row.locator('img[src="/streaming.png"]').count()==1
  assert row.locator('.recent-streaming').evaluate('e=>getComputedStyle(e.querySelector("img")).animationName')=='wasp-live-pulse'
  assert p.locator('#nav a[href="#request"]').count()==1,'guests must have Request access'
  assert p.locator('#nav a[href="#settings"]').count()==0,'guests do not have Settings access'
  assert p.locator('#nav a[href="#request"]').get_attribute('href')=='#request'
  # Time labels update without reloading a music tile.
  p.evaluate('document.querySelector(".recent-played-at").dataset.playedAt=Date.now()-30*60000;updateRelativeListenTimes()')
  assert row.locator('time').inner_text()=='30 mins ago'
  # A song no longer being played must not show the headphones indicator.
  p.evaluate('window.__isLive=false;refreshRecentListens()')
  p.locator('.recent-streaming').wait_for(state='detached',timeout=10000)
  assert p.locator('.recent-played-at').count()==1
  # Simulate playback events; transport posts an ephemeral token, never a user ID.
  p.evaluate('''()=>{
    const el=document.querySelector('#audio');
    el.dataset.id='song1';
    Object.defineProperty(el,'currentSrc',{configurable:true,value:'https://wasp.invalid/audio/song1'});
    Object.defineProperty(el,'paused',{configurable:true,value:false});
    Object.defineProperty(el,'readyState',{configurable:true,value:3});
    el.dispatchEvent(new Event('playing'));
  }''')
  p.wait_for_function('window.__presence.some(x=>x.action==="playing")',timeout=10000)
  playing=p.evaluate('window.__presence.find(x=>x.action==="playing")')
  assert playing['track_id']=='song1' and playing['origin']==''
  assert 'username' not in playing and 'ip' not in playing and 'user_id' not in playing
  p.evaluate('''()=>{
    const el=document.querySelector('#audio');
    Object.defineProperty(el,'paused',{configurable:true,value:true});
    el.dispatchEvent(new Event('pause'));
  }''')
  p.wait_for_function('window.__presence.some(x=>x.action==="stop")',timeout=10000)
  assert not [e for e in errors if 'Failed to construct' not in e],errors
  browser.close()
  print('PASS v15.0.7 UI: Request public, relative time 5/30 mins, live icon, disappearance, anonymous playing/pause heartbeat')
