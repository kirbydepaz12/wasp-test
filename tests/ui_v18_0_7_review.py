"""Offline Chromium checks for playlist review + metadata subtabs; no production calls."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda m:'<style>'+(P/'style.css').read_text()+'</style>',(P/'admin.html').read_text())
html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
js=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ', 'function ', (P/'sidebar-bbcode.js').read_text(), flags=re.M)
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 p=b.new_page(viewport={'width':1450,'height':880});errors=[];p.on('pageerror',lambda e:errors.append(str(e)+'\n'+str(e.stack)));p.on('dialog',lambda d:d.accept());p.goto('about:blank');p.set_content(html);p.evaluate('location.hash="#requests"')
 p.evaluate(r'''()=>{
 window.__fixture={actions:[],requests:[{id:'test-req',kind:'playlist',title:'This is Doja Cat',artist:'',url:'https://open.spotify.com/playlist/123456789012',created_at:1,total:3,matched:1,matched_local:1,matched_peer:0,missing:[{t:'Lose My Mind (feat. Doja Cat)',a:'Don Toliver',request_index:1},{t:'Kiss Me More (feat. SZA)',a:'Doja Cat',request_index:2}],availability_checked_at:Date.now(),source_status:'verified',partial:false,skipped:[]}]};
 window.fetch=async(input,opt={})=>{
 const url=new URL(String(input),'https://wasp.test'),key=url.pathname,method=opt.method||'GET';let d={};
 if(key==='/api/me') d={admin:true,authenticated:true,role:'admin'};
 else if(key==='/api/admin/version')d={version:'18.0.7',label:'Review'};
 else if(key==='/api/admin/requests')d=__fixture.requests;
 else if(key.endsWith('/candidates'))d={index:Number(url.searchParams.get('index')),source:{t:'Lose My Mind',a:'Don Toliver'},candidates:[{id:'song2',origin:'',title:'Lose My Mind',artist:'Don Toliver',album:'F1',score:93}]};
 else if(key.endsWith('/match')){const x=JSON.parse(opt.body);__fixture.actions.push(x);d={ok:true,index:x.index,matched:2,missing:[]};
 if(x.action==='accept')__fixture.requests[0].missing=__fixture.requests[0].missing.filter(v=>v.request_index!==x.index);
 if(x.action==='skip')__fixture.requests[0].missing=__fixture.requests[0].missing.filter(v=>v.request_index!==x.index);
 if(x.action==='add')__fixture.requests[0].missing.push({t:x.title,a:x.artist,request_index:3});}
 else if(key==='/api/admin/network')d={share:true,peers:[]};
 else if(key==='/api/admin/telemetry/metadata')d={runtime:'docker',preferred:'musicbrainz',musicbrainz:true,coverage:{total:10,years:2,origins:3},encryptionReady:true};
 else if(key==='/api/admin/telemetry/metadata/status')d={runtime:'docker',scan:{state:'idle'}};
 else if(key==='/api/admin/telemetry/metadata/offline-status')d={installed:{version:'demo'},state:'ready',active:false,freeBytes:20000000000};
 else if(key==='/api/admin/telemetry/metadata/offline-scan')d={ok:true};
 else if(key==='/api/site')d={name:'WASP',title:'WASP',sidebar:{enabled:false,content:''},ad:{enabled:false}};
 else if(key==='/api/admin/tracks'||key==='/api/admin/playlists')d=[];
 return Response.json(d);
 };}''')
 p.evaluate('(code)=>(0,eval)(code)',bb+'\n'+js)
 p.locator('tr[data-r="test-req"]').wait_for(timeout=10000)
 p.locator('tr[data-r="test-req"] [data-a="toggle"]').click();assert p.locator('tr[data-d="test-req"]').is_visible()
 p.locator('tr[data-r="test-req"] [data-a="scan-matches"]').click()
 p.locator('.req-candidate [data-a="match-accept"]').first.wait_for(timeout=10000)
 assert 'Lose My Mind' in p.locator('.req-candidate').first.inner_text()
 p.locator('.req-candidate [data-a="match-accept"]').first.click()
 p.wait_for_function("__fixture.actions.some(x=>x.action==='accept')")
 p.locator('tr[data-d="test-req"] [data-req-song-title]').fill('New Song')
 p.locator('tr[data-d="test-req"] [data-req-song-artist]').fill('New Artist')
 p.locator('tr[data-d="test-req"] [data-a="match-add"]').click()
 p.wait_for_function("__fixture.actions.some(x=>x.action==='add')")
 p.evaluate('location.hash="#network/telemetry";window.dispatchEvent(new Event("hashchange"))')
 p.locator('.metadata-subtabs [data-metadata-tab="online"]').click()
 assert p.locator('#metadataMusicbrainz').is_visible()
 p.locator('.metadata-subtabs [data-metadata-tab="telemetry"]').click()
 assert p.locator('#metadataYearBar').is_visible()
 p.locator('.metadata-subtabs [data-metadata-tab="others"]').click()
 assert p.locator('#metadataTrust').is_visible()
 assert p.locator('#metadataForm button[type=submit]').is_visible()
 assert not errors,errors
 p.close();b.close()
print('PASS admin playlist suggestions, confirmed match, manual add, metadata tabs and persistent Save')
