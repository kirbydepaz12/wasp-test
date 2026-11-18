"""Real rendered admin HTML/CSS, with mock authenticated APIs and no real secrets."""
from pathlib import Path
import re, os
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
html=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',lambda m:'<style>'+(P/'style.css').read_text()+'</style>',(P/'admin.html').read_text())
html=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',html)
js=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
bb=re.sub(r'^export function ', 'function ', (P/'sidebar-bbcode.js').read_text(), flags=re.M)
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 p=b.new_page(viewport={'width':1280,'height':950});errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
 p.goto('about:blank');p.set_content(html);p.evaluate('location.hash="#network/telemetry"')
 p.evaluate('''()=>{window.saved=null;window.testBody=null;window.breakTest=false;window.breakSave=false;window.ran=0;window.config={preferred:'musicbrainz',musicbrainz:true,lastfm:false,enabled:false,fallback:true,trustPeers:false,minutes:5,encryptionReady:true,verified:0,verifiedTracks:0,verifiedArtists:0,credentialSource:'none',prioritizePlayed:true,wikidata:true,batchSize:1,coverage:{total:2252,years:3,origins:146}};window.fetch=async(input,opt={})=>{const path=new URL(String(input),'https://wasp.invalid').pathname;let d={};if(path==='/api/me')d={admin:true,authenticated:true};else if(path==='/api/admin/version')d={version:'17.0.7',label:'HIVE Metadata Integration Hotfix'};else if(path==='/api/admin/telemetry/metadata'){if(opt.method==='PUT'){if(window.breakSave)return new Response('<!DOCTYPE html>secret error',{status:503});window.saved=JSON.parse(opt.body);const {apiKey,secret,...cfg}=window.saved;window.config={...window.config,...cfg,apiKeyConfigured:!!apiKey,secretConfigured:!!secret,credentialSource:'saved'};d={ok:true,apiKeyConfigured:true,credentialSource:'saved',encryptionReady:true}}else d=window.config;}else if(path.endsWith('/metadata/test')){window.testBody=JSON.parse(opt.body);if(window.breakTest)return new Response('<!DOCTYPE html>secret error',{status:503});d={ok:true,source:window.testBody.apiKey||window.testBody.contact?'entered':'saved'}}else if(path.endsWith('/metadata/run')){window.ran++;await new Promise(r=>setTimeout(r,350));window.config={...window.config,verified:3,verifiedTracks:1,verifiedArtists:1,coverage:{total:2252,years:120,origins:200}};d={verified:3,imported:0,errors:0}}else if(path==='/api/admin/network')d={share:true,peers:[]};else if(path==='/api/site')d={title:'WASP',name:'WASP',ad:{enabled:false}};return Response.json(d)}}''')
 p.evaluate('(code)=>(0,eval)(code)',bb+'\n'+js)
 p.locator('#netTelemetryPanel').wait_for();p.wait_for_function("document.querySelector('#metadataCredentialState').textContent.includes('Encrypted storage ready')")
 assert p.locator('#metadataYearPercent').inner_text()=='0.13%'
 assert p.locator('#metadataOriginPercent').inner_text()=='6.48%'
 assert p.locator('#metadataYearCount').inner_text()=='3 / 2,252 plays classified'
 assert p.locator('#metadataPriority').is_checked()
 p.locator('#metadataCoverageCard').scroll_into_view_if_needed()
 output=os.environ.get('WASP_PREVIEW_DIR')
 if output:p.locator('#metadataCoverageCard').screenshot(path=str(Path(output)/'WASP-v17.0.7-metadata-coverage-preview.png'))
 p.locator('[name=metadata-preference][value=lastfm]').check();p.locator('#metadataKey').fill('fake-api-key');p.locator('#metadataContact').fill('admin@example.invalid')
 p.locator('[data-metadata-test=lastfm]').click();p.wait_for_function("document.querySelector('#metadataLastfmStatus').textContent.includes('not saved') && window.testBody?.apiKey==='fake-api-key'")
 assert p.evaluate('window.saved') is None
 p.evaluate('window.breakTest=true');p.locator('[data-metadata-test=musicbrainz]').click();p.wait_for_function("document.querySelector('#metadataMusicbrainzStatus').textContent.includes('HTTP 503')")
 p.evaluate('window.breakSave=true');p.locator('#metadataForm button[type=submit]').click();p.wait_for_function("document.querySelector('#metadataStatus').textContent.includes('HTTP 503')");assert p.locator('#metadataKey').input_value()=='fake-api-key'
 p.evaluate('window.breakSave=false;window.breakTest=false');p.locator('#metadataEnabled').check();p.locator('#metadataForm button[type=submit]').click();p.wait_for_function("document.querySelector('#metadataCredentialState').textContent.includes('API key saved') && document.querySelector('#metadataKey').value==='' && !document.querySelector('#metadataRun').disabled")
 p.locator('[data-metadata-test=lastfm]').click();p.wait_for_function("document.querySelector('#metadataLastfmStatus').textContent.includes('saved configuration')")
 p.locator('#metadataScan').click();p.wait_for_function("!document.querySelector('#metadataProgressWrap').classList.contains('hidden') && !document.querySelector('#metadataProgress').hasAttribute('value')")
 p.wait_for_function("document.querySelector('#metadataProgress').value===100 && document.querySelector('#metadataVerifiedTracks').textContent==='1'")
 assert p.locator('#metadataYearCount').inner_text()=='120 / 2,252 plays classified'
 assert p.locator('#metadataCoverageStatus').inner_text().startswith('Batch complete')
 assert p.locator('#metadataVerifiedArtists').inner_text()=='1';assert p.locator('#metadataVerifiedFields').inner_text()=='3'
 assert p.locator('#metadataKey').input_value()=='';assert not errors,errors
 # Check non-overlap and dark native controls.
 assert p.locator('#metadataKey').bounding_box()['y'] < p.locator('#metadataSecret').bounding_box()['y']
 assert p.locator('#metadataMinutes').evaluate('(e)=>getComputedStyle(e).colorScheme')=='dark'
 output=os.environ.get('WASP_PREVIEW_DIR');p.locator('#netTelemetryPanel').scroll_into_view_if_needed()
 if output:p.locator('#netTelemetryPanel').screenshot(path=str(Path(output)/'WASP-v17.0.7-admin-telemetry-desktop.png'))
 p.set_viewport_size({'width':395,'height':850});p.wait_for_timeout(150)
 assert p.locator('#metadataForm').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
 assert p.locator('#metadataCoverageCard').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
 if output:p.locator('#metadataCoverageCard').screenshot(path=str(Path(output)/'WASP-v17.0.7-metadata-coverage-mobile.png'))
 b.close()
print('PASS v17.0.7 metadata coverage UI: provider tests, unsaved credentials, HTTP 503, save retry, real batch status, verified counters and responsive controls')
