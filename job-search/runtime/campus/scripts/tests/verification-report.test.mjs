import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationReviewSheet} from '../lib/reports.mjs';

test('资料复核表完整列出通过、排除和残留，残留优先且不冒充匹配结论',()=>{
 const row=(id,status)=>({company_name:'样例公司',title:'项目管理（深圳）',job_id:id,official_url:'https://example.com/job/'+id,before:{formal_status:'unknown',cities:[],body_complete:false},after:{status,formal_status:status==='excluded_nonformal'?'social':'formal',cities:['深圳'],body_complete:true},recruitment_review:{reason:'接口明确标注校园招聘'},remaining_issues:status==='needs_verification'?[{code:'body',reason:'职责正文缺失'}]:[]});
 const sheet=verificationReviewSheet({items:[row('001','to_assess'),row('002','excluded_nonformal'),row('003','needs_verification')]});
 assert.equal(sheet.rows.length,3);
 assert.deepEqual(sheet.rows.map(r=>r[2]),['仍待核实','已确认不纳入','核验通过·待评估']);
 assert.equal(sheet.rows[0][6],'职责正文缺失');
 assert.equal(sheet.rows[2][8],'001');
 assert.equal(sheet.links.length,3);
 assert.match(sheet.rows[2][6],/不等于个人匹配评估已完成/);
 assert.ok(sheet.rows.every(r=>r.length===sheet.headers.length));
});
