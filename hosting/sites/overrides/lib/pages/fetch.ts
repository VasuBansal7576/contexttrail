import { isIP } from 'node:net';
import { deadlineSignal, ProviderError, readBodyCapped } from '../providers/http';
export interface FetchedPage { url:string; html:string }
export function isPublicPageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b)) || (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0));
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^(2001:|2002:|3fff:)/i.test(address);
}
export function validatedHttpUrl(raw: string): URL | null {
  let url; try { url = new URL(raw); } catch { return null; }
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/,'');
  if (isIP(host.replace(/^\[|\]$/g,''))) {
    if (!isPublicPageAddress(host.replace(/^\[|\]$/g,''))) return null;
  } else if (!host.includes('.') || host.length > 253 || host.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || ['localhost','local','internal','home.arpa'].some(name=>host===name||host.endsWith(`.${name}`))) return null;
  url.hostname = host; url.hash = ''; return url;
}
/** Workers' outbound fetch has no access to this app's R2, D1 or native host network. */
async function resource(raw: string, signal?: AbortSignal, image = false): Promise<FetchedPage> {
  let url = validatedHttpUrl(raw);
  if (!url || (image && (url.protocol !== 'https:' || url.search))) throw new ProviderError('malformed','Source destination rejected');
  const bound = deadlineSignal(signal,5_000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(url,{redirect:'manual',signal:bound.signal,headers:{accept:image?'image/jpeg,image/png,image/webp':'text/html','user-agent':'ContextTrail/0.1 source research','accept-encoding':'identity'}});
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || redirects===3) throw new ProviderError('http','Source redirect limit');
        url = validatedHttpUrl(new URL(location,url).href);
        if (!url || (image && (url.protocol !== 'https:' || url.search))) throw new ProviderError('malformed','Source redirect rejected');
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError('http','Source page unavailable',response.status); }
      const type = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (image ? !/^image\/(jpeg|png|webp)(;|$)/.test(type) : !type.includes('text/html')) { await response.body?.cancel(); throw new ProviderError('malformed','This public instance reads HTML sources only; other source formats remain uninspected.'); }
      // A decompressed streaming cap applies regardless of Content-Length.
      if (image) {
        const reader = response.body?.getReader(); if (!reader) throw new ProviderError('malformed','Image body unavailable');
        let size=0; try { for (;;) { const next=await reader.read(); if(next.done)break;size+=next.value.byteLength;if(size>2*1024*1024)throw new ProviderError('malformed','Image exceeds its byte limit'); } } finally { await reader.cancel(); }
        return {url:url.href,html:''};
      }
      return {url:url.href,html:await readBodyCapped(response,2*1024*1024,'source')};
    }
    throw new ProviderError('http','Source redirect limit');
  } catch(error) { if(error instanceof ProviderError)throw error;throw new ProviderError('network','Source page could not be safely read'); }
  finally {bound.cancel();}
}
export const fetchPageHtml = (url:string,signal?:AbortSignal)=>resource(url,signal);
export const fetchPageDocument = fetchPageHtml;
export async function validatePublicImageUrl(url:string,signal?:AbortSignal):Promise<string>{return (await resource(url,signal,true)).url;}
