"""Browser regression: Mobile Bridge moved to Network and manages D1 secrets."""
from pathlib import Path
from playwright.sync_api import sync_playwright
p=Path(__file__).resolve().parents[1]
html=(p/'public/admin.html').read_text().replace('<script type="module" src="/admin.js?v=16.0.2"></script>','')
css=(p/'public/style.css').read_text()
html=html.replace('<link rel="stylesheet" href="/style.css?v=16.0.2">',f'<style>{css}</style>')
src=(p/'public/admin.js').read_text()
segment=src[src.index('// WASP v16.0.2 Mobile Bridge:'):src.index('// ---------- general settings: branding')]
nav=src[src.index('let cronsLoaded=false;'):src.index('function cronJobTemplate(key){')]
script="""const $=s=>document.querySelector(s);
const post=(url,body,method='POST')=>fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function loadCrons(){};
window.__state={enabled:true,secret_ready:false,secret_source:'none',keys:[],events:[]};
window.fetch=async(url,opts={})=>{
 let a=window.__state,m=opts.method||'GET',b=opts.body?JSON.parse(opts.body):{};
 a.events.push([url,m,b]);
 if(url==='/api/admin/mobile-bridge'&&m==='PUT')a.enabled=b.enabled;
 if(url==='/api/admin/mobile-bridge/secret'&&m==='POST'){
    if(b.action==='generate'||b.action==='import'){
      if(a.secret_ready)return Response.json({error:'Already configured'},{status:409});
      a.secret_ready=true;a.secret_source='wasp';
    }else if(b.action==='rotate'){
      if(b.confirm!=='RESET')return Response.json({error:'Type RESET'},{status:400});
      a.keys=[];
    }else if(b.action==='migrate')a.secret_source='wasp';
 }
 return Response.json({enabled:a.enabled,secret_ready:a.secret_ready,secret_source:a.secret_source,ok:true,revoked_all:b.action==='rotate'});
};
"""
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1250,'height':950});errors=[]
 page.on('pageerror',lambda e: errors.append(str(e)))
 page.goto('about:blank');page.set_content(html)
 page.locator('#panel').evaluate("e=>e.classList.remove('hidden')")
 page.locator('#s-network').evaluate("e=>e.classList.remove('hidden')")
 page.evaluate(script+segment+nav)
 page.evaluate("showNetworkTab('mobile')")
 assert page.locator('#netTabMobile').get_attribute('aria-selected')=='true'
 assert page.locator('#netMobilePanel').is_visible()
 assert not page.locator('#netCronsPanel').is_visible()
 assert not page.locator('#netPeersPanel').is_visible()
 assert page.locator('#s-settings #mobileBridgeAdminPanel').count()==0
 page.get_by_text('Setup required — server encryption secret is missing.').wait_for()
 page.locator('#mobileSecretGenerate').click()
 page.get_by_text('Encryption configured — mobile credentials can be issued').wait_for()
 assert page.locator('#mobileSecretResetControls').is_visible()
 assert not page.locator('#mobileSecretSetup').is_visible()
 page.locator('#mobileSecretResetStart').click()
 page.locator('#mobileSecretResetWord').fill('RESET')
 page.locator('#mobileSecretResetForm button[type="submit"]').click()
 page.get_by_text('All previous mobile app keys have been revoked.').wait_for()
 assert page.evaluate("window.__state.events.some(x=>x[0]==='/api/admin/mobile-bridge/secret' && x[2].action==='rotate' && x[2].confirm==='RESET')")
 page.locator('#netTabCrons').click()
 assert not page.locator('#netMobilePanel').is_visible()
 page.locator('#netTabMobile').click()
 assert page.locator('#netMobilePanel').is_visible()
 assert not errors,errors
 browser.close()
 print('PASS Mobile Bridge admin: moved Network tab, missing/setup ready, rotate confirmation, tab switching')
