import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const TOKEN = '__agentmemoryShutdownAdmission';
const drainingError = () => Object.assign(Error('worker_draining'), { code: 'WORKER_DRAINING', retryable: true });
const drainingResponse = () => ({ status_code: 503, body: { success: false, error: 'worker_draining', retryable: true } });
export function createShutdownIngress() {
  const context = new AsyncLocalStorage(), active = new Set(), permits = new Map();
  let closed = false;
  function track(fn, inherited = context.getStore()) {
    if (closed && (!inherited || permits.get(inherited.id) !== inherited)) return Promise.reject(drainingError());
    const permit = inherited ?? { id: randomUUID(), references: 0 };
    permit.references++;
    permits.set(permit.id, permit);
    const promise = context.run(permit, () => Promise.resolve().then(fn));
    active.add(promise);
    const done = () => { active.delete(promise); if (--permit.references === 0) permits.delete(permit.id); };
    promise.then(done, done);
    return promise;
  }
  return {
    close() { closed = true; },
    isClosed: () => closed,
    snapshot: () => ({ closed, activeOperations: active.size }),
    track,
    async drain() { while (active.size) await Promise.allSettled([...active]); },
    install(sdk, authenticate) {
      const routes = new Map(), functions = new Set();
      const register = sdk.registerFunction.bind(sdk), registerTrigger = sdk.registerTrigger.bind(sdk), trigger = sdk.trigger.bind(sdk);
      sdk.registerTrigger = (route, ...args) => {
        if (route.type === 'http') routes.set(route.function_id, route.config.http_method?.toUpperCase());
        return registerTrigger(route, ...args);
      };
      sdk.registerFunction = (id, handler, ...args) => {
        if (typeof handler !== 'function' || id.startsWith('middleware::')) return register(id, handler, ...args);
        functions.add(id);
        return register(id, (payload, ...rest) => {
          if (routes.has(id)) {
            if (id !== 'api::liveness' && id !== 'api::viewer') {
              const denied = authenticate(payload ?? {});
              if (denied) return denied;
            }
            // Routine-status/team-profile GETs write KV too; only liveness is pure during drain.
            if (closed && id !== 'api::liveness') return drainingResponse();
            if (closed) return handler(payload, ...rest);
            return track(() => handler(payload, ...rest));
          }
          let permit;
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            permit = permits.get(payload[TOKEN]);
            if (Object.hasOwn(payload, TOKEN)) { const { [TOKEN]: _, ...clean } = payload; payload = clean; }
          }
          if (closed && !permit) return Promise.reject(drainingError());
          return track(() => handler(payload, ...rest), permit);
        }, ...args);
      };
      sdk.trigger = (request, ...args) => {
        const permit = context.getStore();
        if (!permit || !functions.has(request.function_id) || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) return trigger(request, ...args);
        // Internal object payloads carry a process-local permit across the engine, stripped before the handler.
        const tagged = { ...request, payload: { ...request.payload, [TOKEN]: permit.id } };
        const fireAndForget = tagged.action?.type === 'void';
        if (fireAndForget) delete tagged.action;
        const completion = track(() => trigger(tagged, ...args), permit);
        if (fireAndForget) {
          completion.catch(error => console.warn('[agentmemory] Accepted async invocation failed:', /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'ASYNC_INVOCATION_FAILED'));
          return Promise.resolve(undefined);
        }
        return completion;
      };
    }
  };
}
