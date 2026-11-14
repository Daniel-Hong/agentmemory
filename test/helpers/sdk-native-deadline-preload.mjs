// Fixture-only filesystem latency and mock fetch; the native hook source is unchanged by this helper.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
const dir = process.env.AGENTMEMORY_SDK_CAPTURE_V2_DIR;
const recordPath = process.env.FIXTURE_TRACE;
if (!dir?.startsWith(process.env.HOME + '/') || !recordPath?.startsWith(process.env.HOME + '/') || process.env.AGENTMEMORY_URL !== 'http://127.0.0.1:43111') throw Error('FIXTURE_ISOLATION');
const trace = (event, fields = {}) => fs.appendFileSync(recordPath, JSON.stringify({ event, atMs: Math.round(performance.now()), ...fields }) + '\n', { mode: 0o600 });
const actualTimer = globalThis.setTimeout;
let capArmed = false, delayDone = false;
globalThis.setTimeout = function(fn, ms, ...args) {
  if (ms === 3500) { capArmed = true; trace('native_cap_armed', { milliseconds: ms }); }
  return actualTimer(fn, ms, ...args);
};
const actualStat = fs.lstatSync;
fs.lstatSync = function(path, ...args) {
  if (capArmed && !delayDone && String(path).startsWith(dir)) {
    delayDone = true;
    const ms = Number(process.env.FIXTURE_LOCAL_DELAY_MS);
    trace('local_delay', { milliseconds: ms });
    if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
  return actualStat.call(this, path, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = async function(url, options) {
  if (url !== 'http://127.0.0.1:43111/agentmemory/observe' || options?.method !== 'POST') throw Error('FIXTURE_NETWORK_REFUSED');
  const body = JSON.parse(options.body);
  trace('mock_post_started');
  await new Promise((resolve, reject) => {
    let timer;
    const abort = () => { clearTimeout(timer); trace('mock_post_aborted'); reject(options.signal.reason); };
    if (options.signal.aborted) return abort();
    options.signal.addEventListener('abort', abort, { once: true });
    timer = actualTimer(() => { options.signal.removeEventListener('abort', abort); resolve(); }, Number(process.env.FIXTURE_REPLY_DELAY_MS));
  });
  trace('mock_ack_returned');
  return { status: 201, json: async () => ({ eventId: body.eventId, completion: 'sdk', completed: true, durable: false }) };
};
process.once('exit', code => trace('process_exit', { code }));
