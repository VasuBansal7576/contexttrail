#!/usr/bin/env node
// Explicit offline operator action. No keys, providers, refunds, or resets.
import {constants} from 'node:fs';
import {open,realpath,unlink} from 'node:fs/promises';
import {dirname,basename,join,isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const keys=['searches','uploads','jevRequests','jevQuestions'];
const publicClaim={searches:6,uploads:0,jevRequests:60,jevQuestions:272};
const publicTrace={searches:4,uploads:0,jevRequests:60,jevQuestions:113};
const topic={searches:3,uploads:0,jevRequests:8,jevQuestions:40};
const legacyTopic={...topic,jevQuestions:8};
const grants=[publicClaim,publicTrace,{...publicTrace,uploads:1},{...publicClaim,uploads:1},topic];
const videoTrace={searches:12,uploads:3,jevRequests:180,jevQuestions:339};
const videoClaim={searches:18,uploads:3,jevRequests:180,jevQuestions:816};
const historyGrants=[...grants,legacyTopic];
const historyAllocations=[...historyGrants,videoTrace,videoClaim];
const same=(a,b)=>keys.every(k=>a[k]===b[k]);
const valid=a=>a&&typeof a==='object'&&Object.keys(a).length===4&&keys.every(k=>Number.isSafeInteger(a[k])&&a[k]>=0);
const allocation=a=>valid(a)&&historyAllocations.some(b=>same(a,b));
const cap=n=>{const v=process.env[n];if(!/^(0|[1-9]\d*)$/.test(v??'')||!Number.isSafeInteger(Number(v)))throw Error();return Number(v);};
async function grant(){
 if(process.env.CONTEXTTRAIL_LIVE_ENABLED!=='false'||process.env.CONTEXTTRAIL_LIVE_DEPLOYMENT!=='single-host-persistent'||process.env.CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED!=='true'||['VERCEL','VERCEL_ENV','NETLIFY','AWS_LAMBDA_FUNCTION_NAME','AWS_EXECUTION_ENV','FUNCTIONS_WORKER_RUNTIME','K_SERVICE','CLOUD_RUN_JOB'].some(k=>process.env[k]!==undefined))throw Error();
 const path=process.env.CONTEXTTRAIL_USAGE_LEDGER_PATH, period=process.env.CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD;
 if(!path||!isAbsolute(path)||resolve(path)!==path||!period)throw Error();
 const parent=await realpath(dirname(path));
 if(join(parent,basename(path))!==path||['/tmp','/var/tmp','/dev','/proc','/sys','/run'].some(r=>parent===r||parent.startsWith(r+'/')))throw Error();
 const allowance={searches:cap('CONTEXTTRAIL_FREE_SERPAPI_SEARCHES'),uploads:cap('CONTEXTTRAIL_FREE_SERPAPI_UPLOADS'),jevRequests:cap('CONTEXTTRAIL_FREE_JEV_REQUESTS'),jevQuestions:cap('CONTEXTTRAIL_FREE_JEV_QUESTIONS')};
 const addition=JSON.parse(process.env.CONTEXTTRAIL_ALLOWANCE_GRANT??'null'), reason=process.env.CONTEXTTRAIL_ALLOWANCE_GRANT_REASON;
 if(!valid(addition)||!grants.some(a=>same(a,addition))||!reason||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(reason))throw Error();
 const lockPath=path+'.lock';const lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 const token=randomUUID();let ledger,appendStarted=false;
 try {
  await lock.writeFile(token);await lock.sync();const dir=await open(parent,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
  ledger=await open(path,constants.O_RDWR|constants.O_APPEND|constants.O_NOFOLLOW);const info=await ledger.stat();
  if(!info.isFile()||info.nlink!==1||info.size<=0||info.size>1048576)throw Error();
  const raw=await ledger.readFile('utf8');if(!raw.endsWith('\n'))throw Error();
  const rows=raw.trimEnd().split('\n').map(line=>JSON.parse(line));const h=rows[0];
  if(Object.keys(h).length!==5||h.type!=='contexttrail-live-usage'||h.version!==1||h.model!=='jev-1.13.0'||h.period!==period||!valid(h.allowance))throw Error();
  const effective={...h.allowance},spent={searches:0,uploads:0,jevRequests:0,jevQuestions:0},ids=new Set();
  for(const row of rows.slice(1)){
   if(!row||!['grant','reserve'].includes(row.type)||typeof row.id!=='string'||!/^[0-9a-f-]{36}$/.test(row.id)||ids.has(row.id)||!allocation(row.allocation))throw Error();ids.add(row.id);
   if(row.type==='grant'){
    if(Object.keys(row).length!==4||typeof row.reason!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.reason)||!historyGrants.some(a=>same(a,row.allocation)))throw Error();
    for(const k of keys)effective[k]+=row.allocation[k];
   }else{if(Object.keys(row).length!==3)throw Error();for(const k of keys)spent[k]+=row.allocation[k];}
   if(keys.some(k=>!Number.isSafeInteger(effective[k])||!Number.isSafeInteger(spent[k])||spent[k]>effective[k]))throw Error();
  }
  if(keys.some(k=>effective[k]+addition[k]!==allowance[k]||!Number.isSafeInteger(allowance[k])))throw Error();
  const entry=JSON.stringify({type:'grant',id:randomUUID(),allocation:addition,reason})+'\n';if(info.size+Buffer.byteLength(entry)>1048576)throw Error();
  appendStarted=true;await ledger.writeFile(entry);await ledger.sync();await ledger.close();ledger=undefined;await unlink(lockPath);
  console.log(JSON.stringify({appended:true,previous:effective,additional:addition,effective:allowance,spentPreserved:spent,reason,liveEnabled:false}));
 }catch(error){await ledger?.close().catch(()=>{});if(!appendStarted)await unlink(lockPath).catch(()=>{});throw error;}finally{await lock.close();}
}
grant().catch(()=>{console.error('Allowance grant refused or uncertain. Existing reservations were not reset; any uncertain lock remains.');process.exitCode=1;});
