import path from 'node:path';
import fs from 'node:fs/promises';
import {CORE_ROOT} from './runtime-context.mjs';
import {readConsistentPublic} from './scripts/lib/public-snapshot.mjs';

export const SOURCE_REGISTRY_FILE = path.join(CORE_ROOT, 'assets/sources.json');
export const CUSTOM_PROVIDERS_FILE = path.join(CORE_ROOT, 'assets/custom-providers.json');
export const COMPANY_BUSINESS_FILE = path.join(CORE_ROOT, 'data/company-business-tags.json');
export const COMPANY_OWNERSHIP_FILE = path.join(CORE_ROOT, 'data/company-ownership-tags.json');
export const COMPANY_PROFILES_FILE = path.join(CORE_ROOT, 'data/company-profiles.json');
export const COMPANY_SIZE_FILE = path.join(CORE_ROOT, 'data/company-size-tags.json');
export const SEARCH_CAPABILITIES_FILE = path.join(CORE_ROOT, 'data/source-search-capabilities.json');
const common = new Map([
  ['assets/sources.json',SOURCE_REGISTRY_FILE], ['assets/custom-providers.json',CUSTOM_PROVIDERS_FILE],
  ['data/company-business-tags.json',COMPANY_BUSINESS_FILE], ['data/company-ownership-tags.json',COMPANY_OWNERSHIP_FILE], ['data/company-profiles.json',COMPANY_PROFILES_FILE],
]);

// Maintenance scripts can use this for mixed datasets; city/evidence/run files
// always stay in the caller's skill. Historical snapshots are never redirected.
export function datasetPath(skillRoot, relative) {
  return common.get(relative.replaceAll('\\','/')) || path.join(skillRoot, relative);
}
export async function readSourceRegistry() {
 return readConsistentPublic(async()=>{
  const data = JSON.parse(await fs.readFile(SOURCE_REGISTRY_FILE, 'utf8'));
  if (!Array.isArray(data.companies)) throw Error('共享来源库缺少 companies 数组');
  return data;
 });
}
