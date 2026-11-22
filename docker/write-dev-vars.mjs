// Local Wrangler reads this file at startup. Never print credential values.
import fs from 'node:fs';
import path from 'node:path';
export function writeDevVars({env=process.env,directory='/app'}={}) {
  const file=path.join(directory,'.dev.vars');
  const keys=['METADATA_SETTINGS_KEY','LASTFM_API_KEY','LASTFM_SHARED_SECRET','GITHUB_UPDATES_TOKEN'];
  // Keep existing Spotify binding behavior; changing the Spotify encryption key here
  // could make older installations unable to decrypt their saved Spotify credentials.
  if(env.SPOTIFY_CLIENT_ID&&env.SPOTIFY_CLIENT_SECRET)keys.push('SPOTIFY_CLIENT_ID','SPOTIFY_CLIENT_SECRET');
  const content=keys.filter(k=>typeof env[k]==='string'&&env[k].length).map(k=>k+'='+JSON.stringify(env[k])).join('\n');
  if(!content){fs.rmSync(file,{force:true});return;}
  const temp=file+'.tmp';fs.rmSync(temp,{force:true});
  try{fs.writeFileSync(temp,content+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname)writeDevVars();
