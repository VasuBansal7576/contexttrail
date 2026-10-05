import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const config = dirname(fileURLToPath(import.meta.url));
const root = resolve(config,'../..');
const destination = resolve(process.argv[2] ?? '../contexttrail-public');
if (destination===root || destination.startsWith(root+'/')) throw new Error('Use a separate public Sites checkout.');
mkdirSync(destination,{recursive:true});
for (const path of ['src','public']) {
  rmSync(join(destination,path),{recursive:true,force:true});
  cpSync(join(root,path),join(destination,path),{recursive:true,filter:path=>!(/\.test\.[jt]sx?$|\/__tests__(\/|$)/.test(path))});
}
for (const entry of readdirSync(config)) {
  if (['overrides','tests','prepare.mjs','README.md'].includes(entry)) continue;
  const source=join(config,entry),target=join(destination,entry);
  cpSync(source,target,{recursive:true});
}
cpSync(join(config,'overrides'),join(destination,'src'),{recursive:true});
cpSync(join(root,'postcss.config.mjs'),join(destination,'postcss.config.mjs'));
// Native host-only modules are excluded from the Worker dependency graph.
const disabled = `export const VIDEO_LIMITS = {bytes:32*1024*1024,durationMs:120000,pixels:3840*2160,frames:3,frameBytes:500*1024,processMs:15000};
export class VideoIngestError extends Error {constructor(readonly code:string){super(code)}}
export type VideoFrame = {id:string;mediaId:string;timestampMs:number;contentHash:string;mimeType:'image/jpeg';bytes:Uint8Array};
export function sampleTimes(durationMs:number):number[]{return [0,durationMs/3,durationMs*2/3]};
export interface PreparedVideo {mediaId:string;contentHash:string;durationMs:number;frames:Array<{id:string;mediaId:string;timestampMs:number;contentHash:string;mimeType:'image/jpeg';bytes:Uint8Array}>;coverage:'sampled_frames_only';visualScan?:import('./visual-scan').VisualScan}
export async function prepareVideo(_bytes:Uint8Array,_options?:unknown):Promise<PreparedVideo>{throw new VideoIngestError('decoder_unavailable')}
`;
writeFileSync(join(destination,'src/lib/video/ingest.ts'),disabled);
writeFileSync(join(destination,'src/lib/video/transcribe.ts'),`import type {MediaTranscript} from './transcript';export async function transcribeMedia(_bytes:Uint8Array,_signal?:AbortSignal):Promise<MediaTranscript>{throw new Error('Native speech recognition requires the local application.');}`);
writeFileSync(join(destination,'src/app/api/media/compare/route.ts'),`export async function POST(){return Response.json({error:'Native media comparison is available in the local application.',code:'NATIVE_MEDIA_UNAVAILABLE'},{status:503})}`);
writeFileSync(join(destination,'src/instrumentation.ts'),'export async function register() {}\n');
// Preserve the folio geometry within the space below the account strip.
const shell=join(destination,'src/components/casebook/CasebookShell.tsx');
writeFileSync(shell,readFileSync(shell,'utf8').replace('window.innerHeight / 900','(window.innerHeight - 30) / 900'));
for(const relative of ['src/components/casebook/AutomaticResearch.tsx','src/components/casebook/SaveToCasebook.tsx']){
 const path=join(destination,relative);let text=readFileSync(path,'utf8');text=text.replaceAll('saved locally','saved privately to your account').replaceAll('evidence locally','evidence privately to your account').replaceAll('local casebook','private casebook');writeFileSync(path,text);
}
const watch=join(destination,'src/components/casebook/Watchlists.tsx');writeFileSync(watch,readFileSync(watch,'utf8').replace('Scheduling runs while this local server is running. No background checks happen after it shuts down.','Public watches retain manual checks. Scheduled background checks require the local application.'));
const automatic=join(destination,'src/lib/research/automatic.ts');writeFileSync(automatic,readFileSync(automatic,'utf8').replace('PDF reading is text-only, limited to the first twelve pages and 64,000 extracted characters. Scanned pages, audio, figures and later pages are not inspected.','This public trial inspects HTML source pages only. PDF, video and audio source contents remain uninspected.'));
const api=join(destination,'src/app/api/investigate/route.ts');let route=readFileSync(api,'utf8');route="import { requireLocalResearchRequest } from '@/lib/research/local-boundary';\n"+route;route=route.replace('export async function POST(req: Request): Promise<Response> {',`export async function POST(req: Request): Promise<Response> {\n  try {requireLocalResearchRequest(req)} catch {return Response.json({error:'Sign in with ChatGPT to investigate; cross-origin requests are rejected.'},{status:401})}`);writeFileSync(api,route);

// Starter root app would take precedence over the copied src/app.
if(existsSync(join(destination,'app')))rmSync(join(destination,'app'),{recursive:true,force:true});
const vite=join(destination,'vite.config.ts');
let text=readFileSync(vite,'utf8');
text=text.replace('return {\n    server:',`return {\n    resolve:{alias:{jsdom:new URL('./src/lib/hosted/html.ts',import.meta.url).pathname}},\n    server:`);
writeFileSync(vite,text);
writeFileSync(join(destination,'src/app/globals.css'),readFileSync(join(destination,'src/app/globals.css'),'utf8')+`\n.public-trial-account{display:flex;gap:1rem;align-items:center;justify-content:space-between;padding:.45rem 4%;background:#242c2c;color:#eee5ce;font:12px var(--font-geist-sans),sans-serif;position:relative;z-index:100}.public-trial-account a{color:#eac75e;text-decoration:underline}.public-trial-account{height:30px;box-sizing:border-box;position:fixed;inset:0 0 auto}.desktop-folio{top:30px}\n`);
console.log(JSON.stringify({prepared:destination,uiSource:join(root,'src'),runtimeDataCopied:false}));
