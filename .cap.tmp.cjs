const{chromium}=require('@playwright/test');
const OUT='/private/tmp/claude-501/-Users-prakrit-firstmate-projects-proplane-claude-3/465f868e-c1f2-459a-807b-be3cd898b80f/scratchpad/spec2/';
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1440,height:900}});
await p.goto('file:///Users/prakrit/firstmate/projects/proplane-claude-2/.lavish/mobbin-redesign/plan.html');await p.waitForTimeout(2500);
const h=await p.evaluate(()=>document.body.scrollHeight);console.log('height',h);
for(let y=0,i=0;y<h&&i<40;y+=900,i++){await p.evaluate(v=>window.scrollTo(0,v),y);await p.waitForTimeout(250);await p.screenshot({path:OUT+`plan-${String(i).padStart(2,'0')}.png`});}
console.log(await p.evaluate(()=>Array.from(document.querySelectorAll('h1,h2')).map(e=>e.textContent.trim()).join(' | ')));
await b.close();})();
