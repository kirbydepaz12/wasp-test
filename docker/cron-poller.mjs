// Private Docker scheduler for the same admin-configured WASP jobs as Cloudflare.
// Only the local Wrangler Worker accepts this call (scanner secret protected).
const secret=process.env.SCANNER_SECRET||"";
const work=async()=>{
  try{const response=await fetch("http://127.0.0.1:8787/api/internal/cron-tick",{
    method:"POST",headers:{"x-scanner-secret":secret},signal:AbortSignal.timeout(25000)});
    if(response.ok && (await response.json()).runs?.some(run=>run.kind==="hash" && !run.error))
      await fetch("http://127.0.0.1:8788/_internal/hash-scan",{method:"POST",headers:{"x-scanner-secret":secret},signal:AbortSignal.timeout(5000)});
  }catch{/* Wrangler may still be starting; next minute retries. */}
};
setInterval(work,60000);
setTimeout(work,12000);

// Sequential background metadata batches; closing the browser does not stop scanning.
async function metadataLoop(){
  try{await fetch('http://127.0.0.1:8787/api/internal/metadata-tick',{method:'POST',headers:{'x-scanner-secret':secret},signal:AbortSignal.timeout(115000)});}catch{}
  setTimeout(metadataLoop,3000);
}
setTimeout(metadataLoop,15000);
