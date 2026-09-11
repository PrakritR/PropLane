const{open,BASE}=require('./.pw.tmp.cjs');
(async()=>{const{b,p}=await open('manager');
const r=await p.evaluate(async()=>{const list=await (await fetch('/api/portal/manager-tasks',{credentials:'include'})).json();const seed=(list.tasks||[])[0];
 const create=await fetch('/api/portal/manager-tasks',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Monthly clamp probe',assignee:seed.assignee,dueDate:'2026-10-31T16:00:00.000Z',recurrence:'monthly',checklist:[{label:'A',done:true}],priority:'high'})});const cj=await create.json();
 const patch=await fetch('/api/portal/manager-tasks',{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:cj.task.id,completed:true})});const pj=await patch.json();
 return {created:{due:cj.task.dueDate,priority:cj.task.priority,rec:cj.task.recurrence},next:pj.nextOccurrence&&{due:pj.nextOccurrence.dueDate,checklist:pj.nextOccurrence.checklist,of:pj.nextOccurrence.recurrenceOfTaskId===cj.task.id}}});
console.log(JSON.stringify(r));
await b.close();})().catch(e=>{console.error(e.message.slice(0,300));process.exit(1)});
