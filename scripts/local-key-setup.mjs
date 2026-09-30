import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const workspace=resolve(fileURLToPath(new URL('../',import.meta.url)));
export const target=resolve(workspace,'.env.local');
function headers(type){return {'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'permissions-policy':'camera=(), microphone=(), geolocation=()'};}
function reply(res,status,body,type='text/plain; charset=utf-8'){res.writeHead(status,headers(type));res.end(body);}
export function createSetupServer(destination=target,{onBoundaryReject=()=>{}}={}){
 const nonce=randomBytes(32).toString("hex");
 return createServer(async(req,res)=>{
  const address=req.socket.localPort;const origin='http://127.0.0.1:'+address;
  if(req.headers.host!==`127.0.0.1:${address}`||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){reply(res,403,'Local loopback only.');return;}
  const present=()=>existsSync(destination);
  if(req.url==='/status'&&req.method==='GET'){reply(res,200,JSON.stringify({configured:present(),liveEnabled:false,approvedSearches:0}), 'application/json');return;}
  if(req.url==='/'&&req.method==='GET'){
   const status=present()?'<p>Private configuration already exists. Its contents were not read. Live investigations remain disabled.</p>':`<form method="post" action="/configure" autocomplete="off"><input type="hidden" name="csrf" value="${nonce}"><label>SerpApi existing server API key<input required name="SERPAPI_API_KEY" type="password" autocomplete="new-password"></label><label>TypeSafe existing server API key<input required name="TYPESAFE_API_KEY" type="password" autocomplete="new-password"></label><button>Save locally with live use disabled</button></form>`;
   reply(res,200,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private ContextTrail key setup</title><style>body{font:16px system-ui;max-width:620px;margin:48px auto;padding:20px;color:#18202a}label{display:block;margin:20px 0}input{display:block;padding:12px;width:100%;box-sizing:border-box;margin-top:8px}button{padding:12px}p{line-height:1.5}</style><h1>Private server setup</h1><p>Enter keys directly here. They are saved only to an ignored local server environment file, never sent to a provider, displayed, or logged. The assistant will not read submitted values.</p><p>Live investigations stay off. Approved budget stays zero until free allowances, billing controls and the durable usage ledger are verified.</p>${status}</html>`,'text/html; charset=utf-8');return;
  }
  if(req.url==='/configure'&&req.method==='POST'){
   if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')){onBoundaryReject({originState:req.headers.origin===undefined?'missing':req.headers.origin==='null'?'null':req.headers.origin===origin?'same':'different',formContentType:Boolean(req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))});reply(res,403,'Same-origin form required.');return;}
   if(present()){reply(res,409,'Existing configuration preserved; no values were inspected.');return;}
   let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>16384){reply(res,413,'Form too large.');return;}parts.push(part);}
   const fields=new URLSearchParams(Buffer.concat(parts).toString('utf8'));
   const key=fields.get('SERPAPI_API_KEY'),secret=fields.get('TYPESAFE_API_KEY');
   if(fields.get("csrf")!==nonce){reply(res,403,"Invalid form nonce.");return;}
   if([...fields.keys()].length!==3||[...new Set(fields.keys())].length!==3||[...fields.keys()].some(name=>!['csrf','SERPAPI_API_KEY','TYPESAFE_API_KEY'].includes(name))||!/^[A-Za-z0-9_-]{10,}$/.test(key??'')||!/^[A-Za-z0-9_.-]{10,}$/.test(secret??'')){reply(res,400,'Check the field formats. No values were saved or logged.');return;}
   try{
    mkdirSync(resolve(destination,'..'),{recursive:true,mode:0o700});
    writeFileSync(destination,`SERPAPI_API_KEY=${key}\nTYPESAFE_API_KEY=${secret}\nCONTEXTTRAIL_LIVE_ENABLED=false\nCONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED=false\n`,{mode:0o600,flag:'wx'});
    reply(res,200,'<!doctype html><html lang="en"><meta charset="utf-8"><title>Setup saved</title><h1>Saved locally</h1><p>Credentials are not displayed. Live investigations remain disabled and approved budget zero. Next: verify free credits and durable usage ledger.</p></html>','text/html; charset=utf-8');
   }catch{reply(res,409,'Could not save safely. Existing data is preserved; no values logged.');}
   return;
  }
  reply(res,404,'Not found.');
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const server=createSetupServer();server.listen(Number(process.env.CONTEXTTRAIL_SETUP_PORT??0),'127.0.0.1',()=>console.log('Private setup ready at http://127.0.0.1:'+server.address().port+'; live off, budget zero.'));}
