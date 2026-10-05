import { ownerId } from '../hosted/context';
import { automaticConfiguration } from './automatic-server';
import { inspectLiveAllowance,readLiveUsageConfig,topicRunAllocation } from '../investigation/live-usage';
export interface AutomaticReadiness {ready:boolean;message:string}
export async function automaticReadiness(kind:'topic'|'audio'|'video',_hasCaption=false):Promise<AutomaticReadiness>{
  if(kind!=='topic')return {ready:false,message:'This public trial supports questions and images. Native video decoding and speech recognition run in the downloadable local application.'};
  try{ownerId()}catch{return {ready:false,message:'Sign in with ChatGPT using the link above to start a real investigation and keep your private cases.'}};
  try{automaticConfiguration();const status=await inspectLiveAllowance(readLiveUsageConfig(process.env),topicRunAllocation());return {ready:status==='ready',message:status==='ready'?'Live search is ready. Your cases are private to your ChatGPT account.':status==='busy'?'Another investigation is running. Wait, then reload.':'The public trial allowance is exhausted. Saved cases remain available.'}}
  catch{return {ready:false,message:'Live research is unavailable. Saved cases remain available.'}}
}
