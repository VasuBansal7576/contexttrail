import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, statSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createSetupServer} from './local-key-setup.mjs';

describe('local existing-key handoff (synthetic values, no provider)',()=>{
 let dir, destination, server, origin, nonce;
 beforeAll(async()=>{
  dir=mkdtempSync(join(tmpdir(),'contexttrail-setup-test-'));
  destination=join(dir,'synthetic.env');
  server=createSetupServer(destination);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin='http://127.0.0.1:'+server.address().port;
  const html=await (await fetch(origin)).text();
  nonce=/name="csrf" value="([a-f0-9]+)"/.exec(html)[1];
 });
 afterAll(async()=>{
  await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 });
 const fields=()=>new URLSearchParams({csrf:nonce,SERPAPI_API_KEY:'synthetic_serpapi_only',TYPESAFE_API_KEY:'synthetic_typesafe_only'});
 const post=(body,headers={})=>fetch(origin+'/configure',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded',...headers},body});
 it('sets same-origin referrer policy for Chrome navigation posts',async()=>{
  const r=await fetch(origin); expect(r.headers.get('referrer-policy')).toBe('same-origin');
  expect(r.headers.get('cache-control')).toBe('no-store');
 });
 it('rejects foreign, null and missing origin',async()=>{
  for(const value of ['https://example.invalid','null','']) expect((await post(fields(),{origin:value})).status).toBe(403);
 });
 it('rejects alternate host',async()=>{
  const status=await new Promise((resolve,reject)=>{
   const req=request(origin+'/configure',{method:'POST',headers:{host:'localhost:'+server.address().port,origin,'content-type':'application/x-www-form-urlencoded'}},res=>{res.resume();resolve(res.statusCode);});
   req.on('error',reject);req.end(fields().toString());
  });
  expect(status).toBe(403);
 });
 it('rejects incorrect nonce',async()=>{
  const body=fields();body.set('csrf','bad');expect((await post(body)).status).toBe(403);
 });
 it('rejects duplicate fields and line injection',async()=>{
  const duplicate=fields();duplicate.append('SERPAPI_API_KEY','synthetic_duplicate');expect((await post(duplicate)).status).toBe(400);
  const newline=fields();newline.set('TYPESAFE_API_KEY','synthetic\nLIVE=true');expect((await post(newline)).status).toBe(400);
 });
 it('bounds body before form parsing',async()=>{
  expect((await post('x'.repeat(16385))).status).toBe(413);
 });
 it('writes exclusively with private permissions and live use disabled',async()=>{
  const r=await post(fields());expect(r.status).toBe(200);
  const visible=await r.text();expect(visible).not.toContain('synthetic_serpapi_only');expect(visible).not.toContain('synthetic_typesafe_only');
  expect(statSync(destination).mode&0o777).toBe(0o600);
  const synthetic=readFileSync(destination,'utf8');
  expect(synthetic).toContain('CONTEXTTRAIL_LIVE_ENABLED=false');
  expect(synthetic).toContain('CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED=false');
 });
 it('preserves existing values and returns only nonsecret status',async()=>{
  const before=readFileSync(destination,'utf8');expect((await post(fields())).status).toBe(409);
  expect(readFileSync(destination,'utf8')).toBe(before);
  expect(await (await fetch(origin+'/status')).json()).toEqual({configured:true,liveEnabled:false,approvedSearches:0});
 });
});
