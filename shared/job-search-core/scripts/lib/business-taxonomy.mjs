import fs from 'node:fs';

export const BUSINESS_TAXONOMY = JSON.parse(fs.readFileSync(new URL('../../data/business-taxonomy.json', import.meta.url), 'utf8'));
const terms = new Map(BUSINESS_TAXONOMY.terms.map(t => [t.label, t]));
const aliases = new Map();
for (const term of terms.values()) for (const alias of [term.label, ...(term.aliases || [])]) {
  if (aliases.has(alias) && aliases.get(alias) !== term.label) throw Error('业务词表别名冲突：' + alias);
  aliases.set(alias, term.label);
}
export const businessVocabulary = () => new Set(terms.keys());
export function canonicalBusiness(value) { return aliases.get(String(value).trim()) || null; }
export function normalizeBusinessFilters(value) {
  if (value == null) return [];
  const items = typeof value === 'string' ? value.split(/[,，、]/) : value;
  if (!Array.isArray(items) || items.some(x => typeof x !== 'string' || !x.trim())) throw Error('业务筛选需要非空字符串数组');
  return [...new Set(items.map(x => {
    const label = canonicalBusiness(x);
    if (!label || label === '待核实') throw Error('未识别或不可筛选的业务标签：' + x);
    return label;
  }))];
}
export function businessMatchMode(value = 'any') {
  if (!['any', 'all'].includes(value)) throw Error('业务匹配方式只接受 any/all');
  return value;
}
export function businessMatches(actual, wanted = [], mode = 'any') {
  businessMatchMode(mode);
  if (!wanted.length) return true;
  const available = new Set();
  for (const raw of actual || []) {
    const label = canonicalBusiness(raw);
    if (label) { available.add(label); for (const parent of terms.get(label).parents || []) available.add(parent); }
  }
  return mode === 'all' ? wanted.every(t => available.has(t)) : wanted.some(t => available.has(t));
}
