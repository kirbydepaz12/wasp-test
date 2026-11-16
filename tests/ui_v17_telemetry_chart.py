"""Visual browser smoke for the standalone first-party telemetry document."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]/'public'
css=(ROOT/'telemetry.css').read_text();js=(ROOT/'telemetry-view.js').read_text()
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1230,'height':840})
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('about:blank')
  page.set_content('<!doctype html><html><head><style>'+css+'</style></head><body><main id="telemetryRoot">Loading</main></body></html>')
  report={'plays':37,'previousPlays':26,'artists':12,'albums':19,'tracks':28,'topArtists':[{'name':'Slipknot','plays':11},{'name':'Linkin Park','plays':8}],
    'topAlbums':[{'name':'Hybrid Theory','artist':'Linkin Park','plays':8}],
    'topTracks':[{'name':'Wait and Bleed','artist':'Slipknot','album':'Slipknot','plays':9}],
    'series':[{'label':'2026-10','plays':12},{'label':'2026-11','plays':25}],
    'weekdays':[{'weekday':1,'plays':7},{'weekday':2,'plays':30}],
    'hours':[{'hour':21,'plays':21},{'hour':22,'plays':16}],
    'nodes':3,'connectedCaches':2,'lastSynced':1794830000000,
    'historicalCoverage':'Retained history is incomplete.',
    'repeatRate':.4,'concentration':.3,'consistency':.1,
    'activeDays':5,'longestStreak':3,'mostActiveDay':'2026-11-16','mostActiveDayPlays':17,'busiestHour':21,'busiestHourPlays':21}
  page.evaluate('(data)=>{window.__testReport=data;window.fetch=async()=>Response.json(window.__testReport);}',report)
  page.evaluate('(js)=>(0,eval)(js)',js)
  page.evaluate('''()=>window.postMessage({type:'wasp:telemetry-data',mode:'top',sub:'telemetry',items:[]},'*')''')
  page.get_by_text('HIVE Telemetry').first.wait_for(timeout=12000)
  page.locator('.metric').first.wait_for(timeout=12000)
  assert page.locator('.metric').count()==4
  assert page.get_by_text('Most played music').count()==1
  assert page.get_by_text('Listening fingerprint & quick facts').count()==1
  page.get_by_role('button',name='Month',exact=True).click()
  assert page.locator('select#month').count()==1
  page.locator('#month').select_option('10')
  page.locator('#scope').select_option('local')
  page.get_by_role('button',name='Previous period').click()
  assert page.locator('.metric').count()==4
  assert not errors,errors
  page.screenshot(path='/mnt/data/WASP-v17-telemetry-dashboard-preview.png',full_page=True)
  page.set_viewport_size({'width':380,'height':820})
  page.screenshot(path='/mnt/data/WASP-v17-telemetry-mobile-preview.png',full_page=True)
  browser.close()
print('PASS v17: telemetry document charts, date changes, scope selection, desktop and mobile rendering')
