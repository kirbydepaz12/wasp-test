"""Browser regression: v16 Mobile tab preserves WASP player and supports key lifecycle."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]/'public'
css=(ROOT/'style.css').read_text()
index=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',f'<style>{css}</style>',(ROOT/'index.html').read_text())
index=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',index)
art=(ROOT/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(ROOT/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
bb=re.sub(r'^export function ', 'function ', (ROOT/'sidebar-bbcode.js').read_text(), flags=re.M)
app_js=re.sub(r'^import .*?;\n','',(ROOT/'app.js').read_text(),count=3,flags=re.M)
bundle=bb+'\n'+art+'\n'+radio+'\n'+app_js
MOCK=r'''
window.__mobileTest={keys:[],requests:[],secrets:[]};
window.confirm=()=>true;
window.fetch=async(input,opts={})=>{
 const p=new URL(String(input),'https://wasp.invalid').pathname,m=opts.method||'GET',mt=window.__mobileTest;
 mt.requests.push([p,m]);let body=[],status=200;
 if(p==='/account-settings.html')return new Response(window.__accountHTML,{status:200,headers:{'content-type':'text/html'}});
 if(p==='/api/me')body={authenticated:true,role:'user',username:'mobiletest'};
 else if(p==='/api/site')body={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
 else if(p==='/api/catalog-version')body={revision:'a'};
 else if(p==='/api/tracks')body=[{id:'one',title:'A song',artist:'Artist',album:'Album',duration:200,plays:1,created_at:1700000000000}];
 else if(p==='/api/recent-listens')body=[{track_id:'one',origin:'',remote_id:'',title:'A song',artist:'Artist',album:'Album',played_at:Date.now()-20000,plays:1}];
 else if(['/api/active-streams','/api/requests','/api/playlists','/api/user-playlists','/api/network/peers'].includes(p))body=[];
 else if(['/api/peer-reactions','/api/entity-reactions'].includes(p))body={};
 else if(p==='/api/user/peer-tracks'){body={error:'none'};status=401;}
 else if(p==='/api/user/mobile-keys'&&m==='GET')body={enabled:true,secret_ready:mt.ready!==false,keys:mt.keys};
 else if(p==='/api/user/mobile-keys'&&m==='POST'){
    let label=JSON.parse(opts.body).label;const item={id:'key1',label,created_at:Date.now(),last_used:0};
    mt.keys.push(item);body={...item,secret:'wm_test_secret'};mt.secrets.push('wm_test_secret');status=201;
 }
 else if(p.startsWith('/api/user/mobile-keys/')&&m==='DELETE'){mt.keys=[];body={ok:true};}
 else if(p==='/api/user/publish')body={enabled:false,request_pending:false,links:[]};
 return Response.json(body,{status});
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1320,'height':820})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('about:blank');page.set_content(index)
 page.evaluate('(s)=>window.__accountHTML=s',(ROOT/'account-settings.html').read_text())
 page.evaluate('(s)=>(0,eval)(s)',MOCK)
 page.evaluate('location.hash="#listened"')
 page.evaluate('(s)=>(0,eval)(s)',bundle)
 page.locator('.recent-listen-meta').first.wait_for(timeout=20000)
 page.evaluate('''()=>{window.__musicNode=document.querySelector('#audio');window.__pauseCalls=0;window.__musicNode.pause=()=>{window.__pauseCalls++};}''')
 page.locator('#nav a[href="#settings"]').click()
 page.locator('#accountSettingsDialog[open] [data-settings-tab="mobile"]').click()
 page.locator('#createMobileKey').wait_for(timeout=10000)
 assert page.locator('#accountSettingsDialog [data-settings-tab]').count()==3
 assert page.locator('code').filter(has_text='/mobile').count()>0
 assert page.locator('#createMobileKey button[type="submit"]').is_enabled()
 page.locator('#createMobileKey input[name="label"]').fill('Android test app')
 page.locator('#createMobileKey button[type="submit"]').click()
 page.locator('#mobileSecretBox').get_by_text('wm_test_secret').wait_for(timeout=10000)
 assert page.locator('.mobile-key-pill').count()==1
 assert page.locator('.mobile-key-value').inner_text()=='wm_test_secret'
 assert page.locator('.mobile-key-copy[aria-label="Copy mobile app key"]').count()==1
 page.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value)=>{window.__copiedMobileKey=value}}})")
 page.locator('.mobile-key-copy').click()
 assert page.locator('.mobile-key-notice').inner_text()=='Mobile app key copied to clipboard!'
 assert page.evaluate('window.__copiedMobileKey')=='wm_test_secret' 
 assert page.evaluate('window.__mobileTest.keys.length')==1
 page.locator('#mobileKeyList [data-revoke-mobile="key1"]').click()
 page.wait_for_function('window.__mobileTest.keys.length===0')
 assert page.evaluate('window.__mobileTest.requests.some(x=>x[0].endsWith("/key1")&&x[1]==="DELETE")')
 page.evaluate('window.__mobileTest.ready=false')
 page.locator('#accountSettingsDialog [data-settings-tab="account"]').click()
 page.locator('#accountSettingsDialog [data-settings-tab="mobile"]').click()
 page.locator('#createMobileKey button[type="submit"]').wait_for(timeout=10000)
 assert page.locator('#createMobileKey button[type="submit"]').is_disabled()
 assert 'Setup required' in page.locator('#accountSettingsContent').inner_text()
 page.keyboard.press('Escape')
 page.locator('#accountSettingsDialog').wait_for(state='hidden',timeout=10000)
 assert page.evaluate('location.hash')=='#listened'
 assert page.evaluate('document.querySelector("#audio")===window.__musicNode && window.__pauseCalls===0')
 assert not [x for x in errors if 'Failed to construct' not in x],errors
 browser.close()
 print('PASS v16 Mobile Bridge UI: create/revoke keys inside modal, 3 tabs, original web playback not interrupted')
