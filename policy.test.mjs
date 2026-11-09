import test from 'node:test';
import assert from 'node:assert/strict';
import { Manager, ciState } from './native-policy.mjs';

const repo = { name:'owner/repo',renovateLogin:'renovate[bot]',mergeMethod:'merge' };
const config = {appSlug:'manager',repositories:[repo]};
const pr = {number:1,title:'Update dependency',state:'open',draft:false,user:{login:'renovate[bot]'},head:{sha:'abc',ref:'renovate/pkg',repo:{full_name:repo.name}},html_url:'https://github.com/owner/repo/pull/1',mergeable:true,mergeable_state:'clean'};
const check = (id,conclusion,status='completed') => ({id,name:'test',app:{id:1,slug:'github-actions'},status,conclusion});
function setup(overrides={}) {
  const writes=[], notices=[], reviews=[];
  const gh={
    call:async(r,path,method,body)=>{if(method){writes.push({path,method,body});if(path==='/pulls/1/reviews'){const review={id:123,state:'APPROVED',commit_id:body.commit_id,user:{login:'manager[bot]'}};reviews.push(review);return review;}return {merged:true,sha:'merged'};}if(path==='/pulls/1')return structuredClone(pr);if(path.startsWith('/pulls?state=closed'))return [];throw new Error('Unexpected '+path);},
    pages:async(r,path)=>{if(path.includes('check-runs'))return [check(1,'success')];if(path.endsWith('/statuses'))return [];if(path.endsWith('/reviews'))return structuredClone(reviews);if(path.startsWith('/pulls?'))return [pr];if(path.startsWith('/actions/runs'))return [];throw new Error('Unexpected '+path);},
    ...overrides,
  };
  const manager = new Manager({config,github:gh,state:{repositories:{}},save:()=>{},notify:async text=>notices.push(text)});
  return {manager,writes,notices,gh};
}
test('CI never treats absent checks, pending checks, or failed statuses as green',()=>{
  assert.equal(ciState([],[]).state,'pending');
  assert.equal(ciState([check(1,null,'in_progress')],[]).state,'pending');
  assert.equal(ciState([check(1,'success')],[{context:'external',state:'failure'}]).state,'red');
});
test('newest check attempt supersedes its older failure',()=>{
  assert.equal(ciState([check(1,'failure'),check(2,'success')],[]).state,'green');
});
test('dry monitor proposes approval without writes',async()=>{
  const {manager,writes,notices}=setup();
  const result=await manager.run('monitor',repo.name,true);
  assert.equal(result.result[0].action,'would-approve');assert.equal(writes.length,0);assert.equal(notices.length,0);
});
test('approval pins the exact checked commit',async()=>{
  const {manager,writes}=setup();await manager.run('monitor',repo.name,false);
  assert.equal(writes.length,1);assert.equal(writes[0].body.commit_id,'abc');assert.equal(writes[0].body.event,'APPROVE');
});
test('pending or mismatched review responses never count as approvals or notify',async()=>{
  for(const response of [{id:1,state:'PENDING',commit_id:'abc',user:{login:'manager[bot]'}},{id:1,state:'APPROVED',commit_id:'old',user:{login:'manager[bot]'}}]){
    const env=setup();const base=env.gh.call;
    env.gh.call=async(r,path,method,body)=>method==='POST'?response:base(r,path,method,body);
    env.manager.prRecord(repo,pr).approved=true;
    const result=await env.manager.run('monitor',repo.name,false);
    assert.equal(result.result[0].action,'error');assert.equal(env.manager.prRecord(repo,pr).approved,false);assert.equal(env.notices.length,0);
  }
});
test('confirmed approval notifies once per PR across repeat runs',async()=>{
  const env=setup();
  assert.equal((await env.manager.run('monitor',repo.name,false)).result[0].action,'approved');
  assert.equal((await env.manager.run('monitor',repo.name,false)).result[0].action,'already-approved');
  assert.equal(env.writes.length,1);assert.equal(env.notices.length,1);assert.match(env.notices[0],/Approved owner\/repo #1/);
});
test('a rebased PR is approved for its current commit without another approval notification',async()=>{
  for(const legacyId of ['approved:1:old-sha','approved:1']){
    const env=setup();env.manager.record(repo).outbox.push({id:legacyId,content:'Earlier approval',delivered:true});
    const result=await env.manager.run('monitor',repo.name,false);
    assert.equal(result.result[0].action,'approved');assert.equal(env.writes[0].body.commit_id,'abc');
    assert.equal(env.manager.prRecord(repo,pr).approved,true);assert.equal(env.notices.length,0);
  }
});
test('rebases do not add another notification while the first approval notification is pending',async()=>{
  const env=setup();env.manager.record(repo).outbox.push({id:'approved:1:old-sha',content:'Earlier approval',delivered:false});
  await env.manager.run('monitor',repo.name,false);
  assert.deepEqual(env.notices,['Earlier approval']);assert.equal(env.writes.length,1);
});
test('existing pending app review is submitted and read back before notification',async()=>{
  const env=setup();const baseCall=env.gh.call,basePages=env.gh.pages;let submitted=false;
  const review={id:456,state:'APPROVED',commit_id:'abc',user:{login:'manager[bot]'}};
  env.gh.pages=async(r,path)=>path.endsWith('/reviews')?[{...review,state:submitted?'APPROVED':'PENDING'}]:basePages(r,path);
  env.gh.call=async(r,path,method,body)=>{if(method==='POST'){assert.equal(path,'/pulls/1/reviews/456/events');assert.equal(body.event,'APPROVE');submitted=true;return review;}return baseCall(r,path,method,body);};
  assert.equal((await env.manager.run('monitor',repo.name,false)).result[0].action,'approved');assert.equal(env.notices.length,1);
});
test('approval read-back mismatch is an error without notification',async()=>{
  const env=setup();const base=env.gh.pages;
  env.gh.pages=async(r,path)=>path.endsWith('/reviews')?[]:base(r,path);
  assert.equal((await env.manager.run('monitor',repo.name,false)).result[0].action,'error');assert.equal(env.notices.length,0);assert.equal(env.manager.prRecord(repo,pr).approved,false);
});
test('approval Discord delivery failure retries without another approval',async()=>{
  const env=setup();env.manager.notify=async()=>{throw new Error('Discord offline');};
  await assert.rejects(env.manager.run('monitor',repo.name,false),/offline/);
  assert.equal(env.manager.record(repo).outbox[0].delivered,false);
  env.manager.notify=async text=>env.notices.push(text);
  await env.manager.run('monitor',repo.name,false);
  assert.equal(env.writes.length,1);assert.equal(env.notices.length,1);assert.equal(env.manager.record(repo).outbox[0].delivered,true);
});
test('failed job is requested once; a failed next attempt emits one notification',async()=>{
  let attempt=1;
  const env=setup();const base=env.gh.pages;
  env.gh.pages=async(r,path)=>path.includes('check-runs')?[check(1,'failure')]:path.startsWith('/actions/runs')?[{id:42,workflow_id:5,event:'pull_request',head_sha:'abc',head_branch:'renovate/pkg',status:'completed',conclusion:'failure',run_attempt:attempt,name:'Test',html_url:'https://github.com/run/42'}]:base(r,path);
  await env.manager.run('monitor',repo.name,false);await env.manager.run('monitor',repo.name,false);
  assert.equal(env.writes.length,1);assert.match(env.writes[0].path,/rerun-failed-jobs/);
  attempt=2;await env.manager.run('monitor',repo.name,false);await env.manager.run('monitor',repo.name,false);
  assert.equal(env.writes.length,1);assert.equal(env.notices.length,1);assert.match(env.notices[0],/failed again/);
});
test('merge refuses a green PR with no current app approval',async()=>{
  const {manager,writes}=setup();const result=await manager.run('merge',repo.name,false);
  assert.equal(result.result.action,'no-eligible-pr');assert.equal(writes.length,0);
});
test('old-commit approval does not permit a merge',async()=>{
  const {manager,writes,gh}=setup();const base=gh.pages;
  gh.pages=async(r,path)=>path.endsWith('/reviews')?[{user:{login:'manager[bot]'},state:'APPROVED',commit_id:'old'}]:base(r,path);
  assert.equal((await manager.run('merge',repo.name,false)).result.action,'no-eligible-pr');assert.equal(writes.length,0);
});
test('recent merge metadata does not block an eligible PR or cause a history scan',async()=>{
  const {manager,writes,gh}=setup();const baseCall=gh.call,basePages=gh.pages;
  manager.record(repo).lastMerge=new Date().toISOString();
  gh.call=async(r,path,...rest)=>{if(path.startsWith('/pulls?state=closed'))throw new Error('Unexpected history scan');return baseCall(r,path,...rest);};
  gh.pages=async(r,path)=>path.endsWith('/reviews')?[{user:{login:'manager[bot]'},state:'APPROVED',commit_id:'abc'}]:basePages(r,path);
  assert.equal((await manager.run('merge',repo.name,true)).result.action,'would-merge');assert.equal(writes.length,0);
});
test('each invocation merges at most one PR and a separate invocation is not time-gated',async()=>{
  const env=setup();const basePages=env.gh.pages;const merged=new Set();
  const prs=[1,2].map(number=>({...structuredClone(pr),number,head:{...structuredClone(pr.head),ref:'renovate/pkg-'+number}}));
  env.gh.pages=async(r,path)=>{
    if(path.startsWith('/pulls?'))return prs.filter(p=>!merged.has(p.number));
    if(path.endsWith('/reviews'))return [{user:{login:'manager[bot]'},state:'APPROVED',commit_id:'abc'}];
    return basePages(r,path);
  };
  env.gh.call=async(r,path,method,body)=>{
    const number=Number(path.match(/^\/pulls\/(\d+)/)?.[1]);
    if(method==='PUT'){env.writes.push({path,method,body});merged.add(number);return {merged:true,sha:'merged-'+number};}
    if(method==='DELETE'){env.writes.push({path,method});return {};}
    if(path==='')return {default_branch:'main'};
    if(path.startsWith('/git/ref/heads/'))return {object:{sha:'abc'}};
    if(number)return {...prs.find(p=>p.number===number),merged:merged.has(number),merged_at:merged.has(number)?new Date().toISOString():null};
    throw new Error('Unexpected '+path);
  };
  assert.equal((await env.manager.run('merge',repo.name,false)).result.number,1);
  assert.equal(env.writes.filter(w=>w.method==='PUT').length,1);
  assert.equal((await env.manager.run('merge',repo.name,false)).result.number,2);
  assert.equal(env.writes.filter(w=>w.method==='PUT').length,2);
});
test('repo lock prevents concurrent workers and releases after completion',async()=>{
  const {manager,gh}=setup();let release;const base=gh.pages;
  gh.pages=async(...args)=>{await new Promise(r=>release=r);return base(...args);};
  const first=manager.run('merge',repo.name,true);
  await new Promise(r=>setTimeout(r,5));
  assert.equal((await manager.run('merge',repo.name,true)).action,'busy');
  gh.pages=base;release();await first;assert.equal(manager.locks.size,0);
});
test('failed Discord delivery stays queued for next poll',async()=>{
  const {manager}=setup();manager.notify=async()=>{throw new Error('Discord offline');};
  manager.event(repo,'merge:1','Merged');await assert.rejects(manager.flush(repo),/offline/);
  assert.equal(manager.record(repo).outbox[0].delivered,false);
});
test('dismissed app approval cannot authorize a merge',async()=>{
  const {manager,writes,gh}=setup();const base=gh.pages;
  gh.pages=async(r,path)=>path.endsWith('/reviews')?[
    {user:{login:'manager[bot]'},state:'APPROVED',commit_id:'abc'},
    {user:{login:'manager[bot]'},state:'DISMISSED',commit_id:'abc'},
  ]:base(r,path);
  assert.equal((await manager.run('merge',repo.name,false)).result.action,'no-eligible-pr');assert.equal(writes.length,0);
});
test('new head commit before approval causes no mutation',async()=>{
  const {manager,writes,gh}=setup();const base=gh.call;let reads=0;
  gh.call=async(r,path,...rest)=>path==='/pulls/1'&&++reads>1?{...pr,head:{...pr.head,sha:'changed'}}:base(r,path,...rest);
  assert.equal((await manager.run('monitor',repo.name,false)).result[0].action,'commit-changed');assert.equal(writes.length,0);
});
test('merge pins head SHA, deletes branch and notifies without reprocessing a closed PR',async()=>{
  const {manager,writes,gh,notices}=setup();const baseCall=gh.call,basePages=gh.pages;let merged=false;
  gh.call=async(r,path,method,body)=>{
    if(path==='/pulls/1/merge'&&method==='PUT'){merged=true;return baseCall(r,path,method,body);}
    if(path==='/pulls/1'&&merged)return {...structuredClone(pr),merged:true,merged_at:new Date().toISOString()};
    if(path==='')return {default_branch:'main'};
    if(path.startsWith('/git/ref/heads/'))return {object:{sha:'abc'}};
    return baseCall(r,path,method,body);
  };
  gh.pages=async(r,path)=>path.startsWith('/pulls?')&&merged?[]:path.endsWith('/reviews')?[{user:{login:'manager[bot]'},state:'APPROVED',commit_id:'abc'}]:basePages(r,path);
  const first=await manager.run('merge',repo.name,false);
  assert.equal(first.result.action,'merged');assert.deepEqual(writes[0].body,{sha:'abc',merge_method:'merge'});
  assert.equal(writes[1].method,'DELETE');assert.equal(notices.length,1);
  assert.match(notices[0],/Schedule: :15 and :45/);
  assert.equal((await manager.run('merge',repo.name,false)).result.action,'no-eligible-pr');assert.equal(writes.length,2);
});
test('uncertain merge outcome prevents another merge',async()=>{
  const {manager,writes}=setup();manager.record(repo).pendingMerge={number:1,sha:'abc',branch:'renovate/pkg',uncertain:true};
  await assert.rejects(manager.run('merge',repo.name,false),/uncertain/);assert.equal(writes.length,0);
});
test('default branch and changed branch tips are never deleted',async()=>{
  for(const branch of ['main','renovate/pkg']){
    const {manager,writes,gh}=setup();const base=gh.call;
    manager.record(repo).pendingMerge={number:1,sha:'abc',branch,uncertain:true};
    gh.call=async(r,path,...args)=>path==='/pulls/1'?{...pr,merged:true,merged_at:new Date().toISOString()}:path===''?{default_branch:'main'}:path.startsWith('/git/ref/heads/')?{object:{sha:'new-tip'}}:base(r,path,...args);
    await manager.cleanup(repo);assert.equal(writes.length,0);
  }
});
