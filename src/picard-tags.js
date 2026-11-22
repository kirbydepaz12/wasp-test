// v18.0.7: byte-bounded, read-only Picard/ID3v2 parser. Never infer artist
// origin from an album's release country (often 'XW' = worldwide).
import {countries} from './country-codes.js';
const dec=new TextDecoder('windows-1252');
const yyyy=v=>{const m=String(v||'').match(/^(18[5-9]\d|19\d\d|20\d\d)(?:-\d\d(?:-\d\d)?)?$/);const y=m?+m[1]:0;return y<=new Date().getUTCFullYear()+1?y:0;};
export const countryISO=v=>{const n=String(v||'').trim().toUpperCase();return countries[n]|| (Object.values(countries).includes(n)?n:'');};
function string(bytes,enc){let data=bytes;let coding=enc===0?'windows-1252':enc===3?'utf-8':enc===2?'utf-16be':'utf-16le';if(enc===1){if(data[0]===0xfe&&data[1]===0xff){coding='utf-16be';data=data.slice(2);}else if(data[0]===0xff&&data[1]===0xfe){coding='utf-16le';data=data.slice(2);}}return new TextDecoder(coding).decode(data).replaceAll('\ufeff','');}
function fields(bytes){const enc=bytes[0];if(enc>3)return ['', ''];let n=enc===1||enc===2?2:1,p=1;for(;p+n<=bytes.length;p+=n){if(n===1?bytes[p]===0:bytes[p]===0&&bytes[p+1]===0)break;}return [string(bytes.slice(1,p),enc),string(bytes.slice(p+n),enc)];}
function values(bytes){const e=bytes[0];if(e>3)return [];return string(bytes.slice(1),e).split(/\0|;/).map(x=>x.trim()).filter(Boolean);}
export function parsePicardFrames(frameList){const tags={};const user={};let date='',originalDate='';
  for(const frame of frameList){const id=frame.id,bytes=frame.data;if(!bytes?.length)continue;
    if(id==='TXXX'){const [name,value]=fields(bytes);user[name.toLowerCase()]=value.replace(/^\0+|\0+$/g,'');continue;}
    if(id==='POPM'&&bytes.length>2){const end=bytes.indexOf(0);if(end>=0&&end+1<bytes.length){tags.embedded_rating=bytes[end+1]/255*5;}continue;}
    if(id==='USLT'){const [unused,lyric]=fields(Uint8Array.from([bytes[0],...bytes.subarray(4)]));if(lyric&&lyric.length<=120000)tags.lyrics_timed=/\[\d{1,2}:\d{2}(?:\.\d+)?\]/.test(lyric);continue;}
    if(id==='TDRC'||id==='TYER'||id==='TYE')date=values(bytes)[0]||date;
    if(id==='TDOR'||id==='TORY')originalDate=values(bytes)[0]||originalDate;
    if(id==='TCON')tags.genre=values(bytes).join(';');
    if(id==='TPE1')tags.artist=values(bytes).join(';');
    if(id==='TIT2')tags.title=values(bytes).join('');
    if(id==='TALB')tags.album=values(bytes).join('');
    if(id==='TRCK')tags.track=values(bytes)[0]||'';
  }
  originalDate=originalDate||user.originaldate||user.originalyear||'';
  tags.release_date=yyyy(date)?date:'';
  tags.original_date=yyyy(originalDate)?originalDate:'';
  tags.release_year=yyyy(originalDate)||yyyy(date)||0;
  tags.artist_names=String(user.artists||'').split(/[\0;]/).map(s=>s.trim()).filter(Boolean).slice(0,30);
  tags.musicbrainz_artist_ids=String(user['musicbrainz artist id']||'').split(/[\0;]/).map(s=>s.trim()).filter(s=>/^[a-f0-9-]{36}$/i.test(s)).slice(0,30);
  const origins=String(user.artistcountry||user['artist country']||'').split(/[\0;]/).map(countryISO).filter(Boolean);
  const begin=String(user.artistbeginarea||user['artist begin area']||'').split(/[\0;]/).map(s=>s.trim()).filter(Boolean);
  tags.artist_origins=tags.artist_names.map((artist,i)=>({artist,mbid:tags.musicbrainz_artist_ids[i]||'',country_code:origins[i]||(origins.length===1&&tags.artist_names.length===1?origins[0]:''),begin_area:begin[i]||''}));
  if(!tags.artist_origins.length&&origins.length===1&&tags.artist){tags.artist_origins=[{artist:tags.artist,mbid:tags.musicbrainz_artist_ids[0]||'',country_code:origins[0],begin_area:begin[0]||''}];}
  // Picard's MusicBrainz Album Release Country is NOT an artist-country tag.
  if(!tags.genre)delete tags.genre;
  if(!frameList.some(f=>['TXXX','TDOR','TORY','POPM','USLT'].includes(f.id))){delete tags.release_date;delete tags.original_date;delete tags.artist_names;delete tags.musicbrainz_artist_ids;delete tags.artist_origins;}
  return tags;
}
