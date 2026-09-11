const{open,BASE}=require('./.pw.tmp.cjs');
const OUT='/private/tmp/claude-501/-Users-prakrit-firstmate-projects-proplane-claude-3/465f868e-c1f2-459a-807b-be3cd898b80f/scratchpad/shots/';
(async()=>{const{b,p}=await open('manager');
await p.goto(BASE+'/portal/properties/listed',{waitUntil:'domcontentloaded'});await p.waitForTimeout(3000);
await p.locator('[data-attr="property-list-row"]').first().click();await p.waitForTimeout(3000);
const edit=p.getByRole('button',{name:/Edit listing/}).first();if(await edit.count()){await edit.click();await p.waitForTimeout(4000);}
console.log(p.url());
const pricing=p.getByRole('button',{name:/Pricing/}).first();if(await pricing.count()){await pricing.click();await p.waitForTimeout(2000);}
const lt=p.locator('[data-attr="lease-type"]');console.log('lease-type group',await lt.count());
if(await lt.count()){await lt.scrollIntoViewIfNeeded();}
await p.screenshot({path:OUT+'pricing-lease-types.png'});
console.log('long-term lengths group',await p.locator('[data-attr="long-term-length"]').count());
const am=p.locator('[data-attr="amenity"]');console.log('amenity groups',await am.count());
await b.close();})().catch(e=>{console.error(e.message.slice(0,300));process.exit(1)});
