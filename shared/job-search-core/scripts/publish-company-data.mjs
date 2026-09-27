import fs from 'node:fs/promises';
import path from 'node:path';
import {loadCompanyInputs,buildCompanyRecords,projectCompanyRecords} from './lib/company-records.mjs';
import {publishPublicRecords} from './lib/public-company-data.mjs';
import {INTERNAL_RECORDS_FILE,ARCHIVE_FILE,assertMaintenanceInputs} from '../maintenance-paths.mjs';
import {bytesHash} from './lib/company-evidence.mjs';
import {withPublicationLock} from './lib/company-publication-transaction.mjs';
import {companyInputHashes} from './lib/company-review-publication.mjs';
await withPublicationLock(async()=>{
await assertMaintenanceInputs();
const hashes=await companyInputHashes();
try{hashes[ARCHIVE_FILE]=bytesHash(await fs.readFile(ARCHIVE_FILE));}catch(e){if(e.code!=='ENOENT')throw e;hashes[ARCHIVE_FILE]=null;}
const inputs=await loadCompanyInputs({includeResearch:true});
const records=buildCompanyRecords(inputs);
const published=await publishPublicRecords(records,projectCompanyRecords(records,inputs),{inputs:hashes,extraWrites:[{file:INTERNAL_RECORDS_FILE,bytes:JSON.stringify(records)+'\n'}],metadata:{kind:'existing_decisions'}});
console.log(JSON.stringify({companies:published.companies.length,operation:'publish_existing_decisions_without_research'}));
});
