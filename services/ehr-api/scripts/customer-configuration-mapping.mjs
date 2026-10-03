import {CONFIGURATION_CATEGORIES} from './customer-source-tables.mjs';
import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
const nativeSlugs=new Set(['identity','ehr','laboratory','pharmacy','migrate','outreach','api']);
const controls=new Map([['patient_portal_enabled','patient_portal_enabled'],['hospital_portal_enabled','provider_portal_enabled'],
  ['outreach_portal_enabled','outreach_portal_enabled'],['maintenance_mode','maintenance_mode'],['uploads_enabled','uploads_enabled'],['break_glass_enabled','break_glass_enabled']]);
const contexts=new Set(['core','addon','standalone','usage','setup','migration_project','enterprise']);
const visibilities=new Set(['fixed','starting_from','contact_sales','custom_quote','hidden']);
const statuses=new Set(['active','coming_soon','draft','retired']);
export function configurationDecisions(sealed,plan){
  if(!plan) return new Map(); // Preservation is explicit pending activation, not a completed operational mapping.
  if(plan.schema!=='hid.customer-configuration-map/v1'||plan.source_checksum!==sealed.sourceChecksum
    ||typeof plan.approved_by!=='string'||plan.approved_by.length<3||!plan.actor_subject||!Array.isArray(plan.entries)) throw new Error('Reviewed configuration mapping metadata is required');
  const entries=new Map();
  for(const decision of plan.entries){
    const coordinate=`${decision.category}:${decision.source_pk}`;
    const row=sealed.grouped.get(decision.category)?.find(r=>r.source_pk===decision.source_pk);
    if(!CONFIGURATION_CATEGORIES.includes(decision.category)||!row||row.payload_sha256!==decision.source_sha256||entries.has(coordinate)
      ||!['retain','product','price','control'].includes(decision.action)||typeof decision.reason!=='string'||decision.reason.trim().length<8) throw new Error('Configuration mapping coordinate/action is invalid');
    if(['product','price'].includes(decision.action)&&!/^[a-f0-9]{64}$/.test(decision.expected_target_sha256??'')) throw new Error('Exact target baseline is required before configuration changes');
    entries.set(coordinate,decision);
  }
  const count=CONFIGURATION_CATEGORIES.reduce((n,c)=>n+sealed.grouped.get(c).length,0);
  if(entries.size!==count) throw new Error('Every preserved configuration row requires an explicit decision');
  return entries;
}
export function nativeConfigurationChange(row,decision,products){
  const p=row.payload;
  if(decision.action==='retain') return null;
  if(decision.action==='product'){
    if(row.entity_type!=='commercial_products'||!nativeSlugs.has(decision.target)||!statuses.has(p.status)||typeof p.name!=='string'
      ||[...p.name.trim()].length<2||[...p.name.trim()].length>120||(p.public_visible===false&&p.status==='active')) throw new Error('Product semantics require a reviewed supported target');
    return {table:'platform.commercial_products',keys:{slug:decision.target},value:{name:p.name,status:p.status},permission:'platform.pricing.manage'};
  }
  if(decision.action==='price'){
    if(row.entity_type!=='commercial_prices'||!nativeSlugs.has(decision.target?.product_slug)||!contexts.has(p.context)
      ||!visibilities.has(p.visibility)||!products.some(r=>r.source_pk===p.product_id)||typeof p.active!=='boolean'||!/^[A-Z]{3}$/.test(p.currency??'')) throw new Error('Price semantics require an exact supported mapping');
    const amount=p.amount_minor==null?null:Number(p.amount_minor);
    if((amount!==null&&(!Number.isSafeInteger(amount)||amount<0))||(['fixed','starting_from'].includes(p.visibility)!==(amount!==null))) throw new Error('Price amount/visibility is invalid');
    if((p.billing_period!=null&&(typeof p.billing_period!=='string'||!/^[a-z][a-z0-9_]{1,39}$/.test(p.billing_period)))
      ||(p.unit!=null&&(typeof p.unit!=='string'||[...p.unit.trim()].length<1||[...p.unit.trim()].length>80))) throw new Error('Price period/unit is invalid');
    return {table:'platform.commercial_prices',keys:{product_slug:decision.target.product_slug,context:p.context},
      value:{visibility:p.visibility,amount_minor:amount,currency:p.currency,billing_period:p.billing_period??null,unit:p.unit??null,active:p.active},permission:'platform.pricing.manage'};
  }
  if(decision.action==='control'){
    if(row.entity_type!=='platform_controls'||!Array.isArray(decision.controls)||new Set(decision.controls).size!==decision.controls.length
      ||decision.controls.length===0||decision.controls.some(k=>!controls.has(k)||typeof p[k]!=='boolean'
        ||!/^[a-f0-9]{64}$/.test(decision.expected_targets?.[controls.get(k)]??''))) throw new Error('Platform control mapping is unsupported');
    return decision.controls.map(key=>({table:'platform.control_settings',keys:{control_key:controls.get(key)},value:{enabled:p[key],reason:decision.reason},permission:'platform.control.manage',
      expected_target_sha256:decision.expected_targets?.[controls.get(key)]}));
  }
  throw new Error('Unsupported operational configuration mapping');
}
export async function applyNativeConfiguration(client,row,decision,{products,decisions,actorSubject,repeated,correlationId}){
  if(decision.action==='price'&&decisions.get(`commercial_products:${row.payload.product_id}`)?.target!==decision.target?.product_slug) throw new Error('Price target differs from its reviewed product mapping');
  const changes=nativeConfigurationChange(row,decision,products);
  if(changes===null) return {disposition:'retained-pending-activation',target:null};
  await client.query("select set_config('app.actor_subject',$1,true)",[actorSubject]);
  await client.query("select set_config('app.correlation_id',$1,true)",[correlationId]);
  for(const change of Array.isArray(changes)?changes:[changes]){
    const permitted=(await client.query('select auth.account_has_platform_permission(platform.current_account_id(),$1) allowed',[change.permission])).rows[0];
    if(!permitted?.allowed) throw new Error('Configuration activation requires an existing authorized platform actor');
    const keys=Object.keys(change.keys),where=keys.map((k,i)=>`${k}=$${i+1}`).join(' and '),values=Object.values(change.keys);
    const actual=(await client.query(`select to_jsonb(t) value from ${change.table} t where ${where} for update`,values)).rows[0]?.value;
    if(!actual) throw new Error('Configuration native target is absent');
    if(repeated){
      for(const [key,value] of Object.entries(change.value)) if(canonicalJson(actual[key])!==canonicalJson(value)) throw new Error('Previously mapped configuration changed; no overwrite allowed');
      continue;
    }
    if(sha256(canonicalJson(actual))!==(change.expected_target_sha256??decision.expected_target_sha256)) throw new Error('Configuration target baseline changed; no overwrite allowed');
    const columns=Object.keys(change.value),offset=values.length;
    await client.query(`update ${change.table} set ${columns.map((k,i)=>`${k}=$${offset+i+1}`).join(',')},row_version=row_version+1,
      updated_by=platform.current_account_id(),updated_at=clock_timestamp() where ${where}`,[...values,...Object.values(change.value)]);
    if(change.table==='platform.control_settings'){
      await client.query(`insert into platform.control_events(control_key,previous_enabled,enabled,actor_account_id,reason,correlation_id)
        values($1,$2,$3,platform.current_account_id(),$4,$5)`,[change.keys.control_key,actual.enabled,change.value.enabled,decision.reason,correlationId]);
    }else{
      const before=Object.fromEntries(columns.map(k=>[k,actual[k]]));
      await client.query(`insert into platform.commercial_catalog_events(resource_kind,product_slug,context,previous_version,new_version,before_value,after_value,actor_account_id,reason,correlation_id)
        values($1,$2,$3,$4::bigint,$4::bigint+1,$5,$6,platform.current_account_id(),$7,$8)`,[decision.action,change.keys.product_slug??change.keys.slug,change.keys.context??null,
        actual.row_version,JSON.stringify(before),JSON.stringify(change.value),decision.reason,correlationId]);
    }
  }
  return {disposition:'mapped',target:typeof decision.target==='string'?decision.target:JSON.stringify(decision.target??decision.controls)};
}
