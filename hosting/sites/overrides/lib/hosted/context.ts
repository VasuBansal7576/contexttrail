import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';

export const requestContext = new AsyncLocalStorage<Request>();
export function currentRequest(): Request {
  const request = requestContext.getStore();
  if (!request) throw new Error('Request context unavailable');
  return request;
}
export function ownerId(): string {
  const owner = currentRequest().headers.get('oai-authenticated-user-id');
  const email = currentRequest().headers.get('oai-authenticated-user-email');
  if (!owner || !email || owner.length > 256) throw new Error('Sign in with ChatGPT to investigate and keep your cases.');
  return owner;
}
export function database(): D1Database {
  if (!env.DB) throw new Error('Persistent research storage unavailable');
  return env.DB;
}
export function files(): R2Bucket {
  if (!env.FILES) throw new Error('Persistent evidence storage unavailable');
  return env.FILES;
}
