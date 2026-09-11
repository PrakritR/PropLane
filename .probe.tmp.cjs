const{open,BASE}=require('./.pw.tmp.cjs');
(async()=>{const{b,p}=await open('manager',{width:390,height:844});
await p.goto(BASE+'/portal/tours/pending',{waitUntil:'domcontentloaded'});await p.waitForTimeout(3000);
console.log(await p.evaluate(()=>{const q=s=>document.querySelector(s);const r=e=>e?[Math.round(e.getBoundingClientRect().top),Math.round(e.getBoundingClientRect().height)]:null;
 const st=q('[data-slot=portal-list-control-stack]');const hl=q('[data-slot=portal-page-headline]');
 const chain=[];let e=st;while(e&&e!==document.body){const cs=getComputedStyle(e);chain.push([e.tagName,(e.getAttribute('data-slot')||e.id||e.className.toString().slice(0,50)),r(e),cs.position,cs.overflowY,cs.marginTop,cs.paddingTop]);e=e.parentElement}
 return JSON.stringify({bar:r(q('.portal-mobile-nav-bar')),hl:r(hl),st:r(st),stTop:getComputedStyle(st).top,chain:chain.slice(0,8)},null,1)}));
await b.close();})();
