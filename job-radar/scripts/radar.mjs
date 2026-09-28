import {normalizeRadarConfig,radarQuery,radarSelection} from './query.mjs';
import {initializeReviewTables,collectRadar,pendingReviews,submitReviews,finalizeRadar} from './review-runtime.mjs';
import {migrationPreview,migrateDatabase,rollbackMigration} from './migration.mjs';
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
export const normalizeConfig=normalizeRadarConfig;
export function selectCompanies(c, companies, context={registry:{companies}}) {
 return radarSelection(c,context).companies;
}
export function openDb(file = path.join(ROOT,'state/radar.sqlite'),{readOnly=false}={}) {
  if(readOnly)return new DatabaseSync(file,{readOnly:true});
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const db = new DatabaseSync(file);
  if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subscriptions'").get()&&db.prepare('PRAGMA user_version').get().user_version<2){db.close();throw Error('旧雷达数据库需先 migrate-preview 与 migrate；只读 list/runs/report 仍可使用');}
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, config TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, subscription TEXT, revision INTEGER, started TEXT, finished TEXT, status TEXT, config TEXT, error TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_running ON runs(subscription) WHERE status IN ('running','awaiting_review','finalizing');
    CREATE TABLE IF NOT EXISTS coverage(run TEXT, company TEXT, payload TEXT, PRIMARY KEY(run,company));
    CREATE TABLE IF NOT EXISTS jobs(subscription TEXT, revision INTEGER, company TEXT, job TEXT, fingerprint TEXT, payload TEXT, first_seen TEXT, last_seen TEXT, missing INTEGER DEFAULT 0, PRIMARY KEY(subscription,revision,company,job));
    CREATE TABLE IF NOT EXISTS events(run TEXT, company TEXT, job TEXT, kind TEXT, payload TEXT, PRIMARY KEY(run,company,job));`);
  initializeReviewTables(db);db.exec('PRAGMA user_version=2');
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
  if (c.retrieval.mode==='targeted' && c.keywords.length && !c.keywords.some(k => title.includes(k.toLowerCase()))) return null;
  if (c.retrieval.mode==='targeted' && c.exclude_keywords.some(k => title.includes(k.toLowerCase()))) return null;
  if (Object.values(modes).includes(j.formal_status) && j.formal_status !== modes[c.mode]) return null;
  if (['activity','parttime'].includes(j.formal_status)) return null;
  const loc = normalizeJobLocations(j), locations = loc.cities;
  const cityStatus = jobCityStatus({cities:locations,location_unknown:loc.unknown,location_special:loc.special},radarQuery(c).city_filters);
  if (cityStatus === 'excluded') return null;
  if(j.role_relevance?.status==='unrelated')return null;
  const pending = [];
  if(j.role_relevance?.status==='uncertain')pending.push('职能相关性');
  if (j.formal_status !== modes[c.mode]) pending.push('招聘类型');
  if (radarQuery(c).city_filters.length && cityStatus === 'unknown') pending.push('城市');
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
      const j = candidate(c,raw);
      if(!j){
       if(raw.role_relevance?.status==='unrelated'){
        const previous=db.prepare('SELECT payload FROM jobs WHERE subscription=? AND revision=? AND company=? AND job=?').get(c.id,revision,company.company_id,id);
        if(previous&&JSON.parse(previous.payload).role_relevance?.status!=='unrelated'){
         const changed={...JSON.parse(previous.payload),...raw,company_name:company.display_name,radar_locations:raw.cities||[],radar_pending:[]};
         db.prepare('UPDATE jobs SET payload=?,missing=0,last_seen=? WHERE subscription=? AND revision=? AND company=? AND job=?').run(json(changed),now,c.id,revision,company.company_id,id);
         if(!result.baseline_reset)db.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?)').run(run,company.company_id,id,'matching_changed',json(changed));
        }
       }
       continue;
      }
      j.company_name = company.display_name;
      const old = db.prepare('SELECT * FROM jobs WHERE subscription=? AND revision=? AND company=? AND job=?').get(c.id,revision,company.company_id,id);
      const fingerprint = semantic(j);
      const kind = result.baseline_reset ? null : !old ? 'new' : result.migration_bridge ? null : JSON.parse(old.payload).role_relevance?.status==='unrelated'?'matching_changed':old.missing ? 'reappeared' : old.fingerprint !== fingerprint ? 'updated' : null;
      db.prepare(`INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(subscription,revision,company,job) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload,last_seen=excluded.last_seen,missing=0`).run(c.id,revision,company.company_id,id,fingerprint,json(j),old?.first_seen || now,now);
      if (kind) db.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?)').run(run,company.company_id,id,kind,json(j));
    }
    // Absence is meaningful only after a complete company scan; it is never proof of closure.
    if (result.coverage?.status === 'complete' && result.comparison_allowed!==false) {
      const previous = db.prepare('SELECT * FROM jobs WHERE subscription=? AND revision=? AND company=? AND missing=0').all(c.id,revision,company.company_id);
      for (const old of previous) if (!seen.has(old.job)&&JSON.parse(old.payload).role_relevance?.status!=='unrelated') {
        db.prepare('UPDATE jobs SET missing=1 WHERE subscription=? AND revision=? AND company=? AND job=?').run(c.id,revision,company.company_id,old.job);
        db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(run,company.company_id,old.job,'missing',old.payload);
      }
    }
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}
export async function runSubscription(db,id,companies,collector,{context={registry:{companies}},...options}={}) {
 const run=await collectRadar(db,id,context,collector,options);
 finalizeRadar(db,run,ingest);return run;
}
export const reviewExport=(db,run)=>({run,items:pendingReviews(db,run),notice:'逐条阅读全文，仅判断职能相关性，不做个人匹配。'});
export const reviewSubmit=submitReviews;
export const finalize=(db,run)=>finalizeRadar(db,run,ingest);
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
  const labels = {new:'首次发现',updated:'更新',reappeared:'重新出现',matching_changed:'关注条件匹配变化'};
  const snapshotRow=db.prepare("SELECT name FROM sqlite_master WHERE name='run_context'").get()?db.prepare('SELECT payload FROM run_context WHERE run=?').get(run):null,snapshot=snapshotRow?JSON.parse(snapshotRow.payload):null;
  const text = [`# ${cell(c.name)} · 岗位日报`, '', new Date(r.started).toLocaleString('zh-CN',{timeZone})+`（${timeZone}）`, '',
    `首次发现 **${count('new')}** · 更新 **${count('updated')}** · 重新出现 **${count('reappeared')}** · 本次未见 **${count('missing')}**`, '',
    `覆盖 ${coverage.length} 家：完整 ${coverage.filter(x=>x.status==='complete').length}，部分 ${coverage.filter(x=>x.status==='partial').length}，失败 ${coverage.filter(x=>x.status==='failed').length}。运行状态：${r.status}。`, '',
    `范围：${cell(c.mode)}；岗位词 ${cell(c.keywords.join(' / ') || '不限')}；行业 ${cell(c.industries.join(' / '))}；业务 ${cell((c.business_filters||[]).join(' / ') || '不限')}（${cell(c.business_filter_match||'any')}）；城市 ${cell(c.cities.join(' / ') || '不限')}；公司 ${cell(c.company_ids.join(' / ') || '条件内全部已收录公司')}。`, '',
    '| 变化 | 公司 / 岗位 | 城市 | 薪资 | 需核实 | 链接 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const {kind,j} of rows.slice(0,limit)) text.push(`| ${labels[kind]} | ${cell(j.company_name)} / ${cell(j.title)} | ${cell(j.radar_locations.join(' / ') || '未知')} | ${cell(j.salary || j.salary_raw)} | ${cell(j.radar_pending.join('、') || '—')} | ${link(j)} |`);
  if(snapshot)text.push('',`搜索方式：${c.retrieval?.mode}；入选公司 ${snapshot.selection.selected_companies}；城市索引排除 ${snapshot.selection.city_excluded}；索引日期 ${snapshot.selection.city_index_updated_at||'未知'}。`);
  if(snapshot){const staged=db.prepare('SELECT payload FROM staged_results WHERE run=?').all(run).map(x=>JSON.parse(x.payload));const changed=staged.filter(x=>x.result.baseline_reset||x.result.migration_bridge);if(changed.length)text.push('',`本轮 ${changed.length} 家公司建立新的比较基线，保留历史，不据此推断旧岗位消失。`);}
  if(r.status==='awaiting_review')text.push('',`全文相关性待审 ${pendingReviews(db,run).length} 条；本轮尚未完成，不推断历史岗位消失。`);
  if(r.status==='empty_scope')text.push('','当前索引及条件下无入选来源；不是完整扫描后确认没有岗位。');
  if (!rows.length) text.push('',coverage.length>0 && coverage.every(x=>x.status==='complete') && r.status==='complete' ? '本次没有新发现或更新的目标岗位。' : '本次未发现可展示的变化；存在采集缺口，不能判断为没有招聘。');
  if (rows.length>limit) text.push('',`仅展示前 ${limit} 条，其余 ${rows.length-limit} 条已保存在本地；用 report --limit 增大展示数量。`);
  if (count('missing')) text.push('', '本次未见（不等于已下架）：'+events.filter(x=>x.kind==='missing').slice(0,limit).map(x=>{const j=JSON.parse(x.payload);return cell(j.company_name+' / '+j.title);}).join('；'));
  const gaps = coverage.filter(x=>x.status!=='complete');
  if (gaps.length) text.push('', '采集缺口：', ...gaps.map(x=>`- ${cell(x.company)}：${cell(x.status)}；${cell(x.reason || '原因未提供')}`));
  if (r.error) text.push('', '运行异常：'+cell(r.error));
  text.push('', '“首次发现”是本地首次收录，不代表今天发布。本轮查询未见不等于下架。本报告反映关注条件，不是简历匹配或投递评级。'+(c.retrieval?.mode==='targeted'?'标题词检索可能遗漏其他命名的岗位。':''), '', `运行编号：${run}`,'');
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
    for(const r of context.records.companies)if(!companies.some(c=>c.company_id===r.company_id))companies.push({company_id:r.company_id,display_name:r.identity.display_name,industry_tags:r.tags.industry,business_tags:r.tags.business,business_status:r.governance.fields['tags.business'].status,recruitment_available:false});
    const wanted=normalizeBusinessFilters(flags.businesses),match=businessMatchMode(flags['business-match']);
    return console.log(json(companies.filter(x=>businessMatches(x.business_tags,wanted,match)&&(!flags.query||[x.display_name,x.company_id,...x.industry_tags||[],...x.business_tags].join(' ').toLowerCase().includes(flags.query.toLowerCase()))).map(x=>({id:x.company_id,name:x.display_name,industries:x.industry_tags,business_tags:x.business_tags,business_status:x.business_status,recruitment_available:x.recruitment_available!==false}))));
  }
  const database=flags.db||path.join(ROOT,'state/radar.sqlite');
  if(command==='migrate-preview')return console.log(json(migrationPreview(database,companies,flags.file?read(flags.file):[])));
  if(command==='migrate')return console.log(json(migrateDatabase(database,companies,{patches:flags.file?read(flags.file):[]})));
  if(command==='migration-rollback')return console.log(json(rollbackMigration(flags.file)));
  const db = openDb(database,{readOnly:['list','runs','report','review-export'].includes(command)});
  try {
    if (command==='subscribe') console.log(json(subscribe(db,normalizeConfig(read(flags.file),companies,{context}))));
    else if (command==='list') console.log(json(db.prepare('SELECT * FROM subscriptions').all().map(x=>({...x,config:JSON.parse(x.config)}))));
    else if (command==='runs') console.log(json(db.prepare('SELECT id,subscription,revision,started,finished,status,error FROM runs WHERE subscription=? ORDER BY started DESC').all(flags.id)));
    else if (['pause','resume'].includes(command)) {if (!db.prepare('UPDATE subscriptions SET enabled=? WHERE id=?').run(Number(command==='resume'),flags.id).changes) throw Error('订阅不存在'); console.log(command+': '+flags.id);}
    else if (command==='recover') {
      // Only after the agent has verified that the owning process has stopped.
      if (!db.prepare("UPDATE runs SET status='failed',finished=?,error='执行进程已终止，人工恢复' WHERE id=? AND status='running'").run(new Date().toISOString(),flags.run).changes) throw Error('没有对应的进行中运行');
    }
    else if(command==='review-export'){const result=reviewExport(db,flags.run);if(flags.limit)result.items=result.items.slice(0,positive('limit',20));if(flags.out){fs.mkdirSync(path.dirname(path.resolve(flags.out)),{recursive:true});fs.writeFileSync(flags.out,json(result));console.log(json({file:flags.out,items:result.items.length}));}else console.log(json(result));}
    else if(command==='review-submit')console.log(json(reviewSubmit(db,flags.run,read(flags.file).items)));
    else if(command==='finalize')console.log(json(finalize(db,flags.run)));
    else if (command==='run' || command==='report') {
      let run = flags.run;
      if (command==='run') {
        const sub = db.prepare('SELECT config FROM subscriptions WHERE id=?').get(flags.id); if (!sub) throw Error('订阅不存在');
        const {configureRuntime} = await import('../../shared/job-search-core/runtime-context.mjs');
        configureRuntime({mode:JSON.parse(sub.config).mode,outputRoot:ROOT});
        const {retrieveCompany} = await import('../../shared/job-search-core/scripts/lib/job-retrieval.mjs');
        const capabilities=read(path.join(ROOT,'../shared/job-search-core/data/source-search-capabilities.json'));
        const collectCompanySources=(company,opts)=>retrieveCompany(company,opts.query,{...opts,capabilities,evidenceDir:path.join(ROOT,'state','evidence',randomUUID(),company.company_id)});
        run = await runSubscription(db,flags.id,companies,collectCompanySources,{context,maxPages:positive('max-pages',100),timeoutMs:positive('timeout-ms',20000)});
      }
      if (!run) run = db.prepare('SELECT id FROM runs WHERE subscription=? ORDER BY started DESC LIMIT 1').get(flags.id)?.id;
      const report = renderReport(db,run,{limit:positive('limit',10),timeZone:flags.timezone || 'Asia/Shanghai'});
      const out = path.resolve(flags.out || path.join(ROOT,'outputs',run+'.md'));
      fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,report); console.log(json({run,report:out,status:db.prepare('SELECT status FROM runs WHERE id=?').get(run).status,pending:pendingReviews(db,run).length,next_step:pendingReviews(db,run).length?'review-export → review-submit → finalize → report':null}));
    } else throw Error('命令：industries / catalog / subscribe --file / list / runs --id / pause|resume --id / run --id / report --id|--run / recover --run');
  } finally {db.close();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
