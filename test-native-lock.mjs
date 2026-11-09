import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const key=readFileSync('/secrets/api.env','utf8').split('\n').find(s=>s.startsWith('N8N_API_KEY=')).slice(12).trim().replace(/^(['"])(.*)\1$/,'$2');
async function api(path,method='GET',body){const r=await fetch('http://n8n:5678/api/v1'+path,{method,headers:{'X-N8N-API-KEY':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();const j=text?JSON.parse(text):null;if(!r.ok)throw new Error(r.status+' '+JSON.stringify(j));return j;}
const table=await api('/data-tables','POST',{name:'Temporary isolated Renovate lock validation',columns:[{name:'lockOwner',type:'string'}]});
try {
 const rows=await api(`/data-tables/${table.id}/rows`,'POST',{data:[{lockOwner:''},{lockOwner:''}],returnType:'all'});
 const mutate=(row,owner,newOwner)=>api(`/data-tables/${table.id}/rows/update`,'PATCH',{filter:{type:'and',filters:[{columnName:'id',condition:'eq',value:row},{columnName:'lockOwner',condition:'eq',value:owner}]},data:{lockOwner:newOwner},returnData:true});
 const results=await Promise.all(Array.from({length:8},(_,i)=>mutate(rows[0].id,'','test-'+i)));
 const winners=results.filter(r=>r.length);
 assert.equal(winners.length,1,'Exactly one concurrent claim must win');
 assert.equal((await mutate(rows[1].id,'','other-repo')).length,1,'A different repository must be independent');
 assert.equal((await mutate(rows[0].id,'wrong-owner','')).length,0,'Other execution cannot release the lock');
 assert.equal((await mutate(rows[0].id,winners[0][0].lockOwner,'')).length,1,'Owner can release lock');
 console.log('PASS: 8 simultaneous claims, exactly 1 winner; independent repository and owner-only release verified.');
} finally {await api('/data-tables/'+table.id,'DELETE');console.log('Temporary isolated table removed; production state was untouched.');}
