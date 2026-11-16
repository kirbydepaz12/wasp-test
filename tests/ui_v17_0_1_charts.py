"""Standalone telemetry visualizations and keyboard/pointer interactions with sample aggregates."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]/'public'
css=(ROOT/'telemetry.css').read_text();js=(ROOT/'telemetry-view.js').read_text();shapes=json.loads((ROOT/'telemetry-world.json').read_text())
report={"plays":80,"previousPlays":60,"artists":9,"albums":12,"tracks":17,"topArtists":[],"topAlbums":[],"topTracks":[],
 "series":[{'label':'2026-09','plays':17},{'label':'2026-10','plays':28},{'label':'2026-11','plays':35}],
 "hours":[{'hour':21,'plays':20},{'hour':22,'plays':60}],"weekdays":[{'weekday':4,'plays':80}],
 "topTags":[{'name':'metal','plays':60,'periods':[{'label':'2026-09','plays':16},{'label':'2026-10','plays':26},{'label':'2026-11','plays':18}]},
 {'name':'rock','plays':20,'periods':[{'label':'2026-09','plays':1},{'label':'2026-10','plays':2},{'label':'2026-11','plays':17}]}],
 "decades":[{'decade':2000,'plays':45,'albums':7,'artists':3,'tracks':14,'topAlbum':'Meteora','topArtist':'Linkin Park'},
 {'decade':1990,'plays':12,'albums':2,'artists':1,'tracks':3,'topAlbum':'Album','topArtist':'Band'}],
 "countries":[{'code':'USA','plays':60,'artists':3},{'code':'GBR','plays':8,'artists':2}],
 "unknownCountryPlays":12,"yearMetadataPlays":57,"nodes":2,"connectedCaches":1,"lastSynced":1794830000000,
 "repeatRate":.7,"concentration":.3,"consistency":.15,"activeDays":8,"longestStreak":3,"mostActiveDay":"2026-11-16","mostActiveDayPlays":35,"busiestHour":22,"busiestHourPlays":60}
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1200,'height':900});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('about:blank');page.set_content('<!doctype html><html><head><style>'+css+'</style></head><body><main id="telemetryRoot">Loading</main></body></html>')
 page.evaluate('(payload)=>{window.fetch=async input=>Response.json(String(input).includes("telemetry-world.json")?payload.shapes:payload.report)}',{'shapes':shapes,'report':report})
 page.evaluate('(code)=>(0,eval)(code)',js)
 page.evaluate('''()=>window.postMessage({type:'wasp:telemetry-data',mode:'top',sub:'telemetry',items:[]},'*')''')
 page.locator('.clock-sector').first.wait_for();page.locator('.map-country').first.wait_for()
 assert page.locator('.clock-sector').count()==24
 assert page.locator('.genre-layer').count()==2
 assert page.locator('.decade-row').count()==2
 assert page.locator('.map-country').count()>100
 page.locator('.clock-sector.has-plays').last.hover();assert 'confirmed plays' in page.locator('.telemetry-tooltip').inner_text()
 page.locator('.tag-key').first.hover();assert page.locator('.genre-layer.highlighted').count()==1
 assert page.locator('.genre-layer.dimmed').count()==1
 page.locator('.bar-slot').first.hover();assert 'confirmed plays' in page.locator('.telemetry-tooltip').inner_text()
 page.locator('.decade-row').first.hover();assert 'Top album' in page.locator('.telemetry-tooltip').inner_text()
 page.locator('.map-country.active').first.hover();assert 'confirmed plays' in page.locator('.telemetry-tooltip').inner_text()
 page.mouse.move(5,5)
 page.screenshot(path='/mnt/data/WASP-v17.0.1-telemetry-desktop-preview.png',full_page=True)
 page.set_viewport_size({'width':395,'height':820});page.screenshot(path='/mnt/data/WASP-v17.0.1-telemetry-mobile-preview.png',full_page=True)
 assert not errors,errors
 browser.close()
print('PASS v17.0.1: radial clock, genre stream highlight, history counts, country heatmap, decades and responsive layout')
