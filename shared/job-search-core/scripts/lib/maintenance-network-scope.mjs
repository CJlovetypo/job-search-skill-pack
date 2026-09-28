import {AsyncLocalStorage} from 'node:async_hooks';

const storage = new AsyncLocalStorage();
export const maintenanceNetworkScope = () => storage.getStore();
export const withMaintenanceNetworkScope = (scope, work) => storage.run(scope, work);

/** Shared by the workers, including requests made inside provider detail pools. */
export function hostLimiter(max = 2) {
  const active = new Map(), queues = new Map(), cooldown = new Map();
  return {
    cooldown,
    async acquire(url, signal) {
      const host = new URL(url).host;
      if ((cooldown.get(host) || 0) > Date.now()) throw Error('host_rate_limited_until:' + new Date(cooldown.get(host)).toISOString());
      if (signal?.aborted) throw signal.reason;
      if ((active.get(host) || 0) >= max) await new Promise((resolve, reject) => {
        const queue = queues.get(host) || []; queues.set(host, queue);
        const item = {resolve: () => {signal?.removeEventListener('abort', abort); resolve();}};
        const abort = () => {const i=queue.indexOf(item);if(i>=0)queue.splice(i,1);reject(signal.reason);};
        signal?.addEventListener('abort', abort, {once:true});queue.push(item);
      });
      else active.set(host, (active.get(host) || 0) + 1);
      if (signal?.aborted) {this.release(host);throw signal.reason;}
      if ((cooldown.get(host) || 0) > Date.now()) {this.release(host);throw Error('host_rate_limited');}
      return () => this.release(host);
    },
    release(host) {
      const item=queues.get(host)?.shift();
      if(item)item.resolve();else active.set(host,Math.max(0,(active.get(host)||0)-1));
    },
    rateLimit(url, retryAfter) {
      const seconds=Number(retryAfter), parsed=Date.parse(retryAfter);
      cooldown.set(new URL(url).host,Math.max(Date.now()+1000,Number.isFinite(seconds)&&seconds>0?Date.now()+seconds*1000:Number.isFinite(parsed)?parsed:Date.now()+60000));
    }
  };
}

export function createMaintenanceScope({deadlineMs=90000,maxRequests=12,maxPages=2,maxDetails=3,limiter=hostLimiter(),signal}={}) {
  const deadline=AbortSignal.timeout(deadlineMs);
  return {signal:signal?AbortSignal.any([deadline,signal]):deadline,remaining:maxRequests,maxRequests,limiter,records:[],counts:{list:0,detail:0,identity:0},
    claim(purpose){
      const kind=/job_list|job_search/.test(purpose)?'list':/job_detail/.test(purpose)?'detail':/identity/.test(purpose)?'identity':null;
      const cap=kind==='list'?maxPages:kind==='detail'?maxDetails:2;
      if(kind&&this.counts[kind]>=cap)throw Error('maintenance_'+kind+'_budget_exhausted');
      if(kind)this.counts[kind]++;
    }};
}
