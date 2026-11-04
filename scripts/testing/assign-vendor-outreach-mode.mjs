/** Staff-owned sender assignment. Dev/test only; no vendor communication occurs.
 * Usage: node --env-file=.env scripts/testing/assign-vendor-outreach-mode.mjs <manager-id> <admin-id> software
 * Managed mode additionally takes display name, legal name, verified sender email,
 * current work phone and messaging-service SID. SQL rechecks staff and line ownership.
 */
import { createClient } from '@supabase/supabase-js';
const [managerId, adminId, mode, displayName, legalName, email, workPhone, serviceSid] = process.argv.slice(2);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
if (!url || new URL(url).hostname !== 'emstjswhotsnyksqhqyf.supabase.co') throw new Error('Dev/test target required.');
if (!/^[a-f0-9-]{36}$/i.test(managerId || '') || !/^[a-f0-9-]{36}$/i.test(adminId || '') || !['software','managed'].includes(mode)) throw new Error('Valid manager, staff actor and mode required.');
if (mode === 'managed' && ![displayName,legalName,email,workPhone,serviceSid].every(Boolean)) throw new Error('All managed identity fields required.');
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data, error } = await db.rpc('assign_vendor_outreach_mode', { p_manager_user_id: managerId, p_mode: mode, p_admin_user_id: adminId, p_display_name: displayName || null, p_legal_name: legalName || null, p_email: email || null, p_work_phone: workPhone || null, p_messaging_service_sid: serviceSid || null });
if (error) throw new Error('Sender assignment rejected. Verify staff authority and current work identity.');
console.log(JSON.stringify({ assigned: true, mode, version: Array.isArray(data) ? data[0]?.version : data?.version }));
