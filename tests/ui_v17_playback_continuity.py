"""Browser regression: v17 views never replace the playing main index audio element."""
from pathlib import Path
import re, io, wave, base64
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
css=(P/'style.css').read_text()
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',f'<style>{css}</style>',(P/'index.html').read_text())
html=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
art=(P/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(P/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
bb=re.sub(r'^export function ', 'function ', (P/'sidebar-bbcode.js').read_text(), flags=re.M)
app=re.sub(r'^import .*?;\n','',(P/'app.js').read_text(),count=3,flags=re.M)
# Remote iframe navigation is unavailable in sandboxed browser tests; this test
# checks the crucial parent audio lifecycle, not the iframe's networking.
app=app.replace("frame.src='/telemetry.html';", "frame.src='about:blank';")
app=app.replace("},location.origin);", "},'*');")
bundle=bb+'\n'+art+'\n'+radio+'\n'+app
mock=r'''
window.__accountHTML = '';
window.fetch=async(input,opts={})=>{
 const p=new URL(String(input),'https://wasp.invalid').pathname;
 let body=[],status=200;
 if(p==='/api/me')body={authenticated:false};
 else if(p==='/api/site')body={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
 else if(p==='/api/catalog-version')body={revision:'a'};
 else if(p==='/api/tracks')body=[{id:'local-1',title:'Track One',artist:'Band',artists:['Band'],album:'Album',duration:185,plays:8,hearts:2,likes:3,dislikes:0,created_at:1700000000000}];
 else if(p==='/api/track-reaction-counts')body={};
 else if(p==='/api/active-streams')body={listeners:0,songs:[]};
 else if(p==='/api/genres')body={};
 else if(p==='/api/entity-reactions')body={};
 return Response.json(body,{status});
};
'''
frames=8000*9
mem=io.BytesIO()
with wave.open(mem,'wb') as w:
 w.setnchannels(1);w.setsampwidth(2);w.setframerate(8000);w.writeframes(b'\x00\x00'*frames)
wav='data:audio/wav;base64,'+base64.b64encode(mem.getvalue()).decode()
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
 page=browser.new_page(viewport={'width':1320,'height':900})
 errs=[];page.on('pageerror',lambda e:errs.append(str(e)+' STACK '+str(getattr(e,'stack',''))))
 page.goto('about:blank');page.set_content(html)
 page.evaluate('(s)=>(0,eval)(s)',mock)
 page.evaluate('(s)=>(0,eval)(s)',bundle)
 page.locator('#boot[hidden]').wait_for(timeout=20000)
 page.evaluate('(u)=>{const a=document.querySelector("#audio");a.src=u;window.__playingAudio=a;}',wav)
 page.evaluate('document.querySelector("#audio").play()')
 page.wait_for_timeout(250)
 assert page.evaluate('!document.querySelector("#audio").paused')
 before=page.evaluate('document.querySelector("#audio").currentTime')
 for url in ['#top','#top/telemetry','#hearts','#likes','#dislikes','#recent/albums','#top/telemetry']:
  page.evaluate('(value)=>location.hash=value',url)
  if url.startswith('#top') or url in ['#hearts','#likes','#dislikes']:
   page.locator('#list iframe.wasp-telemetry-frame').wait_for(timeout=10000)
  page.wait_for_timeout(75)
  state=page.evaluate('''()=>({same:document.querySelector('#audio')===window.__playingAudio,
    paused:document.querySelector('#audio').paused,src:document.querySelector('#audio').currentSrc})''')
  assert state['same'] and not state['paused'] and state['src'].startswith('data:audio/'),(url,state)
 after=page.evaluate('document.querySelector("#audio").currentTime')
 assert after>before,(before,after)
 assert page.locator('#subbar a[href="#top/telemetry"]').count()==1
 assert not [e for e in errs if "Failed to construct 'URL'" not in e],errs[:10]
 browser.close()
print('PASS v17: playback element and live playback survive telemetry and reaction tab changes')
