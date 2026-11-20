"""Browser checks for Docker-only database install, progress and admin controls."""
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
  p=b.new_page(viewport={'width':1100,'height':850});errors=[];p.on('pageerror',lambda e:errors.append(str(e)));p.on('dialog',lambda d:d.accept());p.goto('about:blank');p.set_content(html);p.evaluate('location.hash="#network/telemetry"')
  p.evaluate('''runtime=>{window.cfg={runtime,scan:{state:'idle'},preferred:'musicbrainz',musicbrainz:true,trustPeers:true,offlineFallback:true,coverage:{total:100,years:10,origins:20},encryptionReady:true};window.off={state:'not-installed',active:false,freeBytes:20*1073741824};window.actions=[];window.fetch=async(input,opt={})=>{const path=new URL(String(input),'https://wasp.invalid').pathname;let d={};if(path==='/api/me')d={admin:true,authenticated:true};else if(path==='/api/admin/version')d={version:'18.0.4',label:'HIVE Offline Metadata Engine'};else if(path==='/api/admin/telemetry/metadata'){if(opt.method==='PUT'){cfg={...cfg,...JSON.parse(opt.body)};d={ok:true};}else d=cfg;}else if(path.endsWith('/metadata/status'))d={runtime,scan:cfg.scan};else if(path.endsWith('/metadata/offline-status')){actions.push('status');d=off;}else if(path.endsWith('/metadata/offline-download')){actions.push('download');off={...off,state:'downloading',active:true,entity:'artist',totalBytes:100,bytes:40};d={ok:true};}else if(path.endsWith('/metadata/offline-cancel')){actions.push('cancel');off={...off,state:'cancelled',active:false};d={ok:true};}else if(path==='/api/admin/network')d={share:true,peers:[]};else if(path==='/api/site')d={title:'WASP',name:'WASP',ad:{enabled:false}};return Response.json(d)}}''',runtime)
  p.evaluate('(code)=>(0,eval)(code)',bb+'\n'+js);p.wait_for_function("document.querySelector('#metadataRuntime').textContent.length>0")
  assert p.locator('#metadataOfflinePanel').is_visible()==(runtime=='docker')
  if runtime=='docker':
   p.wait_for_function("document.querySelector('#metadataOfflineText').textContent.includes('not installed')")
   p.locator('#metadataOfflineDownload').click();p.wait_for_function("document.querySelector('#metadataOfflineBar').value===40")
   assert p.locator('#metadataOfflineDownload').is_disabled();assert p.locator('#metadataOfflineCancel').is_enabled()
   p.locator('#metadataOfflineCancel').click();p.wait_for_function("document.querySelector('#metadataOfflineText').textContent.includes('cancelled')")
   p.evaluate("off={state:'ready',active:false,freeBytes:20*1073741824,installed:{version:'20261118-001001',artists:321,albums:456},progress:{version:'20261118-001001',checked:20,matched:17}}")
   p.locator('#metadataOfflineRefresh').click();p.wait_for_function("document.querySelector('#metadataOfflineMatch').textContent.includes('17 new facts matched')")
   assert '321 artists' in p.locator('#metadataOfflineText').inner_text()
   p.locator('#metadataOfflineFallback').uncheck();p.locator('#metadataForm button[type=submit]').click();p.wait_for_function('cfg.offlineFallback===false')
   p.set_viewport_size({'width':390,'height':844});assert p.locator('#metadataOfflinePanel').bounding_box()['width']<=390
  else: assert 'status' not in p.evaluate('actions')
  assert not errors,errors;p.close()
 b.close()
print('PASS Docker-only offline download, cancellation, progress, persistence option, mobile; no Cloudflare requests')
