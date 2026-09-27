import {configureRuntime} from './runtime-context.mjs';

export async function runCli(context, command = 'jobs') {
  configureRuntime(context);
  if (command === 'jobs') throw Error('求职编排由产品入口 job-search/scripts/jobs.mjs 管理');
  if (command === 'company-profiles') return import('./scripts/company-profiles.mjs');
  throw Error('未知共享入口：'+command);
}
