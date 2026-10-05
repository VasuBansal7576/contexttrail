import { automaticConfiguration } from './automatic-server';
import { inspectLiveAllowance, readLiveUsageConfig, topicRunAllocation, videoRunAllocation } from '../investigation/live-usage';
export interface AutomaticReadiness { ready: boolean; message: string }
/** No keys, paths or provider-account balances reach the browser. */
export async function automaticReadiness(kind: 'topic' | 'audio' | 'video', hasCaption = false): Promise<AutomaticReadiness> {
  try {
    automaticConfiguration();
    // Read-only status follows the same ceiling the submission will reserve.
    const status = await inspectLiveAllowance(readLiveUsageConfig(process.env), kind === 'video' ? videoRunAllocation(hasCaption ? 'caption' : null) : topicRunAllocation());
    if (status === 'busy') return {ready:false,message:'Another investigation is using the live service. Wait for it to finish, then reload.'};
    if (status === 'exhausted') return {ready:false,message:'The live investigation allowance is exhausted. The operator must authorize more allowance before a new search can run. Saved investigations remain readable.'};
    return {ready:true,message:'Live search is configured. Submitting starts a new investigation with your input.'};
  } catch { return {ready:false,message:'Live research is unavailable in this instance. The operator must check provider configuration and usage storage. Saved investigations remain readable.'}; }
}
