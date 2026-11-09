import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeGithubPlan} from './native-github.mjs';
const nodes=nativeGithubPlan('credential').nodes;
const route=new Function('$input',nodes.find(n=>n.name==='Route GitHub operation').parameters.jsCode);
const normalize=new Function('$input','$',nodes.find(n=>n.name==='Normalize native GitHub response').parameters.jsCode);
const run=(path,method='GET')=>route({first:()=>({json:{args:{repository:'owner/repo'},effect:{path:'/repos/owner/repo'+path,method}}})})[0].json;
test('native GitHub routes supported reads and preserves pagination and filters',()=>{
  const context=run('/pulls?state=closed&sort=updated&direction=asc&page=2&per_page=100');
  assert.deepEqual(context.nativeGithub,{route:'pulls',number:0,page:2,state:'closed',sort:'updated',direction:'asc'});
  assert.equal(run('/pulls/42').nativeGithub.route,'pull');
  assert.equal(run('/pulls/42/reviews?page=1').nativeGithub.route,'reviews');
  assert.equal(run('').nativeGithub.route,'repository');
});
test('approval, merge, ref deletion and failed-job retry retain explicit REST requests',()=>{
  for(const [path,method] of [['/pulls/42/reviews','POST'],['/pulls/42/reviews/123/events','POST'],['/pulls/42/merge','PUT'],['/git/refs/heads/renovate/pkg','DELETE'],['/actions/runs/123/rerun-failed-jobs','POST']])assert.equal(run(path,method).nativeGithub.route,'rest');
});
test('native list results preserve paging and empty results without fabricated data',()=>{
  const context=run('/pulls?state=open&page=2');
  const values=Array.from({length:102},(_,id)=>({json:{id:id+1}}));
  assert.deepEqual(normalize({all:()=>values},()=>({last:()=>({json:context})}))[0].json.body,[{id:101},{id:102}]);
  assert.deepEqual(normalize({all:()=>[{json:{}}]},()=>({last:()=>({json:context})}))[0].json.body,[]);
});
test('native GitHub errors are forwarded as failures',()=>{
  assert.equal(normalize({all:()=>[{json:{error:'Denied'}}]},()=>({last:()=>({json:run('/pulls/42')})}))[0].json.error,true);
});
