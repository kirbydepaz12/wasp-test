"""Simulate the image-error event and verify the selected registered relay path.
The sandbox disallows real website navigation, so this is URL-selection only.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]/'public'
css=(P/'telemetry.css').read_text();js=(P/'telemetry-view.js').read_text()
report={'plays':3,'topArtists':[{'name':'Peer Band','plays':3,'origin_id':'peer-node'}],'artworkOrigins':[{'node_id':'peer-node','url':'http://100.64.0.4:8081'}]}
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox']);p=b.new_page()
 p.goto('about:blank');p.set_content('<html><head><style>'+css+'</style></head><body><main id="telemetryRoot"></main></body></html>')
 p.evaluate('''payload=>{window.calls=[];window.artAttempts=[];const src=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');Object.defineProperty(HTMLImageElement.prototype,'src',{get:src.get,set(v){window.artAttempts.push(String(v));src.set.call(this,v)},configurable:true});window.fetch=async input=>{calls.push(String(input));return Response.json(String(input).includes('/api/network/peers')?[{url:'http://100.64.0.4:8081',online:true,relay_base:'/_peer/registered'}]:String(input).includes('telemetry-world')?[]:payload)}}''',report)
 p.evaluate('(code)=>(0,eval)(code)',js);p.evaluate("window.postMessage({type:'wasp:telemetry-data',mode:'top',sub:'telemetry'},'*')")
 p.wait_for_function("window.artAttempts.some(v=>v.startsWith('/_peer/registered/art/artist'))")
 assert p.evaluate("window.artAttempts.every(v=>!v.includes('100.64.0.4'))")
 b.close()
print('PASS v17.0.5 artwork: synthetic local miss selects registered same-origin peer relay URL')
