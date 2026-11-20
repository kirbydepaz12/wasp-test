"""Independent filter regression: real browser with deterministic API data."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]/'public'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':1200,'height':900}); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_default_timeout(5000);page.goto('about:blank');page.set_content('<style>'+(ROOT/'telemetry.css').read_text()+'</style><main id="telemetryRoot"></main>')
    page.evaluate('''()=>{window.calls=[];window.fetch=async input=>{if(String(input).includes('telemetry-world.json'))return Response.json({});const q=new URL(String(input),'https://wasp.example').searchParams,p=q.get('period');calls.push(p);const n={week:7,month:30,year:12,all:3}[p];const series=Array.from({length:n},(_,i)=>({label:p==='year'||p==='all'?`2025-${String(i+1).padStart(2,'0')}`:`2025-01-${String(i+1).padStart(2,'0')}`,plays:i+1}));return Response.json({plays:30,artists:2,albums:2,tracks:2,series,hours:[],weekdays:[],topArtists:[],topAlbums:[],topTracks:[],topTags:[{name:'rock',plays:30,periods:series}],decades:[],countries:[],refreshMs:60000});}}''')
    page.evaluate('(code)=>(0,eval)(code)',(ROOT/'telemetry-view.js').read_text());page.evaluate("()=>window.postMessage({type:'wasp:telemetry-data',mode:'top',sub:'telemetry',items:[]},'*')")
    page.locator('[data-tile-card="genres"]').wait_for();assert page.locator('[data-tile-period="week"].active').count()==9
    page.evaluate('()=>window.historyTile=document.querySelector(\'[data-tile-card="history"]\')')
    page.locator('[data-tile="genres"][data-tile-period="month"]').click();page.locator('[data-tile="genres"][data-tile-period="month"].active').wait_for();assert page.locator('[data-period="week"].active').count()==1;assert page.evaluate('()=>historyTile===document.querySelector(\'[data-tile-card="history"]\')')
    page.locator('[data-tile="albums"][data-tile-period="month"]').click();page.locator('[data-tile="albums"][data-tile-period="month"].active').wait_for();assert page.evaluate("()=>calls.filter(x=>x==='month').length")==1
    page.locator('[data-period="year"]').click();page.locator('[data-tile="history"][data-tile-period="year"].active').wait_for();assert page.locator('[data-tile-period="year"].active').count()==9;assert page.locator('.bar-slot').count()>=12;assert '01/25' in page.locator('[data-tile-card="genres"]').inner_text()
    page.locator('[data-period="all"]').click();page.locator('[data-tile="history"][data-tile-period="all"].active').wait_for();assert page.locator('[data-tile-period="all"].active').count()==9
    page.evaluate("()=>window.postMessage({type:'wasp:telemetry-data',mode:'top',sub:'ranked',items:[]},'*')");page.locator('.browse-grid, .message').last.wait_for();page.evaluate("()=>window.postMessage({type:'wasp:telemetry-data',mode:'top',sub:'telemetry',items:[]},'*')");page.locator('[data-tile="history"][data-tile-period="week"].active').wait_for();assert page.locator('[data-tile-period="week"].active').count()==9
    assert not errors,errors;b.close()
print('PASS v18.0.3: default week, nine card filters, cache sharing, isolated card, global reset and monthly labels')
