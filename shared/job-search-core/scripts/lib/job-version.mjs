import {createHash} from 'node:crypto';
const provenanceKeys=new Set(['raw_file','list_file','response_file','decoded_response_file','evidence_file','response_sha256','checked_at']);
function semanticEvidence(value){return Array.isArray(value)?value.map(semanticEvidence):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).filter(k=>!provenanceKeys.has(k)).sort().map(k=>[k,semanticEvidence(value[k])])):value;}
function fingerprint(job,legacy=false){return createHash('sha256').update(JSON.stringify({job_id:String(job.job_id),title:job.title,description:job.description||'',requirements:job.requirements||'',locations:job.locations_raw||[],formal_status:job.formal_status,open_status:job.open_status,recruitment_evidence:legacy?job.recruitment_evidence||{}:semanticEvidence(job.recruitment_evidence||{})})).digest('hex');}
export const jobFingerprint=job=>job.body_review?.version>=2?createHash('sha256').update(JSON.stringify([fingerprint(job),job.body_review.version,job.body_content_fingerprint,job.body_complete,job.body_fetch?.status])).digest('hex'):fingerprint(job);
// Existing unchanged runs retain their previous reviews. New reviews use semantic fingerprints.
export function jobFingerprintMatches(saved,job){return saved===jobFingerprint(job)||!job.body_review?.version&&saved===fingerprint(job,true);}
export function safeJobId(id) {const value=String(id);return /^[A-Za-z0-9_-]+$/.test(value)?value:createHash('sha256').update(value).digest('hex').slice(0,20);}
