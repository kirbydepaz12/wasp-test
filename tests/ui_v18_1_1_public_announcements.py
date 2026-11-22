"""Isolated Chromium: public near-live announcements, reload persistence, sound and playback safety."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
def html():
 s=(P/'index.html').read_text()
 s=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda m:'<style>'+(P/'style.css').read_text()+'</style>',s)
 return re.sub(r'<script[^>]*src="/(?:app).js(?:\?v=[^"]+)?"[^>]*></script>','',s)
bb=re.sub(r'^export function ','function ',(P/'sidebar-bbcode.js').read_text(),flags=re.M)
art=(P/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(P/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
builder=(P/'radio-builder.js').read_text().replace('export const ','const ').replace('export function ','function ')
app=re.sub(r'^import .*?;\n','',(P/'app.js').read_text(),flags=re.M)
app+='\nwindow.__annTest={poll:pollServerAnnouncements,reset:suspendAnnouncement,stop:()=>{clearTimeout(announcementTimer);announcementQueue=[];announcementVisible=false;announcementCurrent=null;}};'
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1440,390):
  p=b.new_page(viewport={'width':width,'height':900});errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
  p.goto('about:blank');p.set_content(html());p.evaluate('location.hash="#home"')
  # User has no account. The server sends the message while the visitor is already browsing.
  p.evaluate(r'''()=>{
   const items=new Map();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>items.get(k)||null,setItem:(k,v)=>items.set(k,String(v)),removeItem:k=>items.delete(k)}});
   window.__guestMessages=[];window.__noticeFetches=0;window.__dingCount=0;
   window.AudioContext=class{constructor(){this.state='running';this.currentTime=0;this.destination={}}resume(){return Promise.resolve()}
     createOscillator(){return {type:'sine',frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},start(){window.__dingCount++},stop(){}}}
     createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}}
   };
   window.fetch=async(input,opt={})=>{
    const path=new URL(String(input),'https://wasp.test').pathname;let d=[];
    if(path==='/api/me')d={authenticated:false,admin:false};
    else if(path==='/api/announcements'){window.__noticeFetches++;d={items:window.__guestMessages};}
    else if(path==='/api/catalog-version')d={revision:'1'};
    else if(path==='/api/site')d={name:'MAIN',title:'Demo',sidebar:{enabled:false},ad:{enabled:false}};
    else if(path==='/api/entity-reactions')d={artist:{},playlist:{}};
    else if(path==='/api/active-streams')d={sources:[]};
    return Response.json(d);
   };
  }''')
  p.evaluate('(s)=>(0,eval)(s)',bb+'\n'+art+'\n'+radio+'\n'+builder+'\n'+app)
  p.wait_for_function('window.__noticeFetches>=1')
  p.locator('body').click(position={'x':10,'y':150})  # unlock quiet WebAudio
  p.evaluate("window.__guestMessages.unshift({id:'guest-1',title:'New server update',body:'Maintenance tonight',severity:'maintenance',opacity:.69,created_at:Date.now()})")
  p.locator('#serverAnnouncements .wasp-announcement').wait_for(timeout=6000) # automatic timer, not manual refresh
  assert p.locator('.announcement-heading strong').inner_text()=='New server update'
  assert p.locator('.announcement-body').inner_text()=='Maintenance tonight'
  assert p.evaluate('window.__dingCount')>=1,'quiet ding did not run after gesture'
  assert p.evaluate('document.querySelector("#audio").volume') == 1,'ding changed music volume'
  assert p.evaluate('localStorage.getItem("wasp-announcements-handled-v1811")') is None,'shown notification acknowledged too early'
  assert p.locator('.wasp-announcement').evaluate('(e)=>e.style.getPropertyValue("--announcement-opacity")') in ('.69','0.69')
  # Simulate a page refresh preserving the same origin-local browser cache.
  p.evaluate('''async()=>{window.__annTest.reset();await window.__annTest.poll(true)}''')
  p.locator('#serverAnnouncements .wasp-announcement').wait_for(timeout=4000)
  assert p.locator('.announcement-heading strong').inner_text()=='New server update'
  p.locator('.announcement-sound').click()
  assert p.evaluate('JSON.parse(localStorage.getItem("wasp-announcements-sound-v1811"))') is False
  count=p.evaluate('window.__dingCount')
  p.evaluate("window.__guestMessages.unshift({id:'guest-2',title:'Another update',body:'New upload online',severity:'upload',opacity:.87,created_at:Date.now()+50})")
  p.evaluate('window.__annTest.poll(true)')
  p.wait_for_function("document.querySelector('.announcement-heading strong')?.textContent==='Another update'")
  assert p.evaluate('window.__dingCount')==count,'muting should suppress future dings'
  p.locator('.announcement-close').click()
  assert p.evaluate('JSON.parse(localStorage.getItem("wasp-announcements-handled-v1811")).includes("guest-2")')
  p.wait_for_function("document.querySelector('.announcement-heading strong')?.textContent==='New server update'")
  p.locator('.announcement-close').click()
  assert set(p.evaluate('JSON.parse(localStorage.getItem("wasp-announcements-handled-v1811"))'))=={'guest-1','guest-2'}
  p.evaluate('window.__annTest.poll(true)')
  p.wait_for_timeout(120)
  assert p.locator('.wasp-announcement').count()==0,'acknowledged notices should not reappear'
  assert not [e for e in errors if "Failed to construct 'URL'" not in e],errors
  p.close();print(f'PASS public announcements {width}px: guest delivery, 2s poll, browser refresh, ding, mute, dismissal',flush=True)
 b.close()
