import fs from 'node:fs';
import { DOGFOOD_MANAGER_EMAIL, DOGFOOD_RESIDENT_EMAIL, DOGFOOD_ACCOUNT_PASSWORD } from '../../tests/helpers/canonical-test-accounts.mjs';
import { createClient } from '@supabase/supabase-js';
const expected = 'emstjswhotsnyksqhqyf';
if (new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname !== `${expected}.supabase.co`) throw new Error('Dev/test target required');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
async function must(query) { const {data,error} = await query; if(error)throw new Error(error.message);return data; }
const users = (await must(db.auth.admin.listUsers({perPage:1000}))).users;
const manager = users.find((u)=>u.email === process.env.E2E_MANAGER_EMAIL) ?? users.find((u)=>u.email === DOGFOOD_MANAGER_EMAIL);
const resident = users.find((u)=>u.email === process.env.E2E_RESIDENT_EMAIL) ?? users.find((u)=>u.email === DOGFOOD_RESIDENT_EMAIL);
if(!manager || !resident)throw new Error('Canonical E2E manager/resident must be seeded first');
const email='coordination-vendor@test.proplane.local';
let vendor=users.find((u)=>u.email===email);
if(!vendor) vendor=(await must(db.auth.admin.createUser({email,password:DOGFOOD_ACCOUNT_PASSWORD,email_confirm:true,user_metadata:{role:'vendor',full_name:'Coordination Vendor'}}))).user;
const now=new Date().toISOString();
await must(db.from('profiles').upsert({id:vendor.id,email,role:'vendor',full_name:'Coordination Vendor',phone:'+12025550144',phone_verified_at:now}));
await must(db.from('profile_roles').upsert({user_id:vendor.id,role:'vendor'},{onConflict:'user_id,role'}));
const properties=await must(db.from('manager_property_records').select('id,row_data').eq('manager_user_id',manager.id).limit(1));
if(!properties?.length)throw new Error('Canonical manager property required');
const property=properties[0];
const dirs=[{id:'coordination-qa-vendor',vendor_user_id:vendor.id,row_data:{name:'Coordination Vendor',email,phone:'+12025550144'}},{id:'coordination-qa-invitee',vendor_user_id:null,row_data:{name:'Directory Quote Vendor',email:'coordination-invitee@example.invalid',phone:'+12025550145'}}];
for(const d of dirs) await must(db.from('manager_vendor_records').upsert({...d,manager_user_id:manager.id,updated_at:now}));
for(const [index,d] of dirs.entries()) {
const id=`coordination-qa-${index ? 'directory' : 'repair'}`;
const existing=await must(db.from('portal_work_order_records').select('*').eq('id',id).maybeSingle());
if(existing)continue;
const row={id,reference:`Service QA ${index+1}`,title:index ? 'Directory consultation QA' : 'Kitchen leak coordination QA',description:'Seeded non-production service coordination',propertyId:property.id,assignedPropertyId:property.id,propertyName:property.row_data?.title||property.row_data?.address||'QA home',residentEmail:resident.email,residentName:'QA Resident',vendorId:d.id,vendorName:d.row_data.name,bucket:'unscheduled',status:'Open',priority:'Normal',category:'Plumbing',scheduled:'—',cost:'—',biddingOpen:true};
await must(db.from('portal_work_order_records').insert({id,manager_user_id:manager.id,resident_email:resident.email,vendor_user_id:d.vendor_user_id,property_id:property.id,assigned_property_id:property.id,row_data:row,updated_at:now}));
await must(db.from('work_order_vendor_offers').insert({work_order_id:id,manager_user_id:manager.id,vendor_directory_id:d.id,vendor_user_id:d.vendor_user_id,status:'sent',expires_at:new Date(Date.now()+30*86400000).toISOString()}));
}
await must(db.from('vendor_coordination_phone_bindings').upsert({manager_user_id:manager.id,vendor_directory_id:dirs[0].id,vendor_user_id:vendor.id,phone_e164:'+12025550144',verified_at:now,revoked_at:null},{onConflict:'manager_user_id,vendor_directory_id'}));
const settings=await must(db.from('manager_automation_settings').select('*').eq('manager_user_id',manager.id).maybeSingle());
fs.writeFileSync('/tmp/vendor-coordination-qa-settings-before.json',JSON.stringify(settings),{mode:0o600});
console.log(JSON.stringify({target:expected,managerUserId:manager.id,residentUserId:resident.id,vendorUserId:vendor.id,propertyId:property.id,services:['coordination-qa-repair','coordination-qa-directory'],vendorEmail:email}));
