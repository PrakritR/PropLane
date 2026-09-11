const{open,BASE}=require('./.pw.tmp.cjs');
const OUT='/private/tmp/claude-501/-Users-prakrit-firstmate-projects-proplane-claude-3/465f868e-c1f2-459a-807b-be3cd898b80f/scratchpad/shots/';
async function pick(p,attr,label){await p.locator(`[data-attr="${attr}"]`).first().click();await p.waitForTimeout(400);await p.locator('[role="option"]').filter({hasText:label}).first().click();await p.waitForTimeout(300);}
(async()=>{const{b,p}=await open('manager');
await p.goto(BASE+'/portal/tasks',{waitUntil:'domcontentloaded'});await p.waitForTimeout(3000);
await p.click('[data-attr="manager-task-add-top"]');await p.waitForTimeout(2000);
const d=p.locator('[role="dialog"]').first();
const title='Recurring filter check '+Date.now();
await d.locator('#manager-task-title').fill(title);
await pick(p,'select-manager-task-urgency','Finish by').catch(()=>{});
await p.waitForTimeout(400);
const due=d.locator('input[type="date"]').last();await due.fill('2026-10-31');
await pick(p,'select-manager-task-recurrence','Every month');
await d.locator('#manager-task-checklist').fill('Check size\nPack tools');
await d.locator('#manager-task-attachments').fill('Quote https://example.com/quote.pdf');
await d.getByRole('button',{name:/^Add task$/}).click();await p.waitForTimeout(3500);
console.log('dialog still open?',await p.locator('[role="dialog"]').count());
await p.goto(BASE+'/portal/tasks',{waitUntil:'domcontentloaded'});await p.waitForTimeout(3000);
const rowText=await p.locator('[data-attr="manager-task-groups"]').innerText();console.log('LIST has task:',rowText.includes(title), rowText.split('\n').filter(l=>l.includes('steps')||l.includes('Repeats')).slice(0,3));
// open it -> comments
await p.getByText(title).first().click();await p.waitForTimeout(2000);
const d2=p.locator('[role="dialog"]').first();
await d2.locator('[data-attr="manager-task-comment-draft"]').fill('Parts confirmed.');await d2.locator('[data-attr="manager-task-comment-post"]').click();await p.waitForTimeout(2500);
console.log('comment shown:',(await d2.innerText()).includes('Parts confirmed.'));
await p.screenshot({path:OUT+'task-edit-comments.png'});
await d2.getByRole('button',{name:/^(Save|Save changes|Save task)$/}).last().click().catch(()=>{});await p.waitForTimeout(2500);
// complete via checkbox
await p.goto(BASE+'/portal/tasks',{waitUntil:'domcontentloaded'});await p.waitForTimeout(3000);
const row=p.locator('[data-attr="manager-task-groups"]').getByText(title).first();
const cb=row.locator('xpath=ancestor::*[self::li or self::div][.//input[@type="checkbox"]][1]//input[@type="checkbox"]').first();
if(await cb.count()){await cb.check();await p.waitForTimeout(800);}
const bulk=p.getByRole('button',{name:/^(Complete|Mark done|Done)$/}).first();if(await bulk.count()){await bulk.click();await p.waitForTimeout(3000);}
await p.goto(BASE+'/portal/tasks',{waitUntil:'domcontentloaded'});await p.waitForTimeout(3000);
const after=await p.locator('[data-attr="manager-task-groups"]').innerText().catch(()=>'');
console.log('after complete - next occurrence in progress?',after.includes(title), after.split('\n').filter(l=>l.includes('Nov')||l.includes('Due')).slice(0,4));
await p.goto(BASE+'/portal/tasks/completed',{waitUntil:'domcontentloaded'});await p.waitForTimeout(3000);
const done=await p.locator('[data-attr="manager-task-groups"]').innerText().catch(()=>'');console.log('completed tab has it:',done.includes(title));
await p.screenshot({path:OUT+'task-list-after.png'});
await b.close();})().catch(e=>{console.error(e.message.slice(0,300));process.exit(1)});
