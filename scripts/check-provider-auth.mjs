/** Read-only account/model checks. Never log response bodies, URLs or keys. */
async function readJson(url, headers={}) {
 const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
 const reader=response.body?.getReader();let size=0;const chunks=[];
 if(!reader) return {status:response.status,json:null};
 try {
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return {status:response.status,json:null};}chunks.push(value);}
  return {status:response.status,json:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
 } finally {reader.releaseLock();}
}
const report={checkedAt:new Date().toISOString(),searchUploadInferenceAttempted:false};
for(const provider of ['serpapi','typesafe']){
 try {
  const key=process.env[provider==='serpapi'?'SERPAPI_API_KEY':'TYPESAFE_API_KEY'];
  if(!key){report[provider]={auth:'unverifiable',reason:'not configured'};continue;}
  const endpoint=new URL(provider==='serpapi'?'https://serpapi.com/account.json':'https://api.typesafe.ai/v1/models');
  const headers={};
  if(provider==='serpapi')endpoint.searchParams.set('api_key',key);else headers.Authorization='Bearer '+key;
  const {status,json}=await readJson(endpoint,headers);
  if(status!==200||!json||typeof json!=='object'||json.error){report[provider]={auth:'unverifiable',httpStatus:status};continue;}
  if(provider==='serpapi'){
   report[provider]={auth:'verified',httpStatus:status};
   for(const name of ['account_status','plan_name','plan_monthly_price','plan_renewal_date','searches_per_month','plan_searches_left','extra_credits','total_searches_left','this_month_usage']){
    if(typeof json[name]==='number'||typeof json[name]==='string')report[provider][name]=json[name];
   }
  }else{
   report[provider]={auth:'verified',httpStatus:status,modelListReturned:Array.isArray(json.models)||Array.isArray(json.data)||Array.isArray(json)};
  }
 }catch{report[provider]={auth:'unverifiable',reason:'read-only request failed; details withheld'};}
}
console.log(JSON.stringify(report,null,2));
