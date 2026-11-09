import {readFileSync} from 'node:fs';
const line=readFileSync('/secrets/discord.env','utf8').split('\n').find(s=>s.startsWith('DISCORD_WEBHOOK_URL='));
const value=line.slice('DISCORD_WEBHOOK_URL='.length).trim().replace(/^(['"])(.*)\1$/,'$2');
const url=new URL(value);
if(url.protocol!=='https:'||!['discord.com','discordapp.com'].includes(url.hostname)||!url.pathname.startsWith('/api/webhooks/'))throw new Error('Invalid Discord webhook URL');
const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
console.log(JSON.stringify({discordWebhookStatus:response.status,messageSent:false}));
if(!response.ok)process.exitCode=1;
