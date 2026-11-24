"""Offline WASP Request song/playlist candidate reviews at desktop and mobile widths."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda m:'<style>'+(P/'style.css').read_text()+'</style>',(P/'admin.html').read_text())
html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
js=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ', 'function ', (P/'sidebar-bbcode.js').read_text(), flags=re.M)
for width in (1440,390):
 with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':width,'height':900})
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('dialog',lambda d:d.accept())
  page.goto('about:blank');page.set_content(html);page.evaluate('location.hash="#requests"')
  page.evaluate(r'''()=>{
   window.__reqfixture={actions:[],requests:[
    {id:'pl1',kind:'playlist',title:'Rock playlist',artist:'',created_at:1,total:1,matched:0,matched_local:0,matched_peer:0,missing:[{t:'My Day',a:'HELLMERRY',request_index:0}],source_status:'verified',partial:false,skipped:[]},
    {id:'song1',kind:'song',title:'Are You Ready?',artist:'Creed',created_at:2,matched_local:0,matched_peer:0}
   ]};
   window.fetch=async(input,opt={})=>{
    const url=new URL(String(input),'https://wasp.test'),k=url.pathname,body=opt.body?JSON.parse(opt.body):{},method=opt.method||'GET';let d={};
    if(k==='/api/me')d={admin:true,authenticated:true,role:'admin'};
    else if(k==='/api/admin/version')d={version:'18.1.5d',label:'Request matching'};
    else if(k==='/api/admin/requests')d=__reqfixture.requests;
    else if(k.endsWith('/candidates'))d={searched:{local:1,peer:2},index:Number(url.searchParams.get('index')||0),kind:k.includes('song1')?'song':'playlist',candidates:[
     {id:'l1',origin:'',title:'Are You Ready?',artist:'Creed',album:'Human Clay',score:100},
     {id:'p1',origin:'https://hive.example',title:'Are You Ready? (Live)',artist:'Creed',album:'Live',score:83}
    ]};
    else if(k.endsWith('/request-track')&&method==='POST'){
      __reqfixture.actions.push({action:'request-track',...body});d={ok:true,created:true,title:'My Day',artist:'HELLMERRY',id:'song2'};
      if(!__reqfixture.requests.some(r=>r.id==='song2'))__reqfixture.requests.push({id:'song2',kind:'song',title:'My Day',artist:'HELLMERRY',created_at:3});
    }
    else if(k.endsWith('/match')&&method==='POST'){
      __reqfixture.actions.push(body);d={ok:true,status:body.action==='accept'?'done':'active'};
      if(k.includes('song1')&&body.action==='accept')__reqfixture.requests=__reqfixture.requests.filter(r=>r.id!=='song1');
    }
    else if(k==='/api/admin/network')d={share:true,peers:[]};
    else if(k==='/api/admin/telemetry/metadata')d={runtime:'docker',preferred:'musicbrainz',musicbrainz:true,coverage:{total:10},encryptionReady:true};
    else if(k==='/api/admin/telemetry/metadata/status')d={runtime:'docker',scan:{state:'idle'}};
    else if(k==='/api/admin/telemetry/metadata/offline-status')d={installed:{version:'demo'},state:'ready',active:false,freeBytes:20000000000};
    else if(k==='/api/site')d={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
    else if(k==='/api/admin/tracks'||k==='/api/admin/playlists')d=[];
    return Response.json(d);
   };
  }''')
  page.evaluate('(code)=>(0,eval)(code)',bb+'\n'+js)
  page.locator('tr[data-r="song1"]').wait_for(timeout=10000)
  page.locator('tr[data-r="song1"] [data-a="song-scan"]').click()
  page.locator('tr[data-d="song1"] .req-candidate').first.wait_for(timeout=10000)
  assert page.locator('tr[data-d="song1"] .req-candidate').count()==2
  assert 'connected HIVE peer tracks' in page.locator('tr[data-d="song1"] .req-match-results').inner_text()
  assert 'HIVE peer:' in page.locator('tr[data-d="song1"] .req-candidate').last.inner_text()
  page.locator('tr[data-d="song1"] .req-candidate').last.locator('[data-a="match-reject"]').click()
  page.wait_for_function('__reqfixture.actions.some(x=>x.action==="reject"&&x.origin==="https://hive.example")')
  page.locator('tr[data-r="pl1"] [data-a="toggle"]').click()
  page.locator('tr[data-d="pl1"] [data-a="match-request-track"]').click()
  page.wait_for_function('__reqfixture.actions.some(x=>x.action==="request-track"&&x.index===0)')
  page.locator('tr[data-r="song2"]').wait_for(timeout=10000)
  assert not errors, errors
  page.close();browser.close()
 print(f'PASS request candidates and individual track action at {width}px')
