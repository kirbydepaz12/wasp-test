"""Isolated v18.1.3 browser checks: no real GitHub, Cloudflare, or Docker connections."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
html=(P/'admin.html').read_text()
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda _: '<style>'+(P/'style.css').read_text()+'</style>',html)
html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
admin=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ','function ',(P/'sidebar-bbcode.js').read_text(),flags=re.M)
script=bb+'\n'+admin

def run(browser,width):
 p=browser.new_page(viewport={'width':width,'height':960});errors=[]
 p.on('pageerror',lambda e:errors.append(str(e)))
 p.goto('about:blank')
 p.set_content(html)
 p.evaluate('location.hash="#settings/release-updates"')
 p.evaluate(r'''()=>{
 window.__channel='stable';window.__requests=[];window.__notice=1;
 const store=new Map();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)}});
 window.fetch=async(input,opt={})=>{
   const url=new URL(String(input),'https://wasp.test'),path=url.pathname;
   const method=opt.method||'GET';window.__requests.push({path,method,query:url.search});
   if(path==='/api/me')return Response.json({admin:true,authenticated:true,role:'admin',username:'admin'});
   if(path==='/api/admin/version')return Response.json({version:'18.1.3',label:'Release Updates'});
   if(path==='/api/admin/release-updates'){
     if(method==='PUT'){
       const data=JSON.parse(opt.body);window.__channel=data.channel;
       return Response.json({ok:true,channel:window.__channel,repository:window.__channel==='test'?'kirbydepaz12/wasp-test':'KNDPZ/WASP'});
     }
     const test=window.__channel==='test',repo=test?'kirbydepaz12/wasp-test':'KNDPZ/WASP';
     const r='https://github.com/'+repo,sha='b'.repeat(40);
     return Response.json({channel:window.__channel,repository:repo,repository_url:r,
       installed_version:'18.1.3',deployed_sha:null,checked_at:Date.now(),detection:'first-observed-commit',
       release:{tag:'v18.1.4',name:'Version 18.1.4',url:r+'/releases/tag/v18.1.4'},
       commit:{sha,short_sha:sha.slice(0,8),url:r+'/commit/'+sha},
       decision:{available:true,kind:'release',key:window.__channel+':release:v18.1.4'+window.__notice,
       title:'New Version',version:'v18.1.4',url:r+'/releases/tag/v18.1.4',details:'Important updates'}});
   }
   if(path==='/api/admin/users/publish-notifications')return Response.json({pending:0});
   if(path==='/api/admin/network')return Response.json({share:false,peers:[]});
   if(path==='/api/site')return Response.json({name:'WASP',title:'TEST',sidebar:{enabled:false},ad:{enabled:false}});
   if(path==='/api/admin/users')return Response.json([]);
   if(path==='/api/admin/requests')return Response.json([]);
   if(path==='/api/tracks'||path==='/api/playlists')return Response.json([]);
   if(path==='/api/admin/telemetry/peers')return Response.json({peers:[]});
   if(path==='/api/admin/telemetry/metadata')return Response.json({runtime:'cloudflare',coverage:{total:0,years:0,origins:0},peers:[]});
   return Response.json({});
 };}''')
 p.evaluate('(s)=>(0,eval)(s)',script)
 p.locator('#adminReleaseAlert').wait_for(state='visible',timeout=20000)
 assert p.locator('#adminReleaseAlertTitle').inner_text()=='New WASP release available'
 assert 'Stable' in p.locator('#adminReleaseAlertChannel').inner_text()
 assert p.locator('#settingsUpdatesPanel').is_visible()
 assert p.locator('#settingsGeneralPanel').is_hidden()
 assert p.locator('#releaseRepoLink').get_attribute('href')=='https://github.com/KNDPZ/WASP'
 assert p.locator('#adminReleaseAlertLink').get_attribute('href').endswith('/releases/tag/v18.1.4')
 p.locator('input[value="test"][name="releaseChannel"]').check();p.locator('#releaseSave').click()
 p.wait_for_function("window.__channel==='test' && document.querySelector('#adminReleaseAlertChannel').textContent==='Test'")
 assert p.locator('#adminReleaseAlertChannel').inner_text()=='Test'
 assert p.evaluate('window.__channel')=='test'
 assert p.locator('#adminReleaseAlert').is_visible()
 p.locator('#adminReleaseDismiss').click();assert p.locator('#adminReleaseAlert').is_hidden()
 # A dismissed version stays dismissed after another status check.
 p.locator('#releaseCheck').click();p.wait_for_function("window.__requests.some(x=>x.query==='?refresh=1')")
 assert p.locator('#adminReleaseAlert').is_hidden()
 # A newer published release has a different ID and is displayed.
 p.evaluate('window.__notice=2');p.locator('#releaseCheck').click();p.locator('#adminReleaseAlert').wait_for(state='visible')
 assert p.locator('#releaseSettingsMsg').inner_text()=='GitHub check complete.'
 p.locator('#settingsTabGeneral').click();assert p.locator('#settingsGeneralPanel').is_visible()
 p.locator('#settingsTabUpdates').click();assert p.locator('#settingsUpdatesPanel').is_visible()
 assert p.locator('#releaseCheck').bounding_box()['width']>50
 if width==390:
   details=p.locator('#releaseRepoLink').bounding_box();assert details['x']+details['width']<=width+2,(width,details)
 assert not [e for e in errors if 'Failed to construct' not in e],errors
 p.close();print(f'PASS {width}px release tabs, channel persistence, notification links, dismissal and refresh',flush=True)

with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for w in (1440,390):run(browser,w)
 browser.close()
