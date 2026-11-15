/**
 * Best-effort, anonymous presence for third-party Subsonic/OpenSubsonic apps.
 * Browser WASP uses /api/active-streams heartbeats and can stop immediately;
 * mobile clients do not share an equivalent, universal pause/stop protocol.
 * Therefore successful streams and explicit playback-start scrobbles create a
 * bounded expiry. No client identity or playback credential is returned by the
 * public active-streams API. This does not count as a confirmed scrobble.
 */
const encode=new TextEncoder();
const MAX_MOBILE_PRESENCE_MS=6*60*1000;
const MIN_MOBILE_PRESENCE_MS=65*1000;
const DEFAULT_MOBILE_PRESENCE_MS=2*60*1000;

async function sessionId(credentialId){
  const buf=await crypto.subtle.digest('SHA-256',encode.encode('wasp-mobile-anonymous-presence-v1:'+credentialId));
  const hex=Array.from(new Uint8Array(buf)).slice(0,16).map(v=>v.toString(16).padStart(2,'0')).join('');
  // An opaque UUID-shaped session ID used only inside the existing live table.
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function presenceDuration(track){
  const seconds=Number(track?.duration);
  if(!Number.isFinite(seconds)||seconds<=0)return DEFAULT_MOBILE_PRESENCE_MS;
  return Math.min(MAX_MOBILE_PRESENCE_MS,Math.max(MIN_MOBILE_PRESENCE_MS,Math.round(seconds*1000)+15000));
}
export async function recordMobilePlayback(db,credential,track){
  if(!credential?.id||!track?.sourceId)return false;
  const now=Date.now(),id=await sessionId(credential.id);
  const origin=String(track.origin||'');
  const trackId=String(track.sourceId);
  // No activity records for IDs outside the normal WASP track namespace.
  if(!/^[\w-]{1,120}$/.test(trackId))return false;
  const expiry=now+presenceDuration(track);
  // Avoid several D1 writes for initial audio Range requests from one client.
  const prior=await db.prepare('SELECT origin,track_id,expires_at FROM active_streams WHERE session_id=?').bind(id).first();
  if(prior?.origin===origin&&prior?.track_id===trackId&&Number(prior.expires_at)>expiry-20000)return true;
  await db.prepare(`INSERT INTO active_streams(session_id,origin,track_id,expires_at,started_at)
    VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
    started_at=CASE WHEN active_streams.origin=excluded.origin AND active_streams.track_id=excluded.track_id
      THEN active_streams.started_at ELSE excluded.started_at END,
    origin=excluded.origin,track_id=excluded.track_id,expires_at=excluded.expires_at`)
    .bind(id,origin,trackId,expiry,now).run();
  return true;
}
