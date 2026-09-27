import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PACK_ROOT} from '../../runtime-context.mjs';

export const bytesHash=b=>createHash('sha256').update(b).digest('hex');
const inside=(root,file)=>{const rel=path.relative(root,file);return rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};

// Checks the archive chain, not semantic truth. The Agent still owns identity and entailment.
export async function verifyReviewEvidence(review,{root=PACK_ROOT,readLedger=true}={}) {
  const allowed=await Promise.all(['datasets','job-search/artifacts'].map(async p=>fs.realpath(path.join(root,p)).catch(()=>path.join(root,p))));
  const records=[],seen=new Map();let db,state;
  try {
    for(const doc of review.documents||[]) {
      const file=await fs.realpath(path.resolve(root,doc.raw_archive));
      if(!allowed.some(p=>inside(p,file)))throw Error('Evidence outside maintenance archives');
      let entry=seen.get(file);
      if(!entry){const bytes=await fs.readFile(file);let raw;try{raw=JSON.parse(bytes);}catch{throw Error('Evidence capture must be an archived JSON response');}entry={raw,sha256:bytesHash(bytes)};seen.set(file,entry);}
      if(entry.sha256!==doc.raw_sha256||bytesHash(doc.content)!==doc.sha256)throw Error('Evidence hash changed: '+doc.id);
      const rawText=typeof entry.raw==='string'?entry.raw:JSON.stringify(entry.raw);
      // JSON.stringify escapes text, so use exact decoded string members as well.
      const strings=[];const scan=x=>{if(typeof x==='string')strings.push(x);else if(x&&typeof x==='object')Object.values(x).forEach(scan);};scan(entry.raw);
      if(!strings.some(s=>s.includes(doc.content))||!rawText.includes(doc.url))throw Error('Body or URL not present in original archive: '+doc.id);
      const builtin=file.includes(path.join('web-search','builtin')+path.sep);
      if(builtin) {
        if(typeof entry.raw!=='string'||!/Source:\s*(?:open|find|click)\(/.test(doc.content))throw Error('Search material is not a page-body capture');
        // A batched response can contain unrelated URLs. Bind the document URL
        // to this body's tool header, not merely to any URL in the raw batch.
        const sourceAt=doc.content.indexOf('Source:'),lineEnd=doc.content.indexOf('\n',sourceAt);
        const header=doc.content.slice(0,lineEnd<0?doc.content.length:lineEnd);
        if(!header.includes('('+doc.url+')')&&!header.includes(JSON.stringify(doc.url)))throw Error('Document URL does not match its page-body capture: '+doc.id);
        if(readLedger) {
          if(!db){const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(path.join(root,'datasets/web-search/state/ledger.sqlite'),{readOnly:true});state=JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json);}
          const id=path.basename(file,'.json'),runId=path.basename(path.dirname(path.dirname(file))),run=state.builtin_runs?.[runId],reservation=run?.reservations.find(r=>r.id===id);
          const archive=db.prepare('SELECT raw,sha256 FROM builtin_archives WHERE id=?').get(id);
          if(!reservation||reservation.status!=='success'||reservation.sha256!==entry.sha256||!archive||bytesHash(archive.raw)!==entry.sha256||archive.sha256!==entry.sha256)throw Error('Unlinked or unsuccessful evidence request: '+id);
          if(!reservation.task_ids.includes(review.company_id))throw Error('Archive request belongs to other company tasks; investigate identity linkage: '+id);
          if(![reservation.reserved_at,reservation.finished_at].includes(doc.fetched_at))throw Error('Original capture time changed: '+id);
        }
      } else {
        // Support explicit non-generative URL fetch payloads already kept by API adapters.
        const bodies=(entry.raw.fetch_url_results||[]).flatMap(r=>r.contents||[]);
        if(!bodies.some(b=>b.url===doc.url&&(b.content===doc.content||b.text===doc.content)))throw Error('Archive does not prove a direct page fetch');
        if(entry.raw.company_id!==review.company_id)throw Error('Capture company mismatch');
        if(![entry.raw.checked_at,entry.raw.fetched_at,entry.raw.finished_at].filter(Boolean).includes(doc.fetched_at))throw Error('Original API capture time is not proven');
      }
      records.push({document_id:doc.id,file,sha256:entry.sha256,body_sha256:doc.sha256,fetched_at:doc.fetched_at});
    }
  } finally {db?.close();}
  return records;
}
