import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requestSlot, retryAfterMs} from './lib/waiqi-utils.mjs';

const root = path.resolve(process.argv[2] || 'shared/job-search-core/state/maintenance/waiqi-2026-09-20');
const base = 'https://backservice.offerxiansheng.com/api/position-service';
const concurrency = Number(process.env.WAIQI_CONCURRENCY || 3);
const interval = Number(process.env.WAIQI_INTERVAL_MS || 750);
const transport = process.env.WAIQI_TRANSPORT || 'fetch';
const exec = promisify(execFile);
if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isFinite(interval) || interval < 0) throw Error('Invalid WAIQI_CONCURRENCY or WAIQI_INTERVAL_MS');
const read = async file => { try { return JSON.parse(await fs.readFile(path.join(root, file), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const save = async (file, value) => { const target = path.join(root, file); await fs.mkdir(path.dirname(target), {recursive: true}); const temporary = target + '.' + process.pid + '.tmp'; await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n'); await fs.rename(temporary, target); };
const hash = value => createHash('sha256').update(value).digest('hex');
let nextRequest = 0, cooldownUntil = 0;
async function throttle() {
  for (;;) {
    const slot = requestSlot(Date.now(), nextRequest, cooldownUntil, interval);
    if (!slot.waitMs) { nextRequest = slot.nextRequest; return; }
    await new Promise(resolve => setTimeout(resolve, slot.waitMs));
  }
}
async function fetchPositions(id, previous) {
  const url = base + '/company/position-all?companyId=' + encodeURIComponent(id);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await throttle();
      let status, text, retryAfter = null;
      if (transport === 'curl-proxy') {
        // curl honors the configured HTTPS_PROXY used by the normal browser route.
        // No browser cookies or login state are exported.
        const response = await exec('curl.exe', ['-sS', '--max-time', '30', '-H', 'source: 24', '-H', 'Origin: https://waiqi.com', '-H', 'Referer: https://waiqi.com/', '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36', '-w', '\n%{http_code}', url], {maxBuffer: 25 * 1024 * 1024});
        const split = response.stdout.lastIndexOf('\n');
        text = response.stdout.slice(0, split); status = Number(response.stdout.slice(split + 1));
      } else {
        const response = await fetch(url, {headers: {source: '24'}, signal: AbortSignal.timeout(30000)});
        status = response.status; retryAfter = response.headers.get('retry-after'); text = await response.text();
      }
      if (status === 429) {
        const delay = Math.max(60000 * (attempt + 1), retryAfterMs(retryAfter));
        cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
        console.log(JSON.stringify({phase: 'rate_limit_cooldown', seconds: Math.ceil(delay / 1000)}));
      }
      let body;
      try { body = JSON.parse(text); } catch { throw Error('HTTP ' + status + ': response is not JSON'); }
      if (status < 200 || status >= 300 || ![0, 200, 1000].includes(Number(body.code)) || !Array.isArray(body.data)) throw Error('HTTP ' + status + ', code ' + body.code + ': ' + body.message);
      return {success: true, observation_kind: 'position_list_response', fetched_at: new Date().toISOString(), request: {url, method: 'GET'}, response_sha256: hash(text), supersedes: {observation_kind: previous.observation_kind, evidence_file: previous.evidence_file, fetched_at: previous.fetched_at, derived_at: previous.derived_at}, data: body.data};
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

const list = await read('company-list.json');
if (!list?.companies) throw Error('Missing company-list.json');
const queue = [];
for (const company of list.companies) {
  const previous = await read('positions/' + company.id + '.json');
  if (previous?.observation_kind === 'company_info_reports_zero_positions') queue.push({company, previous});
}
const failures = []; let cursor = 0, done = 0, nonempty = 0, jobs = 0;
await Promise.all(Array.from({length: concurrency}, async () => {
  while (cursor < queue.length) {
    const item = queue[cursor++];
    try {
      const result = await fetchPositions(item.company.id, item.previous);
      await save('positions/' + item.company.id + '.json', result);
      if (result.data.length) { nonempty++; jobs += result.data.length; }
    } catch (error) {
      failures.push({waiqi_company_id: item.company.id, display_name: item.company.name, error: error.message});
    }
    done++;
    if (done % 50 === 0 || done === queue.length) console.log(JSON.stringify({phase: 'derived-zero-position-lists', done, total: queue.length, nonempty, jobs, failures: failures.length}));
  }
}));
const summary = {finished_at: new Date().toISOString(), requested: queue.length, completed: queue.length - failures.length, nonempty_companies: nonempty, jobs_observed: jobs, still_empty: queue.length - failures.length - nonempty, failures};
await save('derived-zero-position-refetch-summary.json', summary);
console.log(JSON.stringify({...summary, failures: failures.length}, null, 2));
