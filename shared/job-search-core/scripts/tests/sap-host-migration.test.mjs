import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectSap,normalizeSapFeed} from '../lib/providers-global.mjs';

const source=host=>({company_id:'sap-fixture',display_name:'SAP fixture',primary_entry_url:`https://${host}/go/China/8807101/`,validated_api_request_examples:[{url:`https://${host}/services/rss/category/?catid=8807101`,method:'GET',headers:{'X-Public-Fixture':'configured'}}]});
const feed=host=>`<rss><channel><item><title>SAP China iXp Intern (Shanghai, CN)</title><link>https://${host}/job/Shanghai-Intern/12345/</link><description><![CDATA[Responsibilities: ${'Build and test reliable software with the team. '.repeat(4)} What you bring: Bachelor degree, software experience, and strong communication skills. Career Status: Student | Employment Type: Limited Full Time]]></description></item></channel></rss>`;

test('SAP legacy and reviewed migrated origins retain stable IDs and incomplete feed coverage',async()=>{
 const original=globalThis.fetch,dir=await fs.mkdtemp(path.join(os.tmpdir(),'sap-host-'));
 try{for(const host of ['jobs.sap.com','careers.sap.com']){
  const config=source(host);globalThis.fetch=async(url,init)=>{assert.equal(url,config.validated_api_request_examples[0].url);assert.equal(new Headers(init.headers).get('X-Public-Fixture'),'configured');return new Response(feed(host),{headers:{'Content-Type':'application/rss+xml'}});};
  const result=await collectSap(config,{evidenceDir:dir});
  assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].job_id,'12345');assert.equal(result.jobs[0].formal_status,'internship');assert.equal(result.jobs[0].open_status,'unknown');assert.equal(result.coverage.list_complete,false);assert.equal(result.coverage.status,'partial');
 }}finally{globalThis.fetch=original;await fs.rm(dir,{recursive:true,force:true});}
});

test('SAP rejects unreviewed migration, unrelated host, credentials, and non-job links',()=>{
 assert.throws(()=>normalizeSapFeed(feed('careers.sap.com'),source('jobs.sap.com'),'fixture'),/official stable job ID/);
 for(const host of ['careers.sap.com.evil.test','evil.test','user@careers.sap.com'])assert.throws(()=>normalizeSapFeed(feed(host),source('careers.sap.com'),'fixture'),/official stable job ID/);
 assert.throws(()=>normalizeSapFeed(feed('careers.sap.com').replace('/job/','/redirect/'),source('careers.sap.com'),'fixture'),/official stable job ID/);
});
