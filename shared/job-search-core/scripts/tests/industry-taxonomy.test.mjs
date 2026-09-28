import test from 'node:test';
import assert from 'node:assert/strict';
import {INDUSTRIES,normalizeIndustries,routeCompanies,industryLabels,validateIndustryTags} from '../lib/industry-routing.mjs';
test('current industry labels containing punctuation round trip and aliases are unambiguous',()=>{
 for(const row of INDUSTRIES){assert.deepEqual(normalizeIndustries(row.label),[row.id]);for(const alias of row.aliases)assert.deepEqual(normalizeIndustries(alias),[row.id]);}
 assert.deepEqual(normalizeIndustries('software_it,games'),['software_it','games']);
 assert.deepEqual(industryLabels(['unknown']),['unknown']);
});
test('retired broad industry preferences require a new explicit selection',()=>{
 for(const key of ['internet','智能硬件','supply_chain','professional_services','diversified'])assert.throws(()=>normalizeIndustries(key),/旧行业分类需要重新选择/);
 assert.deepEqual(normalizeIndustries('不限行业'),['all']);
});
test('multiple actual business industries form a union without duplicating companies; unknown stays unknown',()=>{
 const companies=[{company_id:'a',industry_tags:['games','software_it']},{company_id:'b',industry_tags:['software_it']},{company_id:'c',industry_tags:[]}];
 assert.deepEqual(routeCompanies(companies,['games','software_it']).map(x=>x.company_id),['a','b']);
 assert.equal(routeCompanies(companies,['all']).length,3);
 for(const tags of [[],['games','software_it']])assert.doesNotThrow(()=>validateIndustryTags(tags));
 for(const tags of [['internet'],['games','games'],['all']])assert.throws(()=>validateIndustryTags(tags));
});
