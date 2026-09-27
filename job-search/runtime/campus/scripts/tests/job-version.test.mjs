import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {jobFingerprint,jobFingerprintMatches} from '../lib/job-version.mjs';

const job={job_id:'123',title:'实习分析师',description:'负责数据分析',requirements:'2027届，每周4天、连续3个月',locations_raw:['上海'],formal_status:'internship',open_status:'open',recruitment_evidence:{projectName:'2027实习',list_file:'raw/old.json',query_evidence:{value:['202'],response_file:'raw/old-list.json',checked_at:'2026-09-01',response_sha256:'old'},graduation_window:{from:'2027-01',to:'2027-12'}}};
test('重采文件位置与时间不改变JD；届别和查询类型改变必须重评',()=>{
 const next=structuredClone(job);next.recruitment_evidence.list_file='raw/new.json';Object.assign(next.recruitment_evidence.query_evidence,{response_file:'raw/new-list.json',checked_at:'2026-09-19',response_sha256:'new'});
 assert.equal(jobFingerprint(job),jobFingerprint(next));
 next.recruitment_evidence.graduation_window.from='2028-01';assert.notEqual(jobFingerprint(job),jobFingerprint(next));
 const changed=structuredClone(job);changed.recruitment_evidence.query_evidence.value=['101'];assert.notEqual(jobFingerprint(job),jobFingerprint(changed));
 assert.notEqual(jobFingerprint(job),jobFingerprint({...job,requirements:job.requirements+'，需5天'}));
});
test('未变历史快照保留旧指纹兼容，不给旧结论绕过正文变化',()=>{
 const saved=createHash('sha256').update(JSON.stringify({job_id:String(job.job_id),title:job.title,description:job.description,requirements:job.requirements,locations:job.locations_raw,formal_status:job.formal_status,open_status:job.open_status,recruitment_evidence:job.recruitment_evidence})).digest('hex');
 assert.ok(jobFingerprintMatches(saved,job));
 assert.equal(jobFingerprintMatches(saved,{...job,requirements:'新的完整任职条件'}),false);
});
