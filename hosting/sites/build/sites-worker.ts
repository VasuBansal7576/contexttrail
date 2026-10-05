import handler from 'vinext/server/fetch-handler';
import { requestContext } from '../src/lib/hosted/context';
export default {
  fetch(request:Request,env:Cloudflare.Env,ctx:ExecutionContext) {
    return requestContext.run(request,()=>handler.fetch(request,env,ctx));
  },
};
