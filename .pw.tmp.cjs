const{chromium}=require('@playwright/test');
const BASE='http://localhost:3003';
const ACC={manager:['manager@test.proplane.local','TestManager123!','Property','/portal/dashboard'],resident:['resident@test.proplane.local','TestResident123!','Resident','/resident/dashboard'],vendor:['vendor@test.proplane.local','TestVendor123!','Vendor','/vendor/dashboard']};
async function login(p,role){const[email,pw,label,next]=ACC[role];await p.goto(BASE+'/auth/sign-in?next='+encodeURIComponent(next),{waitUntil:'domcontentloaded'});
 if(p.url().includes('/auth/sign-in')){await p.getByPlaceholder('Email').fill(email);await p.getByPlaceholder('Password').fill(pw);await p.getByRole('button',{name:/sign in/i}).click();await p.waitForURL(u=>!u.pathname.includes('/auth/sign-in'),{timeout:60000,waitUntil:'commit'});}
 if(new URL(p.url()).pathname.startsWith(next))return;
 await p.goto(BASE+'/auth/choose-portal?next='+encodeURIComponent(next),{waitUntil:'domcontentloaded'});
 const opt=p.getByRole('button',{name:new RegExp('^'+label)});
 for(let i=0;i<40;i++){if(new URL(p.url()).pathname.startsWith(next))return;if(await opt.count()&&await opt.first().isEnabled().catch(()=>false)){await opt.first().click();break}await p.waitForTimeout(500)}
 await p.waitForURL(u=>u.pathname.startsWith(next),{timeout:45000,waitUntil:'commit'});}
async function open(role,viewport={width:1440,height:900}){const b=await chromium.launch();const ctx=await b.newContext({viewport});const p=await ctx.newPage();p.on('pageerror',e=>console.log('PAGEERR',e.message.slice(0,160)));await login(p,role);return{b,ctx,p}}
module.exports={login,open,BASE};
