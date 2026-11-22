"""v18.1.3a: selected Test repo and 404 details cannot be repainted by stale Stable data."""
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
 p.goto('about:blank');p.set_content(html)
 p.evaluate('location.hash="#settings/release-updates"')
 p.evaluate(r'''()=>{
   window.__channel='stable';window.__pendingStable=[];window.__getTest=0;
   window.fetch=async(input,opt={})=>{
     const u=new URL(String(input),'https://wasp.test');const path=u.pathname;
     if(path==='/api/me')return Response.json({admin:true,authenticated:true,role:'admin',username:'admin'});
     if(path==='/api/admin/version')return Response.json({version:'18.1.3a',label:'Release Updates Channel Hotfix'});
     if(path==='/api/admin/release-updates'){
       if(opt.method==='PUT'){
         window.__channel=JSON.parse(opt.body).channel;
         return Response.json({ok:true,channel:window.__channel,repository:window.__channel==='test'?'kirbydepaz12/wasp-test':'KNDPZ/WASP'});
       }
       if(window.__channel==='stable')return new Promise(resolve=>window.__pendingStable.push(resolve));
       window.__getTest++;
       return Response.json({channel:'test',repository:'kirbydepaz12/wasp-test',repository_url:'https://github.com/kirbydepaz12/wasp-test',installed_version:'18.1.3a',
         error:'Could not check GitHub: GitHub cannot access kirbydepaz12/wasp-test (HTTP 404). Confirm the repository exists and is public; for a private repository, configure GITHUB_UPDATES_TOKEN on this WASP server.'},{status:503});
     }
     if(path==='/api/site')return Response.json({name:'WASP',title:'TEST',sidebar:{enabled:false},ad:{enabled:false}});
     if(path==='/api/admin/users/publish-notifications')return Response.json({pending:0});
     if(path==='/api/admin/network')return Response.json({share:false,peers:[]});
     if(path==='/api/tracks'||path==='/api/playlists')return Response.json([]);
     return Response.json({});
   };
 }''')
 p.evaluate('(s)=>(0,eval)(s)',script)
 p.wait_for_function('window.__pendingStable.length>0')
 p.locator('input[name="releaseChannel"][value="test"]').check()
 assert p.locator('#releaseRepoLink').inner_text()=='kirbydepaz12/wasp-test'
 assert p.locator('#releaseLatestCommit').inner_text()=='—'
 assert p.locator('#releaseSettingsMsg').inner_text()=='Unsaved channel selection.'
 # Check now must save the selected channel instead of checking the old saved Stable channel.
 p.locator('#releaseCheck').click()
 p.wait_for_function('window.__channel==="test" && window.__getTest>0')
 p.locator('#releaseSettingsMsg').get_by_text('GITHUB_UPDATES_TOKEN',exact=False).wait_for(timeout=12000)
 assert p.locator('#releaseRepoLink').inner_text()=='kirbydepaz12/wasp-test'
 assert '404' in p.locator('#releaseSettingsMsg').inner_text()
 assert p.locator('#releaseLatestVersion').inner_text()=='Unavailable'
 assert p.locator('#releaseLatestCommit').inner_text()=='Unavailable'
 assert p.locator('input[name="releaseChannel"][value="test"]').is_checked()
 assert p.locator('#adminReleaseAlert').is_hidden()
 # The stable GET was started before the user selected Test; its late result is ignored.
 p.evaluate('''()=>{for(const resolve of window.__pendingStable)resolve(Response.json({channel:'stable',repository:'KNDPZ/WASP',installed_version:'18.1.3a',
    checked_at:Date.now(),release:{tag:'v18.2.0'},commit:{short_sha:'abcdefgh'},decision:{available:false}}));}''')
 p.wait_for_timeout(180)
 assert p.locator('#releaseRepoLink').inner_text()=='kirbydepaz12/wasp-test'
 assert p.locator('input[name="releaseChannel"][value="test"]').is_checked()
 assert p.locator('#releaseLatestCommit').inner_text()=='Unavailable'
 assert not errors,errors
 p.close();print(f'PASS {width}px: immediate Test preview, Check now saves, 404 channel retained, stale Stable GET ignored',flush=True)

with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for w in (1440,390):run(browser,w)
 browser.close()
