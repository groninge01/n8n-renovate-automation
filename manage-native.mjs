import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync('/app/native-manifest.json'));
const key=readFileSync('/secrets/api.env','utf8').split('\n').find(s=>s.startsWith('N8N_API_KEY=')).slice(12).trim().replace(/^(['"])(.*)\1$/,'$2');
async function api(path,method='GET',body){const r=await fetch('http://n8n:5678/api/v1'+path,{method,headers:{'X-N8N-API-KEY':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();const j=text?JSON.parse(text):null;if(!r.ok)throw new Error(r.status+' '+JSON.stringify(j));return j;}
const action=process.argv[2];
if(action==='state')console.log(JSON.stringify(await api(`/data-tables/${manifest.table}/rows`)));
if(action==='status')for(const type of ['configuration','worker','monitor','merge']){const w=await api('/workflows/'+manifest[type]);console.log(JSON.stringify({type,id:w.id,name:w.name,active:w.active}));}
