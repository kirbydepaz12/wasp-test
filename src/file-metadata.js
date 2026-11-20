import {requireNoRedirect} from './peer-fetch.js';
// Read bounded MP3 ID3 tags only. No music writes or external network calls.
const sync=(b,p)=>((b[p]&127)<<21)|((b[p+1]&127)<<14)|((b[p+2]&127)<<7)|(b[p+3]&127);
const big=(b,p)=>b[p]*0x1000000+(b[p+1]<<16)+(b[p+2]<<8)+b[p+3];
const ascii=b=>String.fromCharCode(...b);
const MAX=6*1024*1024;
const id3Genres='Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New Age|Oldies|Other|Pop|R&B|Rap|Reggae|Rock|Techno|Industrial|Alternative|Ska|Death Metal|Pranks|Soundtrack|Euro-Techno|Ambient|Trip-Hop|Vocal|Jazz+Funk|Fusion|Trance|Classical|Instrumental|Acid|House|Game|Sound Clip|Gospel|Noise|Alternative Rock|Bass|Soul|Punk|Space|Meditative|Instrumental Pop|Instrumental Rock|Ethnic|Gothic|Darkwave|Techno-Industrial|Electronic|Pop-Folk|Eurodance|Dream|Southern Rock|Comedy|Cult|Gangsta|Top 40|Christian Rap|Pop/Funk|Jungle|Native American|Cabaret|New Wave|Psychedelic|Rave|Showtunes|Trailer|Lo-Fi|Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|Rock & Roll|Hard Rock'.split('|');
export function normalizeEmbeddedGenre(value){const s=String(value||'').trim();const match=s.match(/^\(?(\d+)\)?$/);return match?(id3Genres[Number(match[1])]||''):s.slice(0,80);}

function decode(b){if(!b.length)return '';const enc=b[0],data=b.subarray(1);if(enc>3)return '';return new TextDecoder(enc===0?'windows-1252':enc===3?'utf-8':enc===2?'utf-16be':data[0]===254&&data[1]===255?'utf-16be':'utf-16le').decode(data).replace(/\uFEFF/g,'').replace(/\0.*$/s,'').trim();}
export function parseFileTags(b){const result={};if(b.length<10||ascii(b.subarray(0,3))!=='ID3'||![2,3,4].includes(b[3]))return result;const v=b[3],limit=Math.min(b.length,10+sync(b,6)),h=v===2?6:10;let p=10;if(b[5]&128)return result; // don't guess on unsynchronised tags
 if(v===2&&(b[5]&64))return result;if(v>=3&&(b[5]&64)){if(p+4>limit)return result;p+=v===4?sync(b,p):big(b,p)+4;}
 const names={TYER:'release_year',TDRC:'release_year',TYE:'release_year',TCON:'genre',TCO:'genre'};
 while(p+h<=limit){const id=ascii(b.subarray(p,p+(v===2?3:4))),len=v===2?(b[p+3]<<16)|(b[p+4]<<8)|b[p+5]:v===4?sync(b,p+4):big(b,p+4);if(!/^[A-Z0-9]{3,4}$/.test(id)||!len||p+h+len>limit)break;if(names[id]&&len<65536&&(v===2||!(b[p+9]&(v===3?0xe0:0x4f)))){const value=decode(b.subarray(p+h,p+h+len));if(names[id]==='release_year'){const y=Number(value.match(/^\d{4}(?:$|[-/])/ )?.[0]?.slice(0,4));if(y>=1850&&y<=new Date().getUTCFullYear()+1)result.release_year=y;}else if(normalizeEmbeddedGenre(value))result.genre=normalizeEmbeddedGenre(value);}p+=h+len;}
 return result;
}
async function read(bucket,id,range){const obj=await bucket.get(id,{range});if(!obj)return null;return new Uint8Array(await obj.arrayBuffer());}
export async function readUploadedTags(bucket,id,size){if(!bucket||!size)return {};const h=await read(bucket,id,{offset:0,length:Math.min(10,size)});if(!h)return null;let tags={};if(h.length>=10&&ascii(h.subarray(0,3))==='ID3'){const len=10+sync(h,6);if(len<=MAX&&len<=size){const b=await read(bucket,id,{offset:0,length:len});if(!b||b.length!==len)return null;tags=parseFileTags(b);}}
 if((!tags.release_year||!tags.genre)&&size>=128){const b=await read(bucket,id,{offset:size-128,length:128});if(!b||b.length!==128)return null;if(ascii(b.subarray(0,3))==='TAG'){const year=Number(ascii(b.subarray(93,97)));if(!tags.release_year&&year>=1850&&year<=new Date().getUTCFullYear()+1)tags.release_year=year;if(!tags.genre&&id3Genres[b[127]])tags.genre=id3Genres[b[127]];}}return tags;}

// Optional Docker-only direct peer inspection. Demand 206 and bounded ranges;
// never download a whole song if a peer ignores Range or redirects.
export async function readPeerFileTags(fetcher,url){let size=0;
 async function exact(offset,length){const r=requireNoRedirect(await fetcher(url,{redirect:'manual',headers:{Range:`bytes=${offset}-${offset+length-1}`},signal:AbortSignal.timeout(7000)}));const m=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range')||'');
 if(r.status!==206||!m||Number(m[1])!==offset||Number(m[2])!==offset+length-1||!Number.isSafeInteger(+m[3])||+m[3]<offset+length||(size&&size!==+m[3])){await r.body?.cancel().catch(()=>{});throw Error('Peer did not return a valid byte range');}
 size=+m[3];if(!r.body)throw Error('Empty peer tag response');const reader=r.body.getReader(),out=new Uint8Array(length);let n=0;try{for(;;){const {value,done}=await reader.read();if(done)break;if(n+value.length>length)throw Error('Peer exceeded requested tag range');out.set(value,n);n+=value.length;}}finally{await reader.cancel().catch(()=>{});}if(n!==length)throw Error('Truncated peer tag range');return out;}
 const h=await exact(0,10);let tags={};if(ascii(h.subarray(0,3))==='ID3'){const length=10+sync(h,6);if(length>10&&length<=MAX&&length<=size)tags=parseFileTags(await exact(0,length));}
 if((!tags.release_year||!tags.genre)&&size>=128){const b=await exact(size-128,128);if(ascii(b.subarray(0,3))==='TAG'){const y=Number(ascii(b.subarray(93,97)));if(!tags.release_year&&y>=1850&&y<=new Date().getUTCFullYear()+1)tags.release_year=y;if(!tags.genre&&id3Genres[b[127]])tags.genre=id3Genres[b[127]];}}return tags;
}
