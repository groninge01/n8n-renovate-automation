import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const runEngine=new AsyncFunction('$input',readFileSync(new URL('./native-engine.js',import.meta.url),'utf8'));
const repository='owner/repo';
const pr={number:1,title:'Dependency update',state:'open',draft:false,user:{login:'renovate[bot]'},head:{sha:'abc',ref:'renovate/pkg',repo:{full_name:repository}},html_url:'https://github.com/owner/repo/pull/1'};
const args={repository,mode:'monitor',dryRun:false,appSlug:'manager',renovateLogin:'renovate[bot]'};
async function drive(initialState,attempt){
  let env={args,initialState,log:[]};const requests=[];
  for(let step=0;step<50;step++){
    env=(await runEngine({first:()=>({json:env})}))[0].json;
    if(env.fatal)throw new Error(env.fatal);
    if(env.effect.kind==='done')return{env,requests};
    const e=env.effect;requests.push(e);let body;
    if(e.kind==='discord')body={delivered:true};
    else if(e.method==='POST'&&e.path.endsWith('/rerun-failed-jobs')){
      assert.equal(env.state.repositories[repository].prs['1:abc'].retries['42'].initialAttempt,1,'intent must be in the checkpoint before the retry request');body={};
    }
    else if(e.path.includes('/pulls?'))body=[pr];
    else if(e.path.endsWith('/pulls/1'))body=pr;
    else if(e.path.includes('/check-runs?'))body={check_runs:[{id:1,name:'Test',app:{id:1,slug:'github-actions'},status:'completed',conclusion:'failure'}]};
    else if(e.path.includes('/statuses?'))body=[];
    else if(e.path.includes('/actions/runs?'))body={workflow_runs:[{id:42,workflow_id:5,event:'pull_request',head_sha:'abc',head_branch:'renovate/pkg',status:'completed',conclusion:'failure',run_attempt:attempt,name:'Test',html_url:'https://github.com/run/42'}]};
    else throw new Error('Unexpected effect '+JSON.stringify(e));
    env.log.push({effect:e,response:{statusCode:200,body}});
  }
  throw new Error('Engine did not finish');
}
test('native replay engine checkpoints retry intent and performs exactly one retry',async()=>{
  const first=await drive({repositories:{}},1);
  assert.equal(first.requests.filter(e=>e.method==='POST').length,1);
  assert.equal(first.requests.filter(e=>e.kind==='discord').length,0);
  const repeated=await drive(first.env.state,1);
  assert.equal(repeated.requests.filter(e=>e.method==='POST').length,0);
  const failedAgain=await drive(repeated.env.state,2);
  assert.equal(failedAgain.requests.filter(e=>e.kind==='discord').length,1);
  assert.equal(failedAgain.requests.filter(e=>e.method==='POST').length,0);
  const duplicate=await drive(failedAgain.env.state,2);
  assert.equal(duplicate.requests.filter(e=>e.kind==='discord').length,0);
});
test('approval replay recovers pending review, confirms it, and sends one notification',async()=>{
  let initialState={repositories:{}};
  let approved=false;
  const review={id:123,state:'PENDING',commit_id:'abc',user:{login:'manager[bot]'}};
  for(let run=0;run<2;run++){
    let env={args,initialState,log:[]};let notifications=0,writes=0;
    for(let step=0;step<40;step++){
      env=(await runEngine({first:()=>({json:env})}))[0].json;
      assert.equal(env.fatal,undefined);
      if(env.effect.kind==='done')break;
      const e=env.effect;let body;
      if(e.kind==='discord'){notifications++;assert.match(e.content,/Approved owner\/repo #1/);body={delivered:true};}
      else if(e.method==='POST'){
        writes++;assert.match(e.path,/\/reviews\/123\/events$/);assert.equal(e.body.event,'APPROVE');
        assert.equal(env.state.repositories[repository].prs['1:abc'].approved,false);
        approved=true;review.state='APPROVED';body={...review};
      }else if(e.path.includes('/pulls?'))body=[pr];
      else if(e.path.endsWith('/pulls/1'))body=pr;
      else if(e.path.includes('/reviews?'))body=[{...review}];
      else if(e.path.includes('/check-runs?'))body={check_runs:[{id:1,name:'Test',app:{id:1,slug:'github-actions'},status:'completed',conclusion:'success'}]};
      else if(e.path.includes('/statuses?'))body=[];
      else throw new Error('Unexpected approval effect');
      env.log.push({effect:e,response:{statusCode:200,body:structuredClone(body)}});
    }
    assert.equal(env.effect.kind,'done');assert.equal(approved,true);
    assert.equal(notifications,run===0?1:0);assert.equal(writes,run===0?1:0);
    initialState=env.state;
  }
});
