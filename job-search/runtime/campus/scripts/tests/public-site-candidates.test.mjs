import './context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mokaSiteCandidates,confirmMokaSiteCandidate} from '../lib/public-site-candidates.mjs';
// Offline fixtures. The first preserves the field shape observed in 58's saved
// public bootstrap; passing tests are not live API-verification evidence.
const menu={type:'site',siteId:150952,siteType:'social',siteName:'社会招聘',siteVersion:2,link:''};
const options={entryUrl:'https://campus.58.com/campus-recruitment/58/150953#/jobs',orgId:'58',mode:'social',evidenceFile:'saved-bootstrap.txt'};
const config={org:{id:'58',siteId:150953,type:'camp',webSettings:{nav:{menus:[menu]}}},siteId:'150953',mode:'campus'};
test('discovers explicit Moka site tuple without deriving IDs',()=>{
 const {routes}=mokaSiteCandidates(config,options);assert.equal(routes.length,1);
 assert.equal(routes[0].entry,'https://campus.58.com/social-recruitment/58/150952');
 assert.equal(routes[0].config_path,'config.org.webSettings.nav.menus.0');
 assert.equal(routes[0].requires_bootstrap_identity_check,true);assert.equal(routes[0].evidence_file,'saved-bootstrap.txt');
 assert.equal(mokaSiteCandidates({org:{id:'58',siteId:150953,type:'camp'}},options).routes.length,0);
});
test('parses nested JSON settings and deduplicates desktop/mobile candidates',()=>{
 const c=structuredClone(config);c.org.mobileSettings=JSON.stringify({nav:{menus:[menu]}});
 assert.equal(mokaSiteCandidates(c,options).routes.length,1);delete c.org.webSettings;
 const [r]=mokaSiteCandidates(c,options).routes;assert.match(r.config_path,/mobileSettings:json/);assert.equal(r.siteId,'150952');
});
test('supports explicitly supplied relative URLs without changing tenant or inventing paths',()=>{
 const c={org:{id:'58',links:['/social-recruitment/58/150952#/jobs','//campus.58.com/social-recruitment/58/150952','https://app.mokahr.com/social-recruitment/OTHER/123','/jobs','javascript:alert(1)']}};
 assert.deepEqual(mokaSiteCandidates(c,options).routes.map(x=>x.siteId),['150952']);
});
test('rejects outer and nested tenant conflicts and unknown site types/versions',()=>{
 assert.equal(mokaSiteCandidates(config,{...options,orgId:'other'}).routes.length,0);
 for(const overrides of [{orgId:'other'},{siteType:'unknown'},{siteVersion:99}])assert.equal(mokaSiteCandidates({org:{id:'58',menu:{...menu,...overrides}}},options).routes.length,0);
});
test('requires candidate public bootstrap to confirm tenant, site ID and social identity',()=>{
 const [route]=mokaSiteCandidates(config,options).routes,good={org:{id:'58',siteId:150952,type:'social'},siteId:'150952',mode:'social'};
 assert.equal(confirmMokaSiteCandidate(route,good).accepted,true);
 for(const bad of [null,{...good,org:{...good.org,id:'other'}},{...good,siteId:'150953'},{...good,mode:'campus'},{org:{id:'58'}}])assert.equal(confirmMokaSiteCandidate(route,bad).accepted,false);
});
