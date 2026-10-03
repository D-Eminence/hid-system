import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
export function sealConfigurationBaseline(content){
  return {...content,checksum:sha256(canonicalJson(content))};
}
export function validateConfigurationBaseline(baseline){
  const {checksum,...content}=baseline;
  if(baseline.schema!=='hid.configuration-baseline/v1'||!/^[a-f0-9-]{36}$/.test(baseline.parent_run_id??'')
    ||!/^[a-f0-9]{64}$/.test(baseline.parent_source_checksum??'')
    ||!Number.isFinite(Date.parse(baseline.captured_at))||sha256(canonicalJson(content))!==checksum)
    throw new Error('Configuration baseline metadata/checksum is invalid');
  for(const [category,coordinate] of [['products',r=>r.slug],['prices',r=>`${r.product_slug}:${r.context}`],['controls',r=>r.control_key]]){
    const rows=baseline[category];
    if(!Array.isArray(rows)||new Set(rows.map(coordinate)).size!==rows.length
      ||rows.some(r=>!/^[a-f0-9]{64}$/.test(r.sha256??'')
        ||!(/^[a-z][a-z0-9_-]{1,63}(:[a-z][a-z0-9_]{1,63})?$/.test(coordinate(r)))))
      throw new Error('Configuration baseline coordinates are invalid');
  }
  return baseline;
}
export async function collectConfigurationBaseline(client,{parentId,parentChecksum}){
  await client.query('begin isolation level repeatable read read only');
  try{
    const p=(await client.query('select source_system,mode,status,target_checksum_sha256 from migration.runs where id=$1',[parentId])).rows[0];
    if(p?.source_system!=='legacy_identity'||p.mode!=='reconcile'||p.status!=='verified'||p.target_checksum_sha256?.trim()!==parentChecksum)
      throw new Error('Configuration baseline requires the verified parent');
    const products=(await client.query('select to_jsonb(t) value from platform.commercial_products t order by slug')).rows
      .map(({value})=>({slug:value.slug,sha256:sha256(canonicalJson(value))}));
    const prices=(await client.query('select to_jsonb(t) value from platform.commercial_prices t order by product_slug,context')).rows
      .map(({value})=>({product_slug:value.product_slug,context:value.context,sha256:sha256(canonicalJson(value))}));
    const controls=(await client.query('select to_jsonb(t) value from platform.control_settings t order by control_key')).rows
      .map(({value})=>({control_key:value.control_key,sha256:sha256(canonicalJson(value))}));
    const baseline=validateConfigurationBaseline(sealConfigurationBaseline({schema:'hid.configuration-baseline/v1',
      parent_run_id:parentId,parent_source_checksum:parentChecksum,captured_at:new Date().toISOString(),products,prices,controls}));
    await client.query('commit');return baseline;
  }catch(error){await client.query('rollback');throw error;}
}
