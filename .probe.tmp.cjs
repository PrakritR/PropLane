const{open,BASE}=require('./.pw.tmp.cjs');
const OUT='/private/tmp/claude-501/-Users-prakrit-firstmate-projects-proplane-claude-3/465f868e-c1f2-459a-807b-be3cd898b80f/scratchpad/shots/';
(async()=>{const{b,p}=await open('manager');
await p.goto(BASE+'/portal/properties/listed',{waitUntil:'domcontentloaded'});await p.waitForTimeout(3000);
await p.locator('[data-attr="property-list-row"]').first().click();await p.waitForTimeout(3500);console.log('detail',p.url());
await p.screenshot({path:OUT+'prop-preview-desktop.png'});
for(const tab of ['house-details','tours','applications','lease','services','bookings','promotion','move-in']){const u=p.url().replace(/\/[^/]+$/,'/'+tab);await p.goto(u,{waitUntil:'domcontentloaded'});await p.waitForTimeout(2500);console.log(tab,new URL(p.url()).pathname);await p.screenshot({path:OUT+'prop-'+tab+'-desktop.png'});}
await p.setViewportSize({width:390,height:844});await p.goto(p.url().replace(/\/[^/]+$/,'/preview'),{waitUntil:'domcontentloaded'});await p.waitForTimeout(2500);await p.screenshot({path:OUT+'prop-preview-mobile.png'});
await b.close();})().catch(e=>{console.error(e.message.slice(0,200));process.exit(1)});
