const{chromium}=require('@playwright/test');
const OUT='/private/tmp/claude-501/-Users-prakrit-firstmate-projects-proplane-claude-3/465f868e-c1f2-459a-807b-be3cd898b80f/scratchpad/now/';
const BASE='http://localhost:3003';
async function login(p,email,pw,role,next){await p.goto(BASE+'/auth/sign-in?next='+encodeURIComponent(next),{waitUntil:'domcontentloaded'});
 if(p.url().includes('/auth/sign-in')){await p.getByPlaceholder('Email').fill(email);await p.getByPlaceholder('Password').fill(pw);await p.getByRole('button',{name:/sign in/i}).click();await p.waitForURL(u=>!u.pathname.includes('/auth/sign-in'),{timeout:60000});}
 console.log('after signin',p.url());
 if(new URL(p.url()).pathname.startsWith(next))return;
 await p.goto(BASE+'/auth/choose-portal?next='+encodeURIComponent(next),{waitUntil:'domcontentloaded'});
 const opt=p.getByRole('button',{name:new RegExp('^'+role)});
 for(let i=0;i<40;i++){if(new URL(p.url()).pathname.startsWith(next))return;if(await opt.count()&&await opt.first().isEnabled().catch(()=>false)){await opt.first().click();break}await p.waitForTimeout(500)}
 await p.waitForURL(u=>u.pathname.startsWith(next),{timeout:45000});}
(async()=>{const b=await chromium.launch();const ctx=await b.newContext({viewport:{width:1440,height:900}});const p=await ctx.newPage();
await login(p,'manager@test.proplane.local','TestManager123!','Property','/portal/dashboard');
console.log('at',p.url());
const routes=['/portal/dashboard','/portal/properties/listed','/portal/tours/pending','/portal/applications/pending','/portal/leases/manager','/portal/residents/current','/portal/inspections/move-in','/portal/payments/incoming/pending','/portal/services','/portal/documents','/portal/tasks','/portal/communication','/portal/teams/managers','/portal/profile'];
for(const r of routes){try{await p.goto(BASE+r,{waitUntil:'domcontentloaded',timeout:60000});await p.waitForTimeout(2500);const name=r.replace(/^\/portal\//,'').replace(/\//g,'-');await p.screenshot({path:OUT+'mgr-'+name+'-desktop.png'});await p.setViewportSize({width:390,height:844});await p.waitForTimeout(700);await p.screenshot({path:OUT+'mgr-'+name+'-mobile.png'});await p.setViewportSize({width:1440,height:900});console.log('ok',r,new URL(p.url()).pathname)}catch(e){console.log('fail',r,e.message.slice(0,80))}}
await b.close();})().catch(e=>{console.error(e);process.exit(1)});
