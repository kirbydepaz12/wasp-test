import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeDevVars} from '../docker/write-dev-vars.mjs';
test('Docker forwards independent metadata variables securely and preserves optional Spotify behavior',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wasp-vars-'));const file=path.join(directory,'.dev.vars');
 try{writeDevVars({directory,env:{METADATA_SETTINGS_KEY:'test-encryption-key',LASTFM_API_KEY:'mock-api-key',LASTFM_SHARED_SECRET:'mock-shared-secret'}});let raw=fs.readFileSync(file,'utf8');assert.match(raw,/METADATA_SETTINGS_KEY="test-encryption-key"/);assert.match(raw,/LASTFM_API_KEY="mock-api-key"/);assert.match(raw,/LASTFM_SHARED_SECRET="mock-shared-secret"/);assert.equal(fs.statSync(file).mode&0o777,0o600);assert.doesNotMatch(raw,/SPOTIFY_CLIENT_ID/);
 writeDevVars({directory,env:{SPOTIFY_CLIENT_ID:'mock-id',SPOTIFY_CLIENT_SECRET:'mock-secret',LASTFM_API_KEY:'only-key'}});raw=fs.readFileSync(file,'utf8');assert.match(raw,/SPOTIFY_CLIENT_ID="mock-id"/);assert.match(raw,/LASTFM_API_KEY="only-key"/);assert.doesNotMatch(raw,/LASTFM_SHARED_SECRET/);writeDevVars({directory,env:{}});assert.equal(fs.existsSync(file),false);
 assert.match(fs.readFileSync(new URL('../docker/start.sh',import.meta.url),'utf8'),/node \/app\/docker\/write-dev-vars\.mjs/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
