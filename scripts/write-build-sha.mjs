import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const valid=value=>/^[a-f\d]{40}$/i.test(String(value||''))?String(value).toLowerCase():'';
let sha=valid(process.env.WASP_BUILD_SHA)||valid(process.env.WORKERS_CI_COMMIT_SHA)||valid(process.env.GITHUB_SHA);
if(!sha){try{sha=valid(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim());}catch{}}
writeFileSync('src/build-commit.js',`// Generated at build time. No credentials stored here.\nexport const BUILD_COMMIT=${JSON.stringify(sha||'')};\n`);
