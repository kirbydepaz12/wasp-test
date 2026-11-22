"""In-memory Chromium checks for local user announcements, admin previews and selective telemetry. No live servers."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
def html(name):
 text=(P/(name+'.html')).read_text()
 text=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda m:'<style>'+(P/'style.css').read_text()+'</style>',text)
 return re.sub(r'<script[^>]*src="/(?:admin|app).js(?:\?v=[^"]+)?"[^>]*></script>','',text)
bb=re.sub(r'^export function ','function ',(P/'sidebar-bbcode.js').read_text(),flags=re.M)
admin=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
art=(P/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(P/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
builder=(P/'radio-builder.js').read_text().replace('export const ','const ').replace('export function ','function ')
app=re.sub(r'^import .*?;\n','',(P/'app.js').read_text(),flags=re.M)
app+='\nwindow.__ann={poll:pollServerAnnouncements,refresh:refreshAccount};'
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1440,390):
  p=b.new_page(viewport={'width':width,'height':940});errs=[];p.on('pageerror',lambda e:errs.append(str(e)));p.on('dialog',lambda d:d.accept())
  p.goto('about:blank');p.set_content(html('admin'));p.evaluate('location.hash="#network/telemetry"')
  p.evaluate(r'''()=>{
    window.__sent=[];window.__pulled=[];
    window.fetch=async(input,opt={})=>{const path=new URL(String(input),'https://wasp.test').pathname,method=opt.method||'GET';let d={},status=200;
    if(path==='/api/me')d={admin:true,authenticated:true,role:'admin'};
    else if(path==='/api/site')d={name:'MAIN',title:'My private tab',sidebar:{enabled:false,content:''},ad:{enabled:false}};
    else if(path==='/api/admin/version')d={version:'18.1.0',label:'Test'};
    else if(path==='/api/admin/network')d={share:true,peers:[]};
    else if(path==='/api/admin/telemetry/peers')d={peers:[{id:'a',url:'https://peer-a.example',name:'TEST',last_ok:1},{id:'b',url:'https://peer-b.example',name:'PROD',last_ok:1}]};
    else if(path==='/api/admin/telemetry/pull'){window.__pulled.push(JSON.parse(opt.body));d={imported:3,checked:2,errors:0,totalPeers:2};}
    else if(path==='/api/admin/telemetry/metadata')d={runtime:'cloudflare',preferred:'musicbrainz',peers:[],coverage:{total:10,years:6,origins:8},apiKeyConfigured:false};
    else if(path==='/api/admin/announcements'&&method==='GET')d={items:window.__sent};
    else if(path==='/api/admin/announcements'&&method==='POST'){const item={id:'created-1',created_at:Date.now(),...JSON.parse(opt.body)};window.__sent.push(item);d={ok:true,id:item.id};status=201;}
    else if(path==='/api/admin/users')d=[];
    else if(path==='/api/admin/users/publish-default')d={enabled:false};
    else if(path==='/api/admin/requests')d=[];
    else if(path==='/api/admin/tracks'||path==='/api/admin/playlists')d=[];
    return Response.json(d,{status});
   };
  }''')
  p.evaluate('(s)=>(0,eval)(s)',bb+'\n'+admin)
  p.locator('[data-metadata-tab=telemetry]').click()
  p.locator('#telemetryPeerChoices input').first.wait_for(timeout=10000)
  assert p.locator('#telemetryPeerChoices input').count()==2
  p.locator('#telemetrySelectAll').click()
  assert p.locator('#telemetryPeerChoices input:checked').count()==2
  p.locator('#telemetryPullSelected').click()
  p.wait_for_function('__pulled.length===1')
  assert p.evaluate('__pulled[0].peers')==['https://peer-a.example','https://peer-b.example']
  p.wait_for_function("document.querySelector('#telemetryPullStatus').textContent.includes('3 new plays')")
  assert p.locator('#telemetryPullProgress').evaluate('(n)=>n.value')==100
  p.evaluate('location.hash="#users/announcements";window.dispatchEvent(new Event("hashchange"))')
  p.locator('#announcementTemplates button').first.click()
  assert p.locator('#announcementTitle').input_value()=='Scheduled maintenance'
  p.locator('#announcementTitle').fill('Deploying v18.1.0')
  p.locator('#announcementBody').fill('Music stays online while we apply <new> settings.')
  p.locator('#announcementOpacity').fill('0.65')
  assert p.locator('#announcementPreviewTitle').inner_text()=='Deploying v18.1.0'
  assert p.locator('#announcementPreviewBody').inner_text()=='Music stays online while we apply <new> settings.'
  assert p.locator('#announcementOpacityValue').inner_text()=='65%'
  p.locator('#announcementSend').click()
  p.wait_for_function('__sent.length===1')
  assert p.evaluate('__sent[0].severity')=='maintenance'
  p.wait_for_function('document.querySelectorAll("#announcementHistory .announcement-history-item").length===1')
  assert not errs,errs
  p.close();print(f'PASS admin {width}px: select all, manual sync, announcement templates, live preview, send and history',flush=True)
 # Signed-in user popup. A real HTML player is kept mounted; no audio must stop.
 p=b.new_page(viewport={'width':1300,'height':850});errs=[];p.on('pageerror',lambda e:errs.append(str(e)))
 p.goto('about:blank');p.set_content(html('index'));p.evaluate('location.hash="#home"')
 p.evaluate('''()=>{const items=new Map();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:key=>items.has(key)?items.get(key):null,setItem:(key,value)=>items.set(key,String(value)),removeItem:key=>items.delete(key)}});}''')
 p.evaluate(r'''()=>{
  window.__userMessages=[{id:'m1',title:'<script>alert(1)</script> Important update',body:'New music added!\nEnjoy the new tracks.',severity:'update',opacity:.75,created_at:Date.now()}];
  window.__messageFetches=0;
  window.fetch=async(input,opt={})=>{
   const path=new URL(String(input),'https://wasp.test').pathname;let d=[];
   if(path==='/api/me')d={authenticated:true,admin:false,role:'user',username:'user1'};
   else if(path==='/api/user/announcements'){__messageFetches++;d={items:__userMessages};}
   else if(path==='/api/catalog-version')d={revision:'1'};
   else if(path==='/api/site')d={name:'MAIN',title:'Browser title',sidebar:{enabled:false},ad:{enabled:false}};
   else if(path==='/api/entity-reactions')d={artist:{},playlist:{}};
   else if(path==='/api/active-streams')d={sources:[]};
   return Response.json(d);
  };
 }''')
 p.evaluate('(s)=>(0,eval)(s)',bb+'\n'+art+'\n'+radio+'\n'+builder+'\n'+app)
 p.locator('#serverAnnouncements .wasp-announcement').wait_for(timeout=15000)
 assert p.locator('#serverAnnouncements .wasp-announcement').count()==1
 assert p.locator('#serverAnnouncements .wasp-announcement script').count()==0
 assert '<script>' in p.locator('.announcement-heading strong').inner_text()
 assert p.locator('.announcement-body').inner_text()=='New music added!\nEnjoy the new tracks.'
 opacity=p.locator('#serverAnnouncements .wasp-announcement').evaluate('(n)=>getComputedStyle(n).getPropertyValue("--announcement-opacity").trim()')
 assert opacity in ('.75','0.75'),opacity
 p.locator('.announcement-close').click()
 assert p.locator('#serverAnnouncements .wasp-announcement').count()==0
 p.evaluate('window.__ann.poll(true)')
 p.wait_for_timeout(180)
 assert p.locator('#serverAnnouncements .wasp-announcement').count()==0,'dismissed announcement should not reappear'
 assert p.evaluate('JSON.parse(localStorage.getItem("wasp-announcements-seen-v1810:user1")).includes("m1")')
 # Prove the code actually registers a 30-second timeout and auto-dismisses.
 p.evaluate('''()=>{window.__timeoutSeen=0;const real=window.setTimeout;window.setTimeout=(fn,ms)=>{if(ms===30000){window.__timeoutSeen=ms;return real(fn,25);}return real(fn,ms);};window.__userMessages.push({id:'m2',title:'Short display',body:'Thirty second message',severity:'info',opacity:.87,created_at:Date.now()});}''')
 p.evaluate('window.__ann.poll(true)')
 p.wait_for_function('window.__timeoutSeen===30000')
 p.wait_for_function('document.querySelectorAll("#serverAnnouncements .wasp-announcement").length===0')
 assert not [e for e in errs if "Failed to construct 'URL'" not in e],errs
 p.close();b.close();print('PASS registered user popup: safe text, theme opacity, dismiss, browser cached acknowledgement',flush=True)
