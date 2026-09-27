import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {INDUSTRIES, normalizeIndustries, industryMatches} from '../../shared/job-search-core/scripts/lib/industry-routing.mjs';
import {loadCompanyContext} from '../../shared/job-search-core/scripts/lib/company-records.mjs';
import {normalizeBusinessFilters,businessMatchMode,businessMatches} from '../../shared/job-search-core/scripts/lib/business-taxonomy.mjs';
import {normalizeJobLocations, normalizeCityFilters, jobCityStatus} from '../../shared/job-search-core/scripts/lib/locations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.resolve(ROOT, '../shared/job-search-core/assets/sources.json');
const json = value => JSON.stringify(value);
const hash = value => createHash('sha256').update(json(value)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const modes = {campus:'formal', social:'social', internship:'internship'};
const words = (value, field) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x.trim())) throw Error(field + ' 必须为非空字符串数组');
  return [...new Set(value.map(x => x.trim()))].sort();
};
export function normalizeConfig(raw, companies) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id || '')) throw Error('id 使用小写英文、数字和短横线，最多64字符');
  if (!Object.hasOwn(modes, raw.mode)) throw Error('mode 必须为 campus/social/internship');
  const c = {id:raw.id, name:String(raw.name || raw.id), mode:raw.mode,
    keywords:words(raw.keywords,'keywords'), exclude_keywords:words(raw.exclude_keywords,'exclude_keywords'),
    company_ids:words(raw.company_ids,'company_ids'), cities:normalizeCityFilters(words(raw.cities,'cities')),
    industries:normalizeIndustries(raw.industries || ['all']),
    business_filters:normalizeBusinessFilters(raw.business_filters),business_filter_match:businessMatchMode(raw.business_filter_match)};
  if (!c.keywords.length && !c.company_ids.length && !c.business_filters.length && c.industries.includes('all')) throw Error('至少提供岗位词、具体行业、业务或公司');
  const unknown = c.company_ids.filter(id => !companies.some(x => x.company_id === id));
  if (unknown.length) throw Error('来源库未收录的公司ID：' + unknown.join(', '));
  if (!selectCompanies(c, companies).length) throw Error('行业与公司交集为空，请检查条件');
  return c;
}
export function selectCompanies(c, companies) {
  const wanted=normalizeBusinessFilters(c.business_filters),match=businessMatchMode(c.business_filter_match);
  return companies.filter(x => (!c.company_ids.length || c.company_ids.includes(x.company_id)) && industryMatches(x,c.industries)&&businessMatches(x.business_tags,wanted,match));
}
export function openDb(file = path.join(ROOT,'state/radar.sqlite')) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, config TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, subscription TEXT, revision INTEGER, started TEXT, finished TEXT, status TEXT, config TEXT, error TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_running ON runs(subscription) WHERE status='running';
    CREATE TABLE IF NOT EXISTS coverage(run TEXT, company TEXT, payload TEXT, PRIMARY KEY(run,company));
    CREATE TABLE IF NOT EXISTS jobs(subscription TEXT, revision INTEGER, company TEXT, job TEXT, fingerprint TEXT, payload TEXT, first_seen TEXT, last_seen TEXT, missing INTEGER DEFAULT 0, PRIMARY KEY(subscription,revision,company,job));
    CREATE TABLE IF NOT EXISTS events(run TEXT, company TEXT, job TEXT, kind TEXT, payload TEXT, PRIMARY KEY(run,company,job));`);
  return db;
}
export function subscribe(db,c) {
  const old = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(c.id);
  const revision = old ? old.revision + Number(old.config !== json(c)) : 1;
  db.prepare('INSERT INTO subscriptions VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET config=excluded.config,revision=excluded.revision').run(c.id,json(c),revision);
  return {id:c.id,revision,enabled:old ? Boolean(old.enabled) : true};
}
function candidate(c,j) {
  const title = String(j.title || '').toLowerCase();
  if (c.keywords.length && !c.keywords.some(k => title.includes(k.toLowerCase()))) return null;
  if (c.exclude_keywords.some(k => title.includes(k.toLowerCase()))) return null;
  if (Object.values(modes).includes(j.formal_status) && j.formal_status !== modes[c.mode]) return null;
  if (['activity','parttime'].includes(j.formal_status)) return null;
  const loc = normalizeJobLocations(j), locations = loc.cities;
  const cityStatus = jobCityStatus({cities:locations,location_unknown:loc.unknown,location_special:loc.special},c.cities);
  if (cityStatus === 'excluded') return null;
  const pending = [];
  if (j.formal_status !== modes[c.mode]) pending.push('招聘类型');
  if (c.cities.length && cityStatus === 'unknown') pending.push('城市');
  if (!j.body_complete) pending.push('JD正文');
  if (j.open_status !== 'open') pending.push('开放状态');
  return {...j, radar_pending:pending, radar_locations:locations};
}
function semantic(j) {
  return hash([j.title,j.description || '',j.requirements || '',j.radar_locations.slice().sort(),j.formal_status,j.open_status,j.salary || j.salary_raw || '',j.official_url || '',j.radar_pending]);
}
export function ingest(db,run,c,revision,company,result,now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO coverage VALUES(?,?,?)').run(run,company.company_id,json(result.coverage || {status:'failed',reason:'缺少覆盖记录'}));
    const seen = new Set();
    for (const raw of result.jobs || []) {
      if (raw.job_id === undefined || raw.job_id === null || String(raw.job_id) === '') throw Error('来源返回岗位缺少稳定 job_id');
      const id = String(raw.job_id); seen.add(id);
      const j = candidate(c,raw); if (!j) continue;
      j.company_name = company.display_name;
      const old = db.prepare('SELECT * FROM jobs WHERE subscription=? AND revision=? AND company=? AND job=?').get(c.id,revision,company.company_id,id);
      const fingerprint = semantic(j);
      const kind = !old ? 'new' : old.missing ? 'reappeared' : old.fingerprint !== fingerprint ? 'updated' : null;
      db.prepare(`INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(subscription,revision,company,job) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload,last_seen=excluded.last_seen,missing=0`).run(c.id,revision,company.company_id,id,fingerprint,json(j),old?.first_seen || now,now);
      if (kind) db.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?)').run(run,company.company_id,id,kind,json(j));
    }
    // Absence is meaningful only after a complete company scan; it is never proof of closure.
    if (result.coverage?.status === 'complete') {
      const previous = db.prepare('SELECT * FROM jobs WHERE subscription=? AND revision=? AND company=? AND missing=0').all(c.id,revision,company.company_id);
      for (const old of previous) if (!seen.has(old.job)) {
        db.prepare('UPDATE jobs SET missing=1 WHERE subscription=? AND revision=? AND company=? AND job=?').run(c.id,revision,company.company_id,old.job);
        db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(run,company.company_id,old.job,'missing',old.payload);
      }
    }
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}
export async function runSubscription(db,id,companies,collector,{maxPages=100,timeoutMs=20000}={}) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
  if (!sub) throw Error('订阅不存在');
  if (!sub.enabled) throw Error('订阅已暂停');
  const c = JSON.parse(sub.config), selected = selectCompanies(c,companies);
  if (!selected.length || c.company_ids.some(id => !companies.some(x => x.company_id === id))) throw Error('来源库范围已变化，请更新订阅');
  const run = randomUUID(), started = new Date().toISOString();
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run(run,id,sub.revision,started,null,'running',sub.config,null);
  try {
    for (const company of selected) {
      let result;
      try { result = await collector(company,{mode:'full',targetMode:c.mode,maxPages,timeoutMs,repair:false,cities:c.cities}); }
      catch(e) { result = {jobs:[],coverage:{status:'failed',reason:String(e.message || e)}}; }
      ingest(db,run,c,sub.revision,company,result,new Date().toISOString());
    }
    const coverage = db.prepare('SELECT payload FROM coverage WHERE run=?').all(run).map(x=>JSON.parse(x.payload));
    const status = coverage.every(x=>x.status==='complete') ? 'complete' : coverage.every(x=>x.status==='failed') ? 'failed' : 'partial';
    db.prepare('UPDATE runs SET status=?,finished=? WHERE id=?').run(status,new Date().toISOString(),run);
    return run;
  } catch(e) {
    db.prepare('UPDATE runs SET status=?,finished=?,error=? WHERE id=?').run('failed',new Date().toISOString(),String(e.message),run);
    throw e;
  }
}
const cell = value => String(value ?? '未披露').replace(/[\r\n]+/g,' ').replace(/[\\`*_{}\[\]<>|]/g, x=>'\\'+x);
function link(j) {
  try { const u = new URL(j.official_url); if (!['https:','http:'].includes(u.protocol)) return '链接待核实';
    return `[${j.job_url_kind==='official_detail'?'查看岗位':'招聘入口（ID '+cell(j.job_id)+'）'}](${u.href.replace(/[()]/g,c=>encodeURIComponent(c))})`;
  } catch {return '链接待核实';}
}
export function renderReport(db,run,{limit=10,timeZone='Asia/Shanghai'}={}) {
  const r = db.prepare('SELECT * FROM runs WHERE id=?').get(run); if (!r) throw Error('运行不存在');
  const c = JSON.parse(r.config);
  const events = db.prepare('SELECT * FROM events WHERE run=? ORDER BY company,job').all(run);
  const coverage = db.prepare('SELECT * FROM coverage WHERE run=? ORDER BY company').all(run).map(x=>({...x,...JSON.parse(x.payload)}));
  const count = kind => events.filter(x=>x.kind===kind).length;
  const rows = events.filter(x=>x.kind!=='missing').map(x=>({...x,j:JSON.parse(x.payload)})).sort((a,b)=>a.j.radar_pending.length-b.j.radar_pending.length);
  const labels = {new:'首次发现',updated:'更新',reappeared:'重新出现'};
  const text = [`# ${cell(c.name)} · 岗位日报`, '', new Date(r.started).toLocaleString('zh-CN',{timeZone})+`（${timeZone}）`, '',
    `首次发现 **${count('new')}** · 更新 **${count('updated')}** · 重新出现 **${count('reappeared')}** · 本次未见 **${count('missing')}**`, '',
    `覆盖 ${coverage.length} 家：完整 ${coverage.filter(x=>x.status==='complete').length}，部分 ${coverage.filter(x=>x.status==='partial').length}，失败 ${coverage.filter(x=>x.status==='failed').length}。运行状态：${r.status}。`, '',
    `范围：${cell(c.mode)}；岗位词 ${cell(c.keywords.join(' / ') || '不限')}；行业 ${cell(c.industries.join(' / '))}；业务 ${cell((c.business_filters||[]).join(' / ') || '不限')}（${cell(c.business_filter_match||'any')}）；城市 ${cell(c.cities.join(' / ') || '不限')}；公司 ${cell(c.company_ids.join(' / ') || '条件内全部已收录公司')}。`, '',
    '| 变化 | 公司 / 岗位 | 城市 | 薪资 | 需核实 | 链接 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const {kind,j} of rows.slice(0,limit)) text.push(`| ${labels[kind]} | ${cell(j.company_name)} / ${cell(j.title)} | ${cell(j.radar_locations.join(' / ') || '未知')} | ${cell(j.salary || j.salary_raw)} | ${cell(j.radar_pending.join('、') || '—')} | ${link(j)} |`);
  if (!rows.length) text.push('',coverage.every(x=>x.status==='complete') && r.status==='complete' ? '本次没有新发现或更新的目标岗位。' : '本次未发现可展示的变化；存在采集缺口，不能判断为没有招聘。');
  if (rows.length>limit) text.push('',`仅展示前 ${limit} 条，其余 ${rows.length-limit} 条已保存在本地；用 report --limit 增大展示数量。`);
  if (count('missing')) text.push('', '本次未见（不等于已下架）：'+events.filter(x=>x.kind==='missing').slice(0,limit).map(x=>{const j=JSON.parse(x.payload);return cell(j.company_name+' / '+j.title);}).join('；'));
  const gaps = coverage.filter(x=>x.status!=='complete');
  if (gaps.length) text.push('', '采集缺口：', ...gaps.map(x=>`- ${cell(x.company)}：${cell(x.status)}；${cell(x.reason || '原因未提供')}`));
  if (r.error) text.push('', '运行异常：'+cell(r.error));
  text.push('', '“首次发现”是本地首次收录，不代表今天发布。标题词检索可能遗漏其他命名的岗位；本报告反映关注条件，不是简历匹配或投递评级。', '', `运行编号：${run}`,'');
  return text.join('\n');
}
async function main() {
  const [command,...args] = process.argv.slice(2), flags = {};
  for (let i=0;i<args.length;i+=2) {if (!args[i].startsWith('--') || args[i+1]===undefined) throw Error('参数格式：--名称 值'); flags[args[i].slice(2)] = args[i+1];}
  const positive = (name,fallback) => {const n = Number(flags[name] || fallback); if (!Number.isInteger(n)||n<1) throw Error(name+' 必须为正整数'); return n;};
  if (command==='industries') return console.log(json(INDUSTRIES));
  const context=await loadCompanyContext(),records=new Map(context.records.companies.map(x=>[x.company_id,x]));
  const companies=context.registry.companies.map(x=>({...x,business_tags:records.get(x.company_id)?.tags.business||[],business_status:records.get(x.company_id)?.governance.fields['tags.business'].status}));
  if (command==='catalog') {
    const wanted=normalizeBusinessFilters(flags.businesses),match=businessMatchMode(flags['business-match']);
    return console.log(json(companies.filter(x=>businessMatches(x.business_tags,wanted,match)&&(!flags.query||[x.display_name,x.company_id,...x.industry_tags||[],...x.business_tags].join(' ').toLowerCase().includes(flags.query.toLowerCase()))).map(x=>({id:x.company_id,name:x.display_name,industries:x.industry_tags,business_tags:x.business_tags,business_status:x.business_status}))));
  }
  const db = openDb(flags.db);
  try {
    if (command==='subscribe') console.log(json(subscribe(db,normalizeConfig(read(flags.file),companies))));
    else if (command==='list') console.log(json(db.prepare('SELECT * FROM subscriptions').all().map(x=>({...x,config:JSON.parse(x.config)}))));
    else if (command==='runs') console.log(json(db.prepare('SELECT id,subscription,revision,started,finished,status,error FROM runs WHERE subscription=? ORDER BY started DESC').all(flags.id)));
    else if (['pause','resume'].includes(command)) {if (!db.prepare('UPDATE subscriptions SET enabled=? WHERE id=?').run(Number(command==='resume'),flags.id).changes) throw Error('订阅不存在'); console.log(command+': '+flags.id);}
    else if (command==='recover') {
      // Only after the agent has verified that the owning process has stopped.
      if (!db.prepare("UPDATE runs SET status='failed',finished=?,error='执行进程已终止，人工恢复' WHERE id=? AND status='running'").run(new Date().toISOString(),flags.run).changes) throw Error('没有对应的进行中运行');
    }
    else if (command==='run' || command==='report') {
      let run = flags.run;
      if (command==='run') {
        const sub = db.prepare('SELECT config FROM subscriptions WHERE id=?').get(flags.id); if (!sub) throw Error('订阅不存在');
        const {configureRuntime} = await import('../../shared/job-search-core/runtime-context.mjs');
        configureRuntime({mode:JSON.parse(sub.config).mode});
        const {collectCompanySources} = await import('../../shared/job-search-core/scripts/lib/source-collector.mjs');
        run = await runSubscription(db,flags.id,companies,collectCompanySources,{maxPages:positive('max-pages',100),timeoutMs:positive('timeout-ms',20000)});
      }
      if (!run) run = db.prepare('SELECT id FROM runs WHERE subscription=? ORDER BY started DESC LIMIT 1').get(flags.id)?.id;
      const report = renderReport(db,run,{limit:positive('limit',10),timeZone:flags.timezone || 'Asia/Shanghai'});
      const out = path.resolve(flags.out || path.join(ROOT,'outputs',run+'.md'));
      fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,report); console.log(json({run,report:out}));
    } else throw Error('命令：industries / catalog / subscribe --file / list / runs --id / pause|resume --id / run --id / report --id|--run / recover --run');
  } finally {db.close();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
