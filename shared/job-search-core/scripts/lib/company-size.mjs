export const SIZE_MODEL={version:'2026-09-19-headcount-v1',name:'求职组织规模',large_min:5000,medium_min:500,max_age_days:730};
const number=(s,unit)=>Number(s.replaceAll(',',''))*(unit==='万'?10000:unit==='千'?1000:1);
export function workforceRange(fact){
 const text=String(fact?.value||'').normalize('NFKC');
 if(fact?.status!=='verified'||!fact.evidence?.length||/参保人数|社保人数|关注者|followers|LinkedIn成员|平台.*经纪人/.test(text))return null;
 const n='([\\d,]+(?:\\.\\d+)?)',u='(万|千)?';
 const range=text.match(new RegExp(n+'\\s*'+u+'\\s*[-—–~～至]\\s*'+n+'\\s*'+u+'\\s*(?:名|人|employees)','i'));
 if(range){const min=number(range[1],range[2]||range[4]),max=number(range[3],range[4]||range[2]);return min>0&&max>=min?{min,max,kind:'range'}:null;}
 const count=text.match(new RegExp('(?:超过|不少于|至少|约|近)?\\s*'+n+'\\s*'+u+'\\s*(?:余|多|以上|[+＋])?\\s*(?:人|名(?:全职|正式|在职)?员工|名全职员工|employees)','i'));
 if(!count)return null;const value=number(count[1],count[2]);if(!Number.isFinite(value)||value<1)return null;
 if(/超过|不少于|至少|以上|[+＋]/.test(count[0]))return {min:value,max:null,kind:'lower_bound'};
 if(/约|近|余|多/.test(count[0]))return {min:Math.floor(value*.8),max:Math.ceil(value*1.2),kind:'approximate_with_margin'};
 return {min:value,max:value,kind:'exact'};
}
export function classifyCompanySize(company,ownership,profile,{now=new Date().toISOString(),model=SIZE_MODEL}={}){
 const fact=profile?.workforce,base={company_id:company.company_id,display_name:company.display_name,model_version:model.version,checked_at:now,ownership_tag:ownership?.ownership_tag||'待核实',label:'待核实',status:'unknown',entity:fact?.entity||'',as_of:fact?.as_of||'',workforce:fact?.value||'',evidence:fact?.evidence||[],scope:/全球|集团|并表|子公司|group/i.test(fact?.entity||'')?'group_scope':'reported_entity',confidence:'unknown'};
 if(!ownership||!['verified','demo_unreviewed'].includes(ownership.status)||ownership.ownership_tag==='待核实')return {...base,reason:'公司性质尚未形成可用初值，暂不判定是否适用厂级标签'};
 if(!['私企','外企'].includes(ownership.ownership_tag))return {...base,status:'not_applicable',label:'不适用',reason:'本模型仅用于已确认的私企和外企'};
 const range=workforceRange({...fact,status:['api_supported','demo_unreviewed'].includes(fact?.status)?'verified':fact?.status});if(!range)return {...base,reason:'缺少能解析且有证据的员工规模，或该数字不是雇员人数'};
 const year=String(fact.as_of||'').match(/20\d{2}/)?.[0]||String(fact.value).match(/(20\d{2})年/)?.[1];
 const rawDate=String(fact.as_of||''),iso=rawDate.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
 const asOf=iso||year&&year+'-01-01',age=asOf?(Date.parse(now)-Date.parse(asOf))/86400000:null;
 if(age===null||!Number.isFinite(age)||age < -7)return {...base,range,reason:'缺少有效的资料时点，不能确认当前组织规模'};
 if(age!=null&&age>model.max_age_days)return {...base,range,reason:'人数资料超过两年，保留历史事实但不据此确认当前厂级'};
 if(/分公司|分支|子公司/.test(company.display_name)&&base.scope==='group_scope')return {...base,range,reason:'只有集团人数，无法据此判断具体招聘实体的规模'};
 const tier=n=>n>=model.large_min?'大厂':n>=model.medium_min?'中厂':'小厂';
 const lower=tier(range.min),upper=range.max==null?'大厂':tier(range.max);
 if(lower!==upper)return {...base,range,reason:'人数区间跨越标签阈值，不能确定具体厂级'};
 return {...base,status:'classified',label:lower,range,confidence:range.kind==='exact'&&fact.as_of?'high':'medium',reason:`按已核实人数范围判定组织规模为${lower}；${base.scope==='group_scope'?'集团口径，不代表每个子公司或团队。':'保留原披露主体口径。'}不代表行业地位、待遇或个人匹配度。`};
}
