import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {applyNativeGithub} from './native-github.mjs';
import {discordEmbedParameters} from './discord-format.mjs';

const envValue=(file,key)=>{const line=readFileSync(file,'utf8').split('\n').find(l=>l.startsWith(key+'='));if(!line)throw new Error('Missing '+key);return line.slice(key.length+1).trim().replace(/^(['"])(.*)\1$/,'$2');};
const apiKey=envValue('/secrets/api.env','N8N_API_KEY');
async function api(path,method='GET',body){const res=await fetch('http://n8n:5678/api/v1'+path,{method,headers:{'X-N8N-API-KEY':apiKey,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await res.json();if(!res.ok)throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data).slice(0,400)}`);return data;}
const out='/app/workflows';mkdirSync(out,{recursive:true});
const manifestPath='/app/native-manifest.json';
let manifest;try{manifest=JSON.parse(readFileSync(manifestPath));}catch{manifest={};}
function saveManifest(){writeFileSync(manifestPath,JSON.stringify(manifest,null,2));}
if(!manifest.githubAppCredential){const c=await api('/credentials','POST',{name:'Renovate — GitHub App',type:'githubAppApi',data:{server:'https://api.github.com',appId:'5438684',installationId:'174406233',privateKey:readFileSync('/secrets/key.pem','utf8')}});manifest.githubAppCredential=c.id;saveManifest();}
if(!manifest.discordCredential){const c=await api('/credentials','POST',{name:'Renovate — Discord notifications',type:'discordWebhookApi',data:{webhookUri:envValue('/secrets/discord.env','DISCORD_WEBHOOK_URL')}});manifest.discordCredential=c.id;saveManifest();}
if(!manifest.table){const t=await api('/data-tables','POST',{name:'Renovate automation state',columns:[{name:'repository',type:'string'},{name:'lockOwner',type:'string'},{name:'state',type:'string'}]});manifest.table=t.id;saveManifest();}
if(!manifest.summaryColumns){for(const name of ['lastResult','lastRunAt'])await api(`/data-tables/${manifest.table}/columns`,'POST',{name,type:'string'});manifest.summaryColumns=true;saveManifest();}
if(!manifest.row){const rows=await api(`/data-tables/${manifest.table}/rows`,'POST',{data:[{repository:'beethovenxfi/frontend-monorepo',lockOwner:'',state:JSON.stringify({prs:{},lastMerge:null,outbox:[]})}],returnType:'all'});manifest.row=rows[0].id;saveManifest();}
const credentials={discordWebhookApi:{id:manifest.discordCredential,name:'Renovate — Discord notifications'}};
const node=(name,type,parameters,x,y,extra={})=>({id:randomUUID(),name,type:'n8n-nodes-base.'+type,typeVersion:({code:2,httpRequest:4.2,executeWorkflow:1.3,executeWorkflowTrigger:1.1,dataTable:1.1,if:2.2,scheduleTrigger:1.2,stickyNote:1,discord:2}[type]||1),position:[x,y],parameters,...extra});
const code=(name,js,x,y)=>node(name,'code',{jsCode:js},x,y);
const trigger=()=>node('Run one repository','executeWorkflowTrigger',{inputSource:'passthrough'},0,0);
const call=(name,id,x,y,mode='once')=>node(name,'executeWorkflow',{source:'database',workflowId:{__rl:true,mode:'id',value:id},mode,options:{waitForSubWorkflow:true}},x,y);
const note=(text,x,y,width=700,height=230)=>node('Read me','stickyNote',{content:text,width,height},x,y);
const settings={executionOrder:'v1',saveDataErrorExecution:'none',saveDataSuccessExecution:'none',saveManualExecutions:false,saveExecutionProgress:false,executionTimeout:900,callerPolicy:'workflowsFromSameOwner'};
function wf(name,nodes,edges){const connections={};for(const [from,to,port=0]of edges){connections[from]||={main:[]};connections[from].main[port]||=[];connections[from].main[port].push({node:to,type:'main',index:0});}return{name,nodes,connections,settings};}
async function put(key,workflow){if(key==='worker'){applyNativeGithub(workflow,manifest.githubAppCredential);Object.assign(workflow.nodes.find(n=>n.name==='Send Discord notification').parameters,discordEmbedParameters());}if(['monitor','merge'].includes(key))workflow.settings={...workflow.settings,saveDataErrorExecution:'all'};const saved=manifest[key]?await api('/workflows/'+manifest[key],'PUT',workflow):await api('/workflows','POST',workflow);manifest[key]=saved.id;saveManifest();writeFileSync(`${out}/${key}.json`,JSON.stringify({...workflow,id:saved.id,active:false},null,2));console.log(`${key}: ${saved.id}`);return saved.id;}
const configCode=`const input=$input.first().json;\nconst repositories=[{repository:'beethovenxfi/frontend-monorepo',installationId:174406233,rowId:${manifest.row},renovateLogin:'renovate[bot]',mergeMethod:'merge'}];\nreturn repositories.map(r=>({json:{...r,appId:'5438684',appSlug:'renovate-pr-manager',tableId:'${manifest.table}',mode:input.mode||'monitor',dryRun:input.dryRun!==false}}));`;
const config=await put('configuration',wf('Repository configuration',[trigger(),code('Repositories — edit here',configCode,260,0),note('## Repository settings\nEdit the Repositories node to add repositories. Install the GitHub App on each repository, then add one state row with a blank lockOwner and initial state. Merge timing is controlled only by the :15 and :45 schedule; one PR per repository per run.\n\nParent workflows default to dryRun=true. Change to false only when ready to enable real actions.',0,-290)],[['Run one repository','Repositories — edit here']]));

// The policy is ordinary JavaScript. HTTP and state persistence are performed by native nodes.
let policy=readFileSync('/app/native-policy.mjs','utf8').replace('export { Manager, ciState };','');
const engine=`${policy}\n
const env=$input.first().json;
const state=JSON.parse(JSON.stringify(env.initialState));
let cursor=0;
class YieldEffect extends Error { constructor(effect){super('yield');this.yieldEffect=effect;} }
function effect(value){
  const previous=env.log[cursor++];
  if(!previous)throw new YieldEffect(value);
  if(JSON.stringify(previous.effect)!==JSON.stringify(value))throw new Error('Effect replay mismatch; lock retained for inspection');
  const response=previous.response;
  if(response.error || response.statusCode>=400){const e=new Error(response.safeMessage || ('API request failed: '+(response.statusCode||'network error')));e.status=response.statusCode;throw e;}
  return response.body;
}
const gh={
  call:async(repo,path,method='GET',body)=>effect({kind:'github',path:'/repos/'+repo.name+path,method,...(body===undefined?{}:{body})}),
  pages:async(repo,path,field)=>{const output=[];for(let page=1;page<=50;page++){const value=await gh.call(repo,path+(path.includes('?')?'&':'?')+'per_page=100&page='+page);const items=field?value[field]:value;if(!Array.isArray(items))throw new Error('Invalid paginated API result');output.push(...items);if(items.length<100)return output;}throw new Error('Pagination limit; refusing incomplete data');}
};
const repo={name:env.args.repository,...env.args};
const manager=new Manager({config:{appSlug:env.args.appSlug,repositories:[repo]},github:gh,state,save:()=>{},notify:async content=>effect({kind:'discord',content:content.slice(0,1900).replace(/@/g,'@\\u200b')})});
try{
  const result=await manager.run(env.args.mode,repo.name,env.args.dryRun);
  return [{json:{...env,state,effect:{kind:'done'},result}}];
}catch(error){
  if(error.yieldEffect)return [{json:{...env,state,effect:error.yieldEffect}}];
  return [{json:{...env,state,effect:{kind:'done'},fatal:error.message,result:{repository:repo.name,error:error.message}}}];
}`;
writeFileSync('/app/native-engine.js',engine);
const tableId={__rl:true,mode:'id',value:manifest.table};
const columns=value=>({mappingMode:'defineBelow',value,matchingColumns:[],schema:Object.keys(value).map(id=>({id,displayName:id,required:false,defaultMatch:false,display:true,type:'string',readOnly:false,removed:false})),attemptToConvertTypes:false,convertFieldsToString:false});
const condition=(keyName,keyValue)=>({keyName,condition:'eq',keyValue});
const dt=(name,values,conditions,x,y)=>node(name,'dataTable',{resource:'row',operation:'update',dataTableId:tableId,matchType:'allConditions',filters:{conditions},columns:columns(values),options:{}},x,y);
const iff=(name,leftValue,rightValue,x,y)=>node(name,'if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:randomUUID(),leftValue,rightValue,operator:{type:'string',operation:'equals'}}],combinator:'and'},options:{}},x,y);
const recordGitHub=`const s=$('Policy engine').last().json;const r=$input.first().json;
const pr=p=>({number:p.number,title:p.title,state:p.state,draft:p.draft,user:{login:p.user?.login},head:{sha:p.head?.sha,ref:p.head?.ref,repo:{full_name:p.head?.repo?.full_name}},html_url:p.html_url,merged:p.merged,merged_at:p.merged_at,updated_at:p.updated_at,mergeable:p.mergeable,mergeable_state:p.mergeable_state});
let body=r.body;const path=s.effect.path;
if(r.statusCode<400){
 if(/\\/pulls\\?/.test(path))body=body.map(pr);
 else if(/\\/pulls\\/\\d+$/.test(path))body=pr(body);
 else if(path.includes('/reviews?'))body=body.map(x=>({id:x.id,user:{login:x.user?.login},state:x.state,commit_id:x.commit_id}));
 else if(path.includes('/check-runs?'))body={check_runs:body.check_runs.map(x=>({id:x.id,name:x.name,app:{id:x.app?.id,slug:x.app?.slug},status:x.status,conclusion:x.conclusion}))};
 else if(path.includes('/statuses?'))body=body.map(x=>({context:x.context,state:x.state}));
 else if(path.includes('/actions/runs?'))body={workflow_runs:body.workflow_runs.map(x=>({id:x.id,workflow_id:x.workflow_id,event:x.event,head_sha:x.head_sha,head_branch:x.head_branch,pull_requests:x.pull_requests?.map(p=>({number:p.number})),status:x.status,conclusion:x.conclusion,run_attempt:x.run_attempt,name:x.name,html_url:x.html_url}))};
 else if(path==='/repos/'+s.args.repository)body={default_branch:body.default_branch};
}
s.log.push({effect:s.effect,response:r.error?{error:true,safeMessage:'GitHub transport error; inspect execution and repository state'}:{statusCode:r.statusCode,body,safeMessage:r.statusCode>=400?'GitHub '+s.effect.method+' '+path+': '+r.statusCode+' '+(r.body?.message||''):undefined}});return [{json:s}];`;
const worker=await put('worker',wf('PR policy and merge worker',[
  trigger(),
  {...dt('Claim repository lock',{lockOwner:'={{ String($execution.id) }}'},[condition('id','={{ $json.rowId }}'),condition('lockOwner','')],240,0),alwaysOutputData:true},
  iff('Repository lock acquired?',"={{ String($json.lockOwner || '') }}",'={{ String($execution.id) }}',360,0),
  code('Repository busy',`const args=$('Run one repository').first().json;throw new Error('Repository '+args.repository+' is locked or its state row is missing. No external actions were performed. Inspect the state table and owning execution before clearing a lock.');`,480,200),
  code('Initialize policy',`const args=$('Run one repository').first().json;if($json.lockOwner!==String($execution.id))throw new Error('Repository lock not acquired');return [{json:{args,initialState:{repositories:{[args.repository]:JSON.parse($json.state||'{"prs":{},"lastMerge":null,"outbox":[]}')}},log:[]}}];`,480,0),
  code('Policy engine',engine,720,0),
  dt('Checkpoint durable state',{state:'={{ JSON.stringify($json.state.repositories[$json.args.repository]) }}'},[condition('id','={{ $json.args.rowId }}'),condition('lockOwner','={{ String($execution.id) }}')],960,0),
  code('Restore policy context',`return [{json:$('Policy engine').last().json}];`,1200,0),
  iff('Finished?','={{ $json.effect.kind }}','done',1440,0),
  dt('Release repository lock',{lockOwner:'',lastResult:'={{ JSON.stringify($json.result) }}',lastRunAt:'={{ new Date().toISOString() }}'},[condition('id','={{ $json.args.rowId }}'),condition('lockOwner','={{ String($execution.id) }}')],1680,-160),
  code('Result',`const s=$('Policy engine').last().json;if(s.fatal)throw new Error(s.fatal);return [{json:s.result}];`,1920,-160),
  iff('Discord notification?','={{ $json.effect.kind }}','discord',1680,160),
  iff('GitHub write request?',"={{ ['POST','PUT','PATCH'].includes($json.effect.method) ? 'write' : 'read' }}",'write',1920,300),
  node('GitHub API request','httpRequest',{method:'={{ $json.effect.method }}',url:'={{ "https://api.github.com" + $json.effect.path }}',sendHeaders:true,headerParameters:{parameters:[{name:'Authorization',value:'={{ "Bearer " + $json.args.token }}'},{name:'Accept',value:'application/vnd.github+json'},{name:'X-GitHub-Api-Version',value:'2022-11-28'}]},sendBody:false,options:{timeout:30000,response:{response:{fullResponse:true,neverError:true,responseFormat:'json'}}}},2160,300,{onError:'continueRegularOutput'}),
  node('GitHub write request','httpRequest',{method:'={{ $json.effect.method }}',url:'={{ "https://api.github.com" + $json.effect.path }}',sendHeaders:true,headerParameters:{parameters:[{name:'Authorization',value:'={{ "Bearer " + $json.args.token }}'},{name:'Accept',value:'application/vnd.github+json'},{name:'X-GitHub-Api-Version',value:'2022-11-28'}]},sendBody:true,contentType:'json',specifyBody:'json',jsonBody:'={{ JSON.stringify($json.effect.body || {}) }}',options:{timeout:30000,response:{response:{fullResponse:true,neverError:true,responseFormat:'json'}}}},2160,460,{onError:'continueRegularOutput'}),
  node('Send Discord notification','discord',{authentication:'webhook',resource:'webhook',operation:'sendLegacy',content:'={{ $json.effect.content }}',options:{wait:true}},1920,80,{credentials:{discordWebhookApi:credentials.discordWebhookApi},onError:'continueRegularOutput',alwaysOutputData:true}),
  code('Record GitHub response',recordGitHub,2400,300),
  code('Record Discord response',`const s=$('Policy engine').last().json;const r=$input.first().json;s.log.push({effect:s.effect,response:r.error?{error:true,safeMessage:'Discord delivery failed; retained in outbox'}:{statusCode:200,body:{delivered:true}}});return [{json:s}];`,2160,80),
  note('## Native n8n policy worker\nA conditional Data Table update claims the repository lock. Every external action is preceded by a durable state checkpoint. The policy engine selects the next GitHub or Discord action; native nodes perform it.\n\nLocks never expire automatically. After a crash, first confirm the execution has stopped, inspect pendingMerge/retry intents, then clear lockOwner in the state table. Do not clear a live execution’s lock.\n\nDry runs perform GitHub reads only; no approvals, retries, merges, deletions, or Discord posts.',0,-430,1100,330)
],[['Run one repository','Claim repository lock'],['Claim repository lock','Repository lock acquired?'],['Repository lock acquired?','Initialize policy',0],['Repository lock acquired?','Repository busy',1],['Initialize policy','Policy engine'],['Policy engine','Checkpoint durable state'],['Checkpoint durable state','Restore policy context'],['Restore policy context','Finished?'],['Finished?','Release repository lock',0],['Release repository lock','Result'],['Finished?','Discord notification?',1],['Discord notification?','Send Discord notification',0],['Discord notification?','GitHub write request?',1],['GitHub write request?','GitHub write request',0],['GitHub write request?','GitHub API request',1],['GitHub write request','Record GitHub response'],['GitHub API request','Record GitHub response'],['Record GitHub response','Policy engine'],['Send Discord notification','Record Discord response'],['Record Discord response','Policy engine']]));
for(const mode of ['monitor','merge']){
  const scheduleName=mode==='monitor'?'At :00 every hour':'At :15 and :45';
  const scheduleInterval={field:'cronExpression',expression:mode==='monitor'?'0 0 * * * *':'0 15,45 * * * *'};
  await put(mode,wf(mode==='monitor'?'Check CI and approve':'Merge queue',[
    node(scheduleName,'scheduleTrigger',{rule:{interval:[scheduleInterval]}},0,0),
    node('Test manually','manualTrigger',{},0,180),
    code('Run settings',`return [{json:{mode:'${mode}',dryRun:true}}];`,240,0),
    call('Load repository configuration',config,480,0),
    call('Process each repository',worker,720,0,'each'),
    note(`## ${mode==='monitor'?'CI monitor':'Merge queue'}\nInactive and dry-run by default. Use Test manually to inspect read-only decisions.\n\nTo enable real actions, change dryRun to false in Run settings, then publish this workflow. GitHub branch rules remain enforced. ${mode==='merge'?'Only one PR per repo per cycle; scheduled checks at :15 and :45.':'One failed-job retry per run and commit. Repeat failures notify Discord once.'}\n\nRepository settings are in the shared Repository configuration workflow. Native GitHub credentials handle tokens. Parent failures are retained for diagnosis; successful payloads are not saved.`,0,-320,1100,270)
  ],[[scheduleName,'Run settings'],['Test manually','Run settings'],['Run settings','Load repository configuration'],['Load repository configuration','Process each repository']]));
}
console.log('All workflows created inactive, dryRun=true.');
