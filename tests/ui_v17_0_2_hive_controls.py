"""Staging smoke: manual cron controls and My Playlists Spotify import remain usable."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
style=(P/'style.css').read_text()
adm=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',f'<style>{style}</style>',(P/'admin.html').read_text())
adm=re.sub(r'<script[^>]*src="/admin.js(?:\?v=[^"]+)?"[^>]*></script>','',adm)
admin_js=re.sub(r'^import .*?;\n','',(P/'admin.js').read_text(),flags=re.M)
app=re.sub(r'<link rel="stylesheet" href="/style.css(?:\?v=[^"]+)?">',f'<style>{style}</style>',(P/'index.html').read_text())
app=re.sub(r'<script[^>]*src="/app.js(?:\?v=[^"]+)?"[^>]*></script>','',app)
art=(P/'art.js').read_text().replace('export const ','const ').replace('const artistArt =','const _artistArt =').replace('const albumArt =','const _albumArt =')
radio=(P/'radio.js').read_text().replace('import { artistsOf } from "./art.js";','').replace('export function ','function ').replace('const shuffle =','const radioShuffle =').replace('shuffle(','radioShuffle(')
app_js=re.sub(r'^import .*?;\n','',(P/'app.js').read_text(),count=3,flags=re.M)
bb=re.sub(r'^export function ', 'function ', (P/'sidebar-bbcode.js').read_text(), flags=re.M)
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1200,'height':820});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('about:blank');page.set_content(adm);page.evaluate('location.hash="#network/crons"')
  page.evaluate('''window.__saved=null;window.__ran=[];window.fetch=async(input,opt={})=>{
    const u=new URL(String(input),'https://example.com'),p=u.pathname;let data={},status=200;
    if(p==='/api/me')data={admin:true,authenticated:true};
    else if(p==='/api/admin/version')data={version:'17.0.2',label:'HIVE Sync & Spotify Reconstruction'};
    else if(p==='/api/admin/network')data={share:true,peers:[]};
    else if(p==='/api/admin/crons'){
      if(opt.method==='PUT'){window.__saved=JSON.parse(opt.body);data={ok:true};}
      else data={timezone:'Asia/Manila',jobs:{telemetry:{enabled:true,minutes:5}}};
    }else if(p==='/api/admin/crons/run'){window.__ran.push(JSON.parse(opt.body).kind);data={ok:true,runId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'};status=202;}
    else if(p==='/api/admin/crons/run-status')data={state:'complete',kind:'telemetry',progress:100,message:'Complete'};
    else if(p==='/api/site')data={title:'WASP',name:'WASP',ad:{enabled:false}};
    return Response.json(data,{status});
  }''')
  page.evaluate('(s)=>(0,eval)(s)',bb+'\n'+admin_js)
  page.locator('[data-cron="telemetry"][data-field="enabled"]').wait_for(timeout=15000)
  assert page.locator('[data-cron="telemetry"][data-field="enabled"]').is_checked()
  assert page.locator('[data-cron="telemetry"][data-field="minutes"]').input_value()=='5'
  assert page.locator('[data-run-cron]').count()==5
  page.get_by_role('button',name='Grab telemetry now').click()
  page.wait_for_function("window.__ran.includes('telemetry')")
  page.locator('[data-progress="telemetry"] progress').wait_for(state='attached')
  page.locator('[data-cron="telemetry"][data-field="enabled"]').uncheck()
  page.get_by_role('button',name='Save schedules').click()
  page.wait_for_function('window.__saved!==null')
  assert page.evaluate('window.__saved.jobs.telemetry.enabled') is False
  assert not errors,errors
  page.close()
  p=browser.new_page(viewport={'width':1230,'height':800});errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
  p.goto('about:blank');p.set_content(app);p.evaluate('location.hash="#user/private"')
  p.evaluate('''window.__imported=false;window.fetch=async(input,opt={})=>{
    const u=new URL(String(input),'https://example.com'),path=u.pathname;let data=[],status=200;
    if(path==='/api/me')data={authenticated:true,admin:false,role:'user',username:'importer'};
    else if(path==='/api/site')data={name:'WASP',title:'WASP',ad:{enabled:false,html:''},sidebar:{enabled:false}};
    else if(path==='/api/catalog-version')data={revision:'rev1'};
    else if(path==='/api/user/playlists'||path==='/api/user-playlists'||path==='/api/user/spotify-imports')data=[];
    else if(path==='/api/user/spotify-import'&&opt.method==='POST'){window.__imported=true;data={ok:true,matched:1,total:2,missing:1,playlist_id:'pl'};status=201;}
    else if(path==='/api/network/peers'||path==='/api/tracks'||path==='/api/playlists'||path==='/api/recent-listens')data=[];
    else if(path==='/api/entity-reactions'||path==='/api/peer-reactions')data={};
    else if(path==='/api/user/peer-tracks'){data={error:'none'};status=401;}
    return Response.json(data,{status});
  }''')
  p.evaluate('(s)=>(0,eval)(s)',art+'\n'+radio+'\n'+app_js)
  p.locator('#spotifyImportForm').wait_for(timeout=15000)
  p.locator('#spotifyImportUrl').fill('https://open.spotify.com/playlist/7LQWEN3CgFCE9Q2gZ5Q7Zv')
  p.locator('#spotifyImportForm button[type="submit"]').click()
  p.wait_for_function('window.__imported',timeout=15000)
  assert not [e for e in errors if 'not defined' in e or 'Cannot' in e],errors
  browser.close()
print('PASS v17.0.2 UI: telemetry defaults, manual jobs and private Spotify import controls')
