"""Chromium scanner UI: persistent backend progress, pause/resume and Cloudflare warning."""
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
 for runtime in ('docker','cloudflare'):
  p=b.new_page(viewport={'width':1100,'height':850});errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
  p.goto('about:blank');p.set_content(html);p.evaluate('location.hash="#network/telemetry"')
  p.evaluate('''runtime=>{window.cfg={runtime,scan:{state:'idle'},preferred:'musicbrainz',musicbrainz:true,enabled:false,trustPeers:true,contact:'admin@example.invalid',preferredPeer:'https://docker.example',peers:[{url:'https://docker.example',name:'Docker'}],coverage:{total:2760,years:27,origins:1155},encryptionReady:true};window.actions=[];window.fetch=async(input,opt={})=>{const path=new URL(String(input),'https://wasp.invalid').pathname;let d={};if(path==='/api/me')d={admin:true,authenticated:true};else if(path==='/api/admin/version')d={version:'18.0.2',label:'HIVE Telemetry Intelligence'};else if(path==='/api/admin/telemetry/metadata')d=cfg;else if(path.endsWith('/metadata/status'))d={runtime,scan:cfg.scan};else if(path.endsWith('/metadata/start')){actions.push('start');cfg.scan={state:'running',phase:'processing',processed:40,remaining:60,verified:25,errors:0,updated:Date.now()};d=cfg.scan;}else if(path.endsWith('/metadata/pause')){actions.push('pause');cfg.scan={...cfg.scan,state:'paused'};d=cfg.scan;}else if(path.endsWith('/metadata/stop')){actions.push('stop');cfg.scan={...cfg.scan,state:'stopped'};d=cfg.scan;}else if(path.endsWith('/metadata/pull')){actions.push('pull');d={verified:0,imported:20,errors:0};cfg.coverage.years=300;}else if(path==='/api/admin/network')d={share:true,peers:[]};else if(path==='/api/site')d={title:'WASP',name:'WASP',ad:{enabled:false}};return Response.json(d)}}''',runtime)
  p.evaluate('(code)=>(0,eval)(code)',bb+'\n'+js)
  p.wait_for_function("document.querySelector('#metadataRuntime').textContent.length>0")
  assert p.locator('#metadataPreferredPeer').input_value()=='https://docker.example'
  assert p.locator('#metadataCloudWarning').is_visible()==(runtime=='cloudflare')
  if runtime=='docker':
   p.locator('#metadataScan').click();p.wait_for_function("document.querySelector('#metadataScanBar').value===40")
   assert p.locator('#metadataScan').is_disabled();assert '40 jobs processed' in p.locator('#metadataScanText').inner_text()
   p.locator('#metadataPause').click();p.wait_for_function("document.querySelector('#metadataScan').textContent==='Resume scan'")
   p.locator('#metadataScan').click();p.wait_for_function("document.querySelector('#metadataPause').disabled===false")
   p.evaluate("cfg.scan={...cfg.scan,processed:75,remaining:25,verified:48}");p.wait_for_function("document.querySelector('#metadataScanBar').value===75",timeout=11000)
   p.locator('#metadataStop').click();p.wait_for_function("document.querySelector('#metadataScanText').textContent.includes('stopped')")
   assert p.evaluate('actions')==['start','pause','start','stop']
  else:
   assert not p.locator('#metadataScanControls').is_visible()
   p.locator('#metadataPull').click();p.wait_for_function("document.querySelector('#metadataStatus').textContent.includes('20 imported')")
   assert p.locator('#metadataYearCount').inner_text()=='300 / 2,760 plays classified'
   assert p.evaluate('actions')==['pull']
  p.set_viewport_size({'width':390,'height':844});assert p.locator('#metadataCoverageCard').bounding_box()['width']<=390
  assert not errors,errors;p.close()
 b.close()
print('PASS Docker scanner progress, pause/resume/stop and polling; Cloudflare-only warning, preferred peer pull, and mobile width')
