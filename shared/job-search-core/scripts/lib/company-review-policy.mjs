// Maintenance decisions only. Products continue to read published status/origin.
import {createHash} from 'node:crypto';

export const REVIEW_POLICY_VERSION = '2026-09-26-evidence-v1';
export const SCORE_LEVELS = Object.freeze({I:[0,10,20,25],D:[0,15,25,30],A:[0,5,15,20],T:[0,5,10,15],C:[0,5,10]});
export const FIELD_RULES = Object.freeze({
  'tags.industry':{risk:'general',requirement:'同主体经营事实，按现有19类归纳；岗位职能不证明公司行业'},
  'tags.business':{risk:'general',requirement:'每个标签都有产品/服务正文支持，使用现有业务词表'},
  'tags.ownership':{risk:'strict',requirement:'核对控制关系及现有供应商优先级；不以注册地或上市地推断性质'},
  'tags.headquarters_country':{risk:'strict',requirement:'明确目标主体的总部国家；注册地址和地区办公室不能自动当作总部'},
  'tags.listing_status':{risk:'strict',requirement:'目标法人及适用时点的证券状态；历史IPO和未搜到都不足以判定当前状态'},
  'descriptions.business_summary':{risk:'general',requirement:'所有实质主张均有支持，限定集团/法人/品牌范围'},
  'descriptions.products_services':{risk:'general',requirement:'每项产品服务有支持，不把客户业务当作本公司产品'},
  'descriptions.customers':{risk:'general',requirement:'有明确客户关系依据，合作方、供应商和客户分别处理'},
  'descriptions.business_regions':{risk:'general',requirement:'业务覆盖地区有依据；办公地址和招聘地点不替代业务范围'},
  'descriptions.workforce':{risk:'strict',requirement:'员工数、单位、统计日期及主体范围齐备；规模派生另查适用性'},
  'descriptions.capital':{risk:'strict',requirement:'融资/上市/注册资本分别表述；金额需币种、日期、主体，禁止混用'},
  'descriptions.entity_relationships':{risk:'strict',requirement:'明确母子公司或控制关系及适用时间；同品牌不证明法律关系'},
});
export const REVIEW_GATES = Object.freeze(['identity','entailment','scope','temporal','conflicts','body','vocabulary']);
export const GAP_ACTIONS = Object.freeze({
  classification_ambiguity:'local_analysis', wording_difference:'local_analysis', unit_or_period_difference:'local_analysis',
  insufficient_reasoning:'local_analysis', policy_undefined:'policy_blocked',
  missing_body:'open_known_url', missing_fact:'search', identity_gap:'search', missing_as_of:'search',
  stale_evidence:'search', material_conflict:'search',
  authentication:'execution_blocked', rate_limited:'execution_blocked', publication_conflict:'publication_blocked',
});
const text=x=>typeof x==='string'&&x.trim().length>0;
export function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
  return value;
}
export const reviewHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function fieldRisk(field,assessment={}) {
  if(!FIELD_RULES[field])throw Error('Unknown review field: '+field);
  return FIELD_RULES[field].risk==='strict'||assessment?.sensitive_claims===true?'strict':'general';
}

