export function nativeGithubPlan(credentialId) {
  const credential={githubAppApi:{id:credentialId,name:'Renovate — GitHub App'}};
  const routeCode=String.raw`const s=$input.first().json;
const base='/repos/'+s.args.repository;
if(!s.effect.path.startsWith(base))throw new Error('Unexpected GitHub repository path');
const path=s.effect.path.slice(base.length);
const query=name=>(path.match(new RegExp('[?&]'+name+'=([^&]+)'))||[])[1];
let route='rest';
if(s.effect.method==='GET'){
 if(path.startsWith('/pulls?'))route='pulls';
 else if(/^\/pulls\/\d+$/.test(path))route='pull';
 else if(/^\/pulls\/\d+\/reviews\?/.test(path))route='reviews';
 else if(path==='')route='repository';
}
return [{json:{...s,nativeGithub:{route,number:Number((path.match(/^\/pulls\/(\d+)/)||[])[1]||0),page:Number(query('page')||1),state:query('state')||'open',sort:query('sort')||'created',direction:query('direction')||'desc'}}}];`;
  const common={authentication:'githubAppApi',owner:{__rl:true,mode:'name',value:'={{ $json.args.repository.split("/")[0] }}'},repository:{__rl:true,mode:'name',value:'={{ $json.args.repository.split("/")[1] }}'}};
  const make=(name,resource,operation,parameters,y)=>({name,type:'n8n-nodes-base.github',typeVersion:1.1,position:[2160,y],parameters:{...common,resource,operation,...parameters},credentials:credential,onError:'continueRegularOutput',alwaysOutputData:true});
  const native=[
    make('GitHub — List pull requests','repository','getPullRequests',{returnAll:true,getRepositoryPullRequestsFilters:{state:'={{ $json.nativeGithub.state }}',sort:'={{ $json.nativeGithub.sort }}',direction:'={{ $json.nativeGithub.direction }}'}},600),
    make('GitHub — Get pull request','pullRequest','get',{pullRequestNumber:'={{ $json.nativeGithub.number }}'},760),
    make('GitHub — List reviews','review','getAll',{pullRequestNumber:'={{ $json.nativeGithub.number }}',returnAll:true},920),
    make('GitHub — Get repository','repository','get',{},1080),
  ];
  const switchParams={mode:'rules',rules:{values:['pulls','pull','reviews','repository'].map(route=>({renameOutput:true,outputKey:route,conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{leftValue:'={{ $json.nativeGithub.route }}',rightValue:route,operator:{type:'string',operation:'equals'}}],combinator:'and'}}))},options:{fallbackOutput:'extra',renameFallbackOutput:'REST operations'}};
  const normalizeCode=`const s=$('Route GitHub operation').last().json;
const items=$input.all().map(i=>i.json);
const failure=items.find(i=>i.error);
if(failure)return [{json:{error:true}}];
let body;
if(['pulls','reviews'].includes(s.nativeGithub.route)){
 const values=items.filter(i=>i.id!==undefined);
 const start=(s.nativeGithub.page-1)*100;
 body=values.slice(start,start+100);
}else body=items[0];
return [{json:{statusCode:200,body}}];`;
  const nodes=[
    {name:'Route GitHub operation',type:'n8n-nodes-base.code',typeVersion:2,position:[1680,600],parameters:{jsCode:routeCode}},
    {name:'Native GitHub operation',type:'n8n-nodes-base.switch',typeVersion:3.3,position:[1920,760],parameters:switchParams},
    ...native,
    {name:'Normalize native GitHub response',type:'n8n-nodes-base.code',typeVersion:2,position:[2400,760],parameters:{jsCode:normalizeCode}},
  ];
  const edges=[['Route GitHub operation','Native GitHub operation'],...native.map((n,i)=>['Native GitHub operation',n.name,i]),['Native GitHub operation','GitHub write request?',4],...native.map(n=>[n.name,'Normalize native GitHub response']),['Normalize native GitHub response','Record GitHub response']];
  return {nodes:nodes.map((node,index)=>({...node,id:'renovate-native-github-'+index})),edges,credential};
}

export function applyNativeGithub(workflow,credentialId) {
  const plan=nativeGithubPlan(credentialId);
  workflow.nodes.push(...plan.nodes);
  for(const name of ['GitHub API request','GitHub write request']){
    const n=workflow.nodes.find(n=>n.name===name);
    Object.assign(n.parameters,{authentication:'predefinedCredentialType',nodeCredentialType:'githubAppApi',sendHeaders:false});
    delete n.parameters.headerParameters;
    n.credentials=plan.credential;
  }
  const branch=workflow.connections['Discord notification?'].main[1];
  branch.find(e=>e.node==='GitHub write request?').node='Route GitHub operation';
  for(const [source,target,index=0] of plan.edges){
    workflow.connections[source]||={main:[]};
    workflow.connections[source].main[index]||=[];
    workflow.connections[source].main[index].push({node:target,type:'main',index:0});
  }
  return workflow;
}
