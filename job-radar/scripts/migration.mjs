import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {normalizeRadarConfig,configIssues} from './query.mjs';
import {initializeReviewTables} from './review-runtime.mjs';
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const quote=s=>'"'+s.replaceAll('"','""')+'"';
function databaseHash(db,schema='main'){
 const definitions=db.prepare(`SELECT type,name,sql FROM ${schema}.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
 const tables=definitions.filter(x=>x.type==='table').map(x=>[x.name,db.prepare(`SELECT * FROM ${schema}.${quote(x.name)} ORDER BY rowid`).all()]);
 return createHash('sha256').update(JSON.stringify([definitions,tables,db.prepare(`PRAGMA ${schema}.user_version`).get()])).digest('hex');
}
export function migrationPreview(file,companies,patches=[]){
 if(!fs.existsSync(file))return {database:file,subscriptions:[],needed:false};
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  const active=db.prepare("SELECT id,subscription,status FROM runs WHERE status IN ('running','awaiting_review','finalizing')").all();
  const subscriptions=db.prepare('SELECT * FROM subscriptions').all().map(row=>{
   const old=JSON.parse(row.config),patch=patches.find(p=>p.id===row.id),raw={...old,...patch};
   // Legacy keyword fields describe old implementation, not a user's strategy choice.
   if(old.schema_version!==2&&!patch?.retrieval)raw.retrieval={mode:'exhaustive',selection:'default',basis:'历史订阅未保存搜索方式选择'};
   let config,issues;
   try{config=normalizeRadarConfig(raw,companies,{allowPending:true});issues=configIssues(config);}catch(e){issues=[{field:'config',question:e.message}];}
   const oldHash=createHash('sha256').update(row.config).digest('hex');
   const prior=db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_state'").get()?db.prepare('SELECT payload FROM migration_state WHERE subscription=?').get(row.id):null;
   const alreadyPending=prior&&JSON.parse(prior.payload).old_config_hash===oldHash;
   return {id:row.id,revision:row.revision,enabled:!!row.enabled,needed:old.schema_version!==2&&(!alreadyPending||!!patch),config,issues,old_config_hash:oldHash};
  });
  return {database:path.resolve(file),needed:db.prepare('PRAGMA user_version').get().user_version<2||subscriptions.some(r=>r.needed),active_runs:active,subscriptions};
 }finally{db.close();}
}
export function migrateDatabase(file,companies,{patches=[],backupDir=path.join(path.dirname(file),'migration-backups')}={}){
 const preview=migrationPreview(file,companies,patches);if(preview.active_runs?.length)throw Error('存在运行中的订阅，不能迁移');if(!preview.needed)return {...preview,changed:false};
 fs.mkdirSync(backupDir,{recursive:true});const backup=path.join(backupDir,'radar-'+Date.now()+'.sqlite');
 const db=new DatabaseSync(file);let committed=false;
 try{
  db.exec('PRAGMA busy_timeout=5000');db.prepare('VACUUM INTO ?').run(backup);
  db.prepare('ATTACH DATABASE ? AS backup_copy').run(backup);
  db.exec('BEGIN IMMEDIATE');
  if(databaseHash(db)!==databaseHash(db,'backup_copy'))throw Error('数据库在一致性备份后变化，请重新迁移');
  if(db.prepare("SELECT 1 FROM runs WHERE status IN ('running','awaiting_review','finalizing')").get())throw Error('迁移前出现新运行');
  initializeReviewTables(db,{rebuildIndex:true});
  for(const row of preview.subscriptions){
   const current=db.prepare('SELECT config FROM subscriptions WHERE id=?').get(row.id);if(createHash('sha256').update(current.config).digest('hex')!==row.old_config_hash)throw Error('订阅在预览后变化');
   if(!row.needed)continue;
   if(!row.issues.length)db.prepare('UPDATE subscriptions SET config=? WHERE id=?').run(JSON.stringify(row.config),row.id);
   db.prepare('INSERT OR REPLACE INTO migration_state VALUES(?,?)').run(row.id,JSON.stringify({status:row.issues.length?'needs_input':'migrated',old_config_hash:row.old_config_hash,issues:row.issues,backup,at:new Date().toISOString(),notification_pending:row.issues.length>0}));
  }
  db.exec('PRAGMA user_version=2; COMMIT');committed=true;db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 }catch(e){if(!committed)try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
 const check=new DatabaseSync(file,{readOnly:true});let logicalHash;try{logicalHash=databaseHash(check);}finally{check.close();}
 const receipt={database:path.resolve(file),backup:path.resolve(backup),backup_sha256:hash(backup),migrated_sha256:hash(file),migrated_logical_hash:logicalHash,subscriptions:preview.subscriptions.map(r=>({id:r.id,status:r.issues.length?'needs_input':'migrated',issues:r.issues}))};
 fs.writeFileSync(backup+'.json',JSON.stringify(receipt,null,2));return {changed:true,receipt:backup+'.json',...receipt};
}
export function rollbackMigration(receiptFile){
 const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8')),file=path.resolve(receipt.database),backup=path.resolve(receipt.backup);
 if(file===backup||!file.endsWith('.sqlite')||hash(backup)!==receipt.backup_sha256)throw Error('迁移备份无效');
 const db=new DatabaseSync(file);let transaction=false;
 try{
  db.prepare('ATTACH DATABASE ? AS restore_copy').run(backup);db.exec('BEGIN IMMEDIATE');transaction=true;
  if(db.prepare("SELECT 1 FROM runs WHERE status IN ('running','awaiting_review','finalizing')").get())throw Error('运行期间不能回滚');
  if(databaseHash(db)!==receipt.migrated_logical_hash)throw Error('数据库在迁移后已变化，不能覆盖新历史');
  const current=db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const definitions=db.prepare("SELECT type,name,sql FROM restore_copy.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name").all();
  for(const row of current)db.exec('DROP TABLE '+quote(row.name));
  for(const row of definitions){db.exec(row.sql);if(row.type==='table')db.exec(`INSERT INTO main.${quote(row.name)} SELECT * FROM restore_copy.${quote(row.name)}`);}
  db.exec('PRAGMA user_version='+db.prepare('PRAGMA restore_copy.user_version').get().user_version);db.exec('COMMIT');transaction=false;
  return {restored:file,backup};
 }catch(e){if(transaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
}