// Grades and semantic checks are supplied by the reviewing Agent with citations.
// A numeric result is not a calibrated probability of correctness.
export function scoreAssessment(field,assessment,{decision,documentIds=[]}={}) {
  const errors=[],risk=fieldRisk(field,assessment),threshold=risk==='strict'?90:85;
  if(decision&&decision.status!=='verified')errors.push('not_verified_candidate');
  if(assessment?.policy_version!==REVIEW_POLICY_VERSION)errors.push('policy_version');
  if(!text(assessment?.reviewer)||!Number.isFinite(Date.parse(assessment?.reviewed_at)))errors.push('reviewer_or_time');
  if(typeof assessment?.sensitive_claims!=='boolean')errors.push('sensitive_claims_required');
  const docs=new Set(documentIds),scores={};
  for(const [key,levels]of Object.entries(SCORE_LEVELS)) {
    const grade=assessment?.dimensions?.[key];scores[key]=grade?.score;
    if(!levels.includes(grade?.score)||!text(grade?.reason)||!Array.isArray(grade?.document_ids)||!grade.document_ids.length||grade.document_ids.some(id=>!docs.has(id)))errors.push('dimension_'+key);
  }
  for(const key of REVIEW_GATES) {
    const check=assessment?.checks?.[key];
    if(check?.pass!==true||!text(check?.reason))errors.push('gate_'+key);
  }
  if(!Array.isArray(assessment?.claims)||!assessment.claims.length)errors.push('claims_required');
  for(const claim of Array.isArray(assessment?.claims)?assessment.claims:[]) {
    if(!text(claim.text)||claim.supported!==true||!Array.isArray(claim.document_ids)||!claim.document_ids.length||claim.document_ids.some(id=>!docs.has(id)))errors.push('unsupported_claim');
  }
  if(decision&&assessment?.decision_hash!==reviewHash(decision))errors.push('decision_changed');
  if(decision?.status==='verified'&&field==='descriptions.workforce'&&!text(decision.as_of))errors.push('workforce_as_of_required');
  if(field==='descriptions.workforce'&&typeof assessment?.size_eligible!=='boolean')errors.push('size_eligibility_required');
  const minima=risk==='strict'?{I:25,D:30,A:15,T:10,C:10}:{I:20,D:25,A:15,T:10,C:10};
  for(const [key,min]of Object.entries(minima))if(!(scores[key]>=min))errors.push('minimum_'+key);
  const total=Object.values(scores).every(Number.isFinite)?Object.values(scores).reduce((a,b)=>a+b,0):null;
  if(total===null||total<threshold)errors.push('below_threshold');
  return {policy_version:REVIEW_POLICY_VERSION,risk,threshold,total,eligible:errors.length===0,errors:[...new Set(errors)],score_kind:'evidence_rubric_not_probability'};
}

export function routeGap(gap,{rounds=0,maxRounds=2}={}) {
  if(!Number.isInteger(rounds)||rounds<0||!Number.isInteger(maxRounds)||maxRounds<1)throw Error('Invalid evidence round budget');
  const action=GAP_ACTIONS[gap?.reason];
  if(!action)throw Error('Unknown gap reason');
  if(!text(gap.explanation))throw Error('Gap requires a concrete explanation');
  if(!['search','open_known_url'].includes(action))return {action,network_required:false,reason:gap.reason};
  if(!text(gap.missing_fact)||!text(gap.acceptance)||!text(gap.stop_condition)||!Array.isArray(gap.checked_evidence_ids))throw Error('Network task requires missing fact, acceptance, checked evidence and stop condition');
  if(gap.reason==='material_conflict'&&!text(gap.local_conflict_analysis))throw Error('Analyze the conflict locally before search');
  if(rounds>=maxRounds)return {action:'research_blocked',network_required:false,reason:'round_budget_exhausted',gap};
  const url=gap.known_url;
  if(url){let u;try{u=new URL(url);}catch{throw Error('Invalid evidence URL');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Invalid evidence URL');}
  if(action==='open_known_url'&&!url)throw Error('Missing body with no known URL requires source discovery first');
  return {action:url?'open_known_url':'search',network_required:true,reason:gap.reason,missing_fact:gap.missing_fact,
    acceptance:gap.acceptance,stop_condition:gap.stop_condition,known_url:url||null,round:rounds+1};
}

export function fieldStage(decision,{published=false,assessment,documentIds=[],gap,rounds=0}={}) {
  if(published)return 'published';
  if(gap)return routeGap(gap,{rounds}).action;
  if(!decision)return 'untouched';
  if(decision.status==='unresolved')return decision.investigation?.completed===true&&text(decision.investigation.reason)&&
    decision.investigation.evidence_ids?.length>0&&text(decision.investigation.resume_when)?'reviewed_unresolved':'research_pending';
  if(!assessment)return 'awaiting_review';
  return scoreAssessment(assessment.field,assessment,{decision,documentIds}).eligible?'approved':'needs_revision';
}
