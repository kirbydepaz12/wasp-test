"""Chromium tests for WASP v18.1.2. In-memory only: no deployed services or user data."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'

def admin_html():
 s=(P/'admin.html').read_text()
 s=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda _: '<style>'+(P/'style.css').read_text()+'</style>',s)
 return re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',s)
admin=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ','function ',(P/'sidebar-bbcode.js').read_text(),flags=re.M)
tele=(P/'telemetry-view.js').read_text()
css=(P/'telemetry.css').read_text()

with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width in (1440,390):
  p=b.new_page(viewport={'width':width,'height':930},accept_downloads=True);errors=[]
  p.on('pageerror',lambda err:errors.append(str(err)))
  p.on('dialog',lambda d:d.accept('clear logs') if d.type=='prompt' else d.accept())
  p.goto('about:blank');p.set_content(admin_html());p.evaluate('location.hash="#processes"')
  p.evaluate(r'''()=>{window.__logs=[{id:'x',happened_at:Date.now(),actor:'admin',method:'POST',action:'/api/admin/settings',status:200}];window.__users=[{id:'u1',username:'test user',heart_songs:3,like_songs:2,dislike_songs:1,private_playlists:2,public_playlists:4,provided_links:3,online_links:2,can_publish:true,created_at:Date.now(),publish_requested:false}];
  window.fetch=async(input,opt={})=>{const path=new URL(String(input),'https://wasp.test').pathname,method=opt.method||'GET';let response={};
  if(path==='/api/me')response={admin:true,authenticated:true,role:'admin',username:'admin'};
  else if(path==='/api/admin/version')response={version:'18.1.2',label:'Testing'};
  else if(path==='/api/admin/processes')response={processes:[{id:'one',name:'HIVE metadata scanner',category:'Metadata',state:'running',started_at:Date.now()-10000,progress:55,message:'Processing 100 jobs'}],observed_at:Date.now()};
  else if(path==='/api/admin/processes/logs/clear'&&method==='DELETE'){window.__logs=[{id:'cleared',happened_at:Date.now(),actor:'admin',method:'DELETE',action:'Admin audit history cleared',status:200}];response={ok:true};}
  else if(path==='/api/admin/processes/logs')response={entries:window.__logs,next:null};
  else if(path==='/api/admin/users')response=window.__users;
  else if(path==='/api/admin/users/publish-default')response={enabled:true};
  else if(path==='/api/admin/users/publish-notifications')response={pending:0};
  else if(path==='/api/admin/network')response={share:false,peers:[]};
  else if(path==='/api/admin/requests')response=[];
  else if(path==='/api/site')response={name:'WASP',title:'TEST',sidebar:{enabled:false,content:''},ad:{enabled:false}};
  else if(path==='/api/tracks')response=[];
  else if(path==='/api/playlists')response=[];
  else if(path==='/api/admin/telemetry/peers')response={peers:[]};
  else if(path==='/api/admin/telemetry/metadata')response={runtime:'cloudflare',preferred:'musicbrainz',peers:[],coverage:{total:10,years:7,origins:8}};
  return Response.json(response);
  };}''')
  p.evaluate('(s)=>(0,eval)(s)',bb+'\n'+admin)
  p.wait_for_function("document.querySelector('#opsProcessList').textContent.includes('HIVE metadata scanner')")
  assert 'Running processes' in p.locator('#anav').inner_text()
  assert 'Network, Metadata, Telemetry' in p.locator('#anav').inner_text()
  assert 'Users & Announcements' in p.locator('#anav').inner_text()
  assert p.locator('#anav a[href="#processes"]+a[href="#danger"]').count()==1
  p.locator('#opsTabLogs').click()
  p.wait_for_function("document.querySelector('#opsLogList').textContent.includes('admin/settings')")
  with p.expect_download() as dl:
   p.locator('#opsLogsDownload').click()
  assert dl.value.suggested_filename.endswith('.txt')
  p.locator('#opsLogsClear').click()
  p.wait_for_function("document.querySelector('#opsLogList').textContent.includes('Admin audit history cleared')")
  p.evaluate('location.hash="#users";window.dispatchEvent(new Event("hashchange"))')
  p.wait_for_function("document.querySelector('#usersList').textContent.includes('test user')")
  dims=p.locator('.users-fitted').evaluate('(el)=>({scroll:el.scrollWidth,client:el.clientWidth})')
  assert dims['scroll']<=dims['client']+4,f'users table horizontally overflows at {width}: {dims}'
  for stat in ('L 2 · D 1','Public 4','Online 2'):
   assert stat in p.locator('.users-fitted').inner_text(),stat
  assert not [e for e in errors if 'Failed to construct' not in e],errors
  p.close();print(f'PASS admin {width}px process monitor, logs, export, clear, nav labels, compact users',flush=True)
 for width in (1440,390):
  p=b.new_page(viewport={'width':width,'height':720});errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
  p.goto('about:blank');p.set_content('<html><head><style>'+css+'</style></head><body><main id="telemetryRoot"></main></body></html>')
  p.evaluate('(s)=>(0,eval)(s)',tele)
  def show(mode,sub):
   p.evaluate('''({mode,sub})=>{const items=[{kind:'song',id:'one',title:'One',score:5,scoreLabel:mode==='hearts'?'hearts':'stars'}, {kind:'song',id:'two',title:'Two',score:1,scoreLabel:mode==='hearts'?'hearts':'stars'}, {kind:'song',id:'three',title:'Three',score:3,scoreLabel:mode==='hearts'?'hearts':'stars'}];const label=sub==='artists'?'artist':sub==='playlists'?'playlist':'song';for(const x of items)x.kind=label;
     window.dispatchEvent(new MessageEvent('message',{data:{type:'wasp:telemetry-data',mode,sub,query:'',items},origin:location.origin,source:window}));}''',{'mode':mode,'sub':sub})
  for mode in ('stars','hearts'):
   for sub in ('songs','artists','playlists'):
    show(mode,sub)
    p.locator('[data-ranking-sort-toggle]').wait_for(timeout=3000)
    assert p.locator('.ranking-title-row h1').count()==1
    assert p.locator('.ranking-title-row [data-ranking-sort-toggle]').count()==1
    assert p.locator('[data-ranking-sort-toggle] img').get_attribute('src')=='/nav-icons/up-and-down-arrows.png'
    assert p.locator('#rankingSort').count()==0
    assert p.locator('.browse-tile').first.locator('b').inner_text()=='One',(mode,sub)
    p.locator('[data-ranking-sort-toggle]').click()
    assert p.locator('.browse-tile').first.locator('b').inner_text()=='Two',(mode,sub)
    assert p.locator('[data-ranking-sort-toggle]').get_attribute('aria-pressed')=='true'
    p.locator('[data-ranking-sort-toggle]').click()
    assert p.locator('.browse-tile').first.locator('b').inner_text()=='One',(mode,sub,'toggle back')
    assert p.locator('[data-ranking-sort-toggle]').get_attribute('aria-pressed')=='false'
  assert not errors,errors
  p.close();print(f'PASS rankings {width}px: most/least sorting for Songs, Artists, Playlists in Hearts and Stars',flush=True)
 b.close()
