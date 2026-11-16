import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../public/admin.js',import.meta.url),'utf8');
const sample=source.match(/const SAMPLE_AD = `([\s\S]*?)`;\s*\$\("#spSample"\)/)?.[1];
test('Sample ad retains HIVE six-slide ordering and CTA links',()=>{
 assert.ok(sample,'admin sample should be extractable');
 assert.equal((sample.match(/class="slide s\d/g)||[]).length,6);
 const hive=sample.indexOf('BE PART OF THE SWARM. EXPAND THE HIVE.');
 const shuffle=sample.indexOf('Shuffle the pit');
 assert.ok(hive>0 && shuffle>hive);
 assert.match(sample,/https:\/\/github\.com\/KNDPZ\/WASP/);
 assert.match(sample,/href="#settings"/);
 assert.match(sample,/function start\(\)/);
});
