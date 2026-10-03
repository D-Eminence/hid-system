// Invented fixture only; no customer rows, keys, hashes or notification text.
import {randomUUID} from 'node:crypto';
import {CUSTOMER_SOURCE_TABLES} from './customer-source-tables.mjs';
import {sealCustomerSource} from './customer-data-validation.mjs';
import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
export function syntheticCustomerSource(source){
  const collections=Object.fromEntries(CUSTOMER_SOURCE_TABLES.map(t=>[t.category,source.collections[t.category]??[]]));
  const profile=source.collections.user_profiles[0],patient=source.collections.patients[0];
  collections.notifications=Array.from({length:193},(_,i)=>({id:randomUUID(),user_profile_id:profile.id,patient_id:patient.id,
    title:'Synthetic notification',message:'Invented historical message.',type:'history',created_at:new Date(Date.UTC(2026,0,1,0,i)).toISOString(),
    read_at:i===0?'2026-01-02T00:00:00.000Z':null}));
  collections.commercial_products=Array.from({length:8},(_,i)=>({id:randomUUID(),slug:i===0?'ehr':`synthetic-${i}`,
    name:'Synthetic product',status:'active',currency:'NGN',public_visible:true,trial_eligible:true,default_billing_cycle:'monthly',setup_fee_minor:1500}));
  collections.commercial_prices=collections.commercial_products.map(p=>({id:randomUUID(),product_id:p.id,context:'standalone',visibility:'fixed',
    amount_minor:15000,currency:'NGN',billing_period:'month',unit:'facility',active:true}));
  collections.platform_billing_settings=[{id:true,default_trial_days:14,grace_period_days:7,proration_enabled:false,late_fee_minor:0,
    default_currency:'NGN',restriction_policy:{synthetic:true}}];
  collections.platform_controls=[{id:true,patient_portal_enabled:true,hospital_portal_enabled:false,maintenance_mode:false,
    uploads_enabled:false,break_glass_enabled:false,patient_signup_enabled:false}];
  collections.staff_role_policies=Array.from({length:5},(_,i)=>({role:`synthetic-role-${i}`,can_view_patient_records:false,can_create_records:false,
    can_use_break_glass:false,can_open_dashboard:true,can_use_standard_access:false,can_view_history:false}));
  collections.ai_workload_routes=Array.from({length:8},(_,i)=>({workload:`synthetic-workload-${i}`,processing_strategy:'synthetic-review-required',
    primary_model_id:null,fallback_model_id:null,configuration_version:1}));
  collections.auth_challenges=Array.from({length:74},()=>({id:randomUUID(),patient_id:patient.id,otp_hash:'synthetic-noncredential',
    expires_at:'2020-01-01T00:00:00.000Z'}));
  for(const t of CUSTOMER_SOURCE_TABLES.filter(t=>t.disposition==='excluded-invalid-outreach')) collections[t.category]=[{[t.pk]:t.pk==='role'?'synthetic':randomUUID(),synthetic:true}];
  const inventory={},rows=[];
  for(const t of CUSTOMER_SOURCE_TABLES){
    inventory[t.table]=collections[t.category].length;
    for(const payload of collections[t.category]) rows.push({entity_type:t.category,source_pk:String(payload[t.pk]),payload,payload_sha256:sha256(canonicalJson(payload))});
  }
  return sealCustomerSource('synthetic-customer-source','synthetic:transaction',inventory,rows);
}
