"""Chromium functional/layout regression for v18.1.4 daily HIVE telemetry calendar.
Offline fixture: never calls real Cloudflare, music sites, or GitHub.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]/'public'
CSS=(ROOT/'telemetry.css').read_text()
JS=(ROOT/'telemetry-view.js').read_text()
MOCK="""({
 plays:17,previousPlays:10,artists:3,albums:4,tracks:6,
 topArtists:[{name:'Local artist',plays:6}],topAlbums:[],topTracks:[],
 series:[{label:'2026-11-16',plays:3}],weekdays:[{weekday:1,plays:6}],hours:[{hour:9,plays:17}],
 nodes:2,connectedCaches:1,lastSynced:0,refreshMs:300000,
 countries:[],topTags:[],decades:[],artworkOrigins:[],
 historicalCoverage:'History since v17 confirmed listens.',
 activeDays:3,longestStreak:2,mostActiveDay:'2026-11-17',mostActiveDayPlays:9,
 busiestHour:9,busiestHourPlays:8,repeatRate:.5,concentration:.3,consistency:.1
})"""
SETUP="""(report)=>{
 window.__fetchCalls=[];
 window.fetch=async(input)=>{
   const url=String(input); window.__fetchCalls.push(url);
   if(url.startsWith('/api/telemetry/heatmap')){
     const q=new URL(url, 'https://wasp.example').searchParams;
     const isYear=q.get('range')==='year';
     return Response.json({range:isYear?'year':'rolling',scope:q.get('scope'),year:Number(q.get('year')),
       startDate:isYear?'2026-01-01':'2025-11-24',endDate:isYear?'2026-12-31':'2026-11-23',
       plays:q.get('scope')==='local'?4:17,
       days:[{day:'2026-06-10',plays:1},{day:'2026-06-11',plays:3},{day:'2026-06-12',plays:7},
         {day:'2026-06-13',plays:q.get('scope')==='local'?0:12}],refreshMs:300000});
   }
   if(url.includes('/api/telemetry?'))return Response.json(report);
   if(url.includes('/api/network/peers'))return Response.json([]);
   return Response.json({});
 };
}"""

with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width,height in [(1440,900),(390,820)]:
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content('<!doctype html><html><head><style>'+CSS+'</style></head><body><main id="telemetryRoot">Loading</main></body></html>')
  page.evaluate(SETUP,page.evaluate(MOCK))
  page.evaluate('(code)=>(0,eval)(code)',JS)
  page.evaluate("()=>window.postMessage({type:'wasp:telemetry-data',mode:'top',sub:'telemetry',items:[]},'*')")
  page.locator('.hive-heatmap-panel .heat-day.level-4').wait_for(timeout=25000)
  assert page.locator('.hive-heatmap-panel').count()==1
  assert page.get_by_text('Across the HIVE').count()==1
  assert page.locator('.hive-heatmap-panel .heat-day:not(.outside)').count()==365
  assert page.locator('.hive-heatmap-panel .heatmap-months span').count()>=12
  assert page.locator('.hive-heatmap-panel .level-0:not(.heatmap-legend i)').count()>200
  assert '17 plays' in page.locator('.heatmap-total').inner_text()
  assert page.locator('.heat-day[aria-label*="June 13, 2026: 12 confirmed plays"]').count()==1
  assert page.locator('.heat-day.level-1').count()==1
  assert page.locator('.heat-day.level-2').count()==1
  assert page.locator('.heat-day.level-3').count()==1
  assert page.locator('.heat-day.level-4').count()==1
  assert page.locator('.heatmap-legend i').count()==5
  assert page.get_by_text('Days of the week').count()==1
  assert page.locator('.hive-heatmap-panel').bounding_box()['width']>0
  if width==390:
   assert page.locator('.heatmap-scroll').evaluate('(x)=>x.scrollWidth>x.clientWidth')
   assert page.locator('.hive-heatmap-panel').bounding_box()['width']<=width+1
  path='/mnt/data/WASP-v18.1.4-heatmap-'+('desktop' if width>600 else 'mobile')+'.png'
  page.locator('.hive-heatmap-panel').screenshot(path=path)
  page.locator('#heatmapRange').select_option('year')
  page.wait_for_function("()=>document.querySelector('.heatmap-total')?.textContent.includes('in 2026')")
  assert page.locator('.hive-heatmap-panel .heat-day:not(.outside)').count()==365
  assert any('range=year' in x for x in page.evaluate('window.__fetchCalls'))
  page.locator('#scope').select_option('local')
  page.wait_for_function("()=>document.querySelector('.heatmap-total')?.textContent.includes('4 plays')")
  assert any('scope=local' in x and '/api/telemetry/heatmap' in x for x in page.evaluate('window.__fetchCalls'))
  page.locator('#heatmapRange').select_option('rolling')
  page.wait_for_function("()=>document.querySelector('.heatmap-total')?.textContent.includes('last 365 days')")
  assert page.locator('.heatmap-scroll').count()==1
  assert not errors,errors
  page.close()
 browser.close()
print('PASS v18.1.4: daily HIVE heatmap, scopes/ranges, 365 cells, 4 levels, desktop/mobile')
