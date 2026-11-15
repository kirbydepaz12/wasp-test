"""Browser regression for v15.0.8 HTML-backed Account Settings overlay."""
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
window.__mock={authenticated:true,username:'test',approved:true,enabled:false,pending:false,links:[],lastPost:null,reads:[]};
window.fetch=async(input,opts={})=>{
 const p=new URL(String(input),'https://wasp.invalid').pathname,m=opts.method||'GET',mock=window.__mock;
 mock.reads.push([p,m]);let body=[],status=200;
 if(p==='/account-settings.html')return new Response(window.__accountHTML,{status:200,headers:{'content-type':'text/html'}});
 if(p==='/api/me')body=mock.authenticated?{authenticated:true,role:'user',username:mock.username,publish_notice:mock.approved}:{authenticated:false};
 else if(p==='/api/site')body={name:'WASP',title:'WASP',sidebar:{enabled:false},ad:{enabled:false}};
 else if(p==='/api/catalog-version')body={revision:'a'};
 else if(p==='/api/tracks')body=Array.from({length:40},(_,i)=>({id:'song'+i,title:'Song '+i,artist:'Singer',album:'Album',duration:180,plays:4,created_at:1700000000000}));
 else if(p==='/api/recent-listens')body=Array.from({length:32},(_,i)=>({track_id:'song'+i,origin:'',remote_id:'',title:'Song '+i,artist:'Singer',album:'Album',played_at:Date.now()-300000-i*60000,plays:4}));
 else if(['/api/active-streams','/api/requests','/api/playlists','/api/user-playlists','/api/network/peers'].includes(p))body=[];
 else if(['/api/peer-reactions','/api/entity-reactions'].includes(p))body={};
 else if(p==='/api/user/peer-tracks'){body={error:'none'};status=401;}
 else if(p==='/api/user/publish'&&m==='GET'){body={enabled:mock.enabled,request_pending:mock.pending,links:mock.links};mock.approved=false;}
 else if(p==='/api/user/publish/request'&&m==='POST'){mock.pending=true;body={ok:true};}
 else if(p==='/api/user/publish'&&m==='POST'){const data=JSON.parse(opts.body);mock.links.push({id:'link1',url:data.url,name:'Peer',online:false,track_count:0});body={ok:true};}
 else if(p.startsWith('/api/user/publish/')&&m==='DELETE'){mock.links=[];body={ok:true};}
 else if(p==='/api/user/username'&&m==='PUT'){const data=JSON.parse(opts.body);mock.lastPost={path:p,data};mock.username=data.username;body={ok:true};}
 else if(p==='/api/user/password'&&m==='POST'){mock.lastPost={path:p,data:JSON.parse(opts.body)};body={ok:true};}
 return Response.json(body,{status});
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1320,'height':840})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('about:blank');page.set_content(index)
 page.evaluate('(s)=>window.__accountHTML=s',(ROOT/'account-settings.html').read_text())
 page.evaluate('(s)=>(0,eval)(s)',MOCK)
 page.evaluate('location.hash="#listened"')
 page.evaluate('(s)=>(0,eval)(s)',bundle)
 page.locator('.recent-listen-meta').first.wait_for(timeout=20000)
 assert page.locator('#nav a[href="#settings"]').count()==1
 assert page.locator('#nav a[href="#request"]').count()==1
 page.evaluate('''()=>{window.__listBefore=document.querySelector('#list');window.__tileBefore=document.querySelector('.recent-listen-meta');window.__pauseCalls=0;window.__loadCalls=0;const a=document.querySelector('#audio');a.pause=()=>{window.__pauseCalls++};a.load=()=>{window.__loadCalls++};}''')
 page.evaluate('window.scrollTo(0,320)')
 prior_scroll=page.evaluate('window.scrollY')
 assert prior_scroll>0,prior_scroll
 # sidebar opens without navigation or replacing music view
 page.evaluate('document.querySelector(\'#nav a[href="#settings"]\').click()')
 page.locator('#accountSettingsDialog[open] #changeUsernameForm').wait_for(timeout=15000)
 assert page.evaluate('location.hash')=='#listened'
 assert page.evaluate('document.querySelector("#list")===window.__listBefore && document.querySelector(".recent-listen-meta")===window.__tileBefore')
 assert page.evaluate('[window.__pauseCalls,window.__loadCalls]')==[0,0]
 assert abs(page.evaluate("window.scrollY")-prior_scroll)<2
 assert page.locator('#accountSettingsDialog [data-settings-tab]').count()==3
 assert page.locator('#accountSettingsDialog [data-settings-tab="request"]').count()==0
 assert page.locator('#accountSettingsDialog #accountSettingsContent #request').count()==0
 # account username change uses prior API, maintains popup
 page.locator('#changeUsernameForm input[name="username"]').fill('newname')
 page.locator('#changeUsernameForm input[name="password"]').fill('correct-password')
 page.locator('#changeUsernameForm button[type="submit"]').click()
 page.locator('#usernameFeedback').get_by_text('Username updated.').wait_for(timeout=10000)
 assert page.locator('#whoami').inner_text()=='newname'
 assert page.evaluate('window.__mock.lastPost.path')=='/api/user/username'
 assert page.locator('#accountSettingsDialog').evaluate('e=>e.open')
 # password update in popup, no route change
 page.locator('#changePasswordForm input[name="current"]').fill('current-password')
 page.locator('#changePasswordForm input[name="password"]').fill('new-password-123')
 page.locator('#changePasswordForm input[name="confirm"]').fill('new-password-123')
 page.locator('#changePasswordForm button').click()
 page.locator('#passwordFeedback').get_by_text('Password changed successfully.').wait_for(timeout=10000)
 assert page.evaluate('window.__mock.lastPost.path')=='/api/user/password'
 assert page.evaluate('location.hash')=='#listened'
 # publish request and permission approval stay in modal
 page.locator('[data-settings-tab="publish"]').click()
 page.locator('#requestPublish').wait_for(timeout=15000)
 page.locator('#requestPublish').click()
 page.locator('.publish-pending').wait_for(timeout=15000)
 page.evaluate('window.__mock.enabled=true;window.__mock.pending=false;window.__mock.approved=true;refreshAccount()')
 page.locator('#nav a[href="#settings"] .notice-expanded').wait_for(timeout=10000)
 page.locator('[data-settings-tab="account"]').click()
 page.locator('#changeUsernameForm').wait_for(timeout=15000)
 page.locator('[data-settings-tab="publish"] .publish-subtab-dot').wait_for(timeout=10000)
 page.locator('[data-settings-tab="publish"]').click()
 page.locator('#publishLinkForm').wait_for(timeout=10000)
 assert page.locator('#nav a[href="#settings"] .notice-expanded').count()==0
 assert page.locator('[data-settings-tab="publish"] .publish-subtab-dot').count()==0
 page.locator('#publishUrl').fill('https://peer.example.com')
 page.locator('#publishLinkForm button[type=submit]').click()
 page.locator('#myPublishedLinks').get_by_text('peer.example.com',exact=False).wait_for(timeout=10000)
 assert page.evaluate('window.__mock.links.length')==1
 assert page.evaluate('[window.__pauseCalls,window.__loadCalls]')==[0,0]
 # dismiss: music page remains, keyboard and background position intact
 page.keyboard.press('Escape')
 page.locator('#accountSettingsDialog').wait_for(state='hidden',timeout=10000)
 assert page.evaluate('location.hash')=='#listened'
 assert page.evaluate('document.querySelector("#list")===window.__listBefore')
 assert abs(page.evaluate("window.scrollY")-prior_scroll)<2
 # account dropdown uses same modal, with explicit close X
 page.locator('#gear').hover()
 page.locator('#accountSettingsLink').click()
 page.locator('#changeUsernameForm').wait_for(timeout=10000)
 page.locator('#accountSettingsClose').click()
 page.locator('#accountSettingsDialog').wait_for(state='hidden',timeout=10000)
 # old deep-link #settings/publish: converted in-place without redirecting from listening
 page.evaluate('location.hash="#settings/publish"')
 page.locator('#publishLinkForm').wait_for(timeout=10000)
 assert page.evaluate('location.hash')=='#settings/publish'  # opaque about:blank test origin cannot replaceState
 page.locator('#accountSettingsClose').click()
 # guest: Request is still visible and settings gated
 page.evaluate('window.__mock.authenticated=false;location.hash="#listened"')
 page.evaluate('refreshAccount()')
 page.evaluate('render()')
 assert page.locator('#nav a[href="#request"]').count()==1
 assert page.locator('#nav a[href="#settings"]').count()==0
 # Small screens keep the dialog within viewport and its content scrollable.
 page.set_viewport_size({'width':390,'height':740})
 page.evaluate('async()=>{window.__mock.authenticated=true;await refreshAccount();render()}')
 page.evaluate('document.querySelector(\'#nav a[href="#settings"]\').click()')
 page.locator('#accountSettingsDialog[open] #changeUsernameForm').wait_for(timeout=10000)
 box=page.locator('#accountSettingsDialog').bounding_box()
 assert box['x']>=0 and box['x']+box['width']<=391,box
 assert box['y']>=0 and box['y']+box['height']<=741,box
 assert not [err for err in errors if 'Failed to construct' not in err],errors
 browser.close()
 print('PASS v15.0.8: HTML modal, playback/scroll/route preserved, username/password, publish request/notice, deep link, guest Request')
