export function formatDiscordNotification(content) {
  const lines=content.split('\n');
  const heading=lines[0];
  const prUrl=lines.find(line=>/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(line));
  const match=prUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  const repository=match?.[1];
  const number=match?.[2];
  const approved=heading.startsWith('✅ Approved');
  const merged=heading.startsWith('✅ Merged');
  const failed=heading.startsWith('❌');
  const status=approved?'✅ Approved':merged?'🔀 Merged':failed?'❌ CI failed':'⚠️ Attention needed';
  const title=heading.includes(' — ')?heading.slice(heading.indexOf(' — ')+3):undefined;
  const fields=[];
  if(repository)fields.push({name:'Repository',value:'['+repository+'](https://github.com/'+repository+')',inline:false});
  if(approved)fields.push({name:'CI checks',value:'All passed',inline:true});
  const sha=content.match(/Commit:\s*([a-f0-9]{40})/i)?.[1];
  if(sha&&repository)fields.push({name:'Commit',value:'[`'+sha.slice(0,7)+'`](https://github.com/'+repository+'/commit/'+sha+')',inline:true});
  if(merged){
    const method=content.match(/Method: ([^.]+)\./)?.[1];
    const branch=content.match(/Branch ([^.]+)\./)?.[1];
    if(method)fields.push({name:'Merge method',value:method,inline:true});
    if(branch)fields.push({name:'Source branch',value:branch,inline:true});
    fields.push({name:'Merge checks',value:':15 and :45 each hour',inline:false});
  }
  if(failed){
    const workflow=lines.find(line=>line.startsWith('Workflow: '))?.slice(10);
    const runUrl=lines.find(line=>/^https:\/\/github\.com\/.*\/actions\/runs\//.test(line));
    if(workflow)fields.push({name:'Failed workflow',value:runUrl?'['+workflow+']('+runUrl+')':workflow,inline:false});
  }
  const details=lines.slice(2).filter(line=>!line.startsWith('https://')).join('\n');
  return {
    color:approved?0x57F287:merged?0x5865F2:failed?0xED4245:0xFEE75C,
    title:(status+(number?' · PR #'+number:'')).slice(0,256),
    ...(prUrl?{url:prUrl}:{}),
    description:title?'**'+title.replace(/([\\*_`])/g,'\\$1')+'**':(details||heading).slice(0,4096),
    ...(fields.length?{fields}:{}),
    footer:{text:'Renovate PR Manager'},
  };
}

export function discordEmbedParameters() {
  return {content:'',embeds:{values:[{inputMethod:'json',json:'={{ JSON.stringify(('+formatDiscordNotification.toString()+')($json.effect.content)) }}'}]}};
}
