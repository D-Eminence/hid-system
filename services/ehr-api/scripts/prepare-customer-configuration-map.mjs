#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {dirname,resolve} from 'node:path';
import {prepareCustomerSource} from './customer-data-validation.mjs';
import {CONFIGURATION_CATEGORIES} from './customer-source-tables.mjs';
import {nativeConfigurationChange} from './customer-configuration-mapping.mjs';
import {validateConfigurationBaseline} from './configuration-baseline.mjs';
import {sha256} from './staging-cutover-additions.mjs';
const controlTargets={patient_portal_enabled:'patient_portal_enabled',hospital_portal_enabled:'provider_portal_enabled',
  outreach_portal_enabled:'outreach_portal_enabled',maintenance_mode:'maintenance_mode',uploads_enabled:'uploads_enabled',break_glass_enabled:'break_glass_enabled'};
export function prepareConfigurationMap(bundle,baseline){
  const sealed=prepareCustomerSource(bundle,bundle.checksum);validateConfigurationBaseline(baseline);
  const products=sealed.grouped.get('commercial_products'),prices=sealed.grouped.get('commercial_prices');
  const entries=[],productDecisions=new Map();
  const retain=(row,reason)=>({category:row.entity_type,source_pk:row.source_pk,source_sha256:row.payload_sha256,action:'retain',reason});
  const exact=(row,decision)=>{
    try{nativeConfigurationChange(row,decision,products);return decision;}
    catch{return retain(row,'Source values have no exact supported target contract; original values remain preserved.');}
  };
  for(const row of products){
    const target=baseline.products.find(p=>p.slug===row.payload.slug);
    const unique=products.filter(p=>p.payload.slug===row.payload.slug).length===1;
    const d=target&&unique?exact(row,{...retain(row,'Import supported product fields; all remaining source fields stay preserved.'),action:'product',
      target:target.slug,expected_target_sha256:target.sha256}):retain(row,'Product target is absent or ambiguous; original values remain preserved.');
    entries.push(d);productDecisions.set(row.source_pk,d);
  }
  for(const row of prices){
    const product=productDecisions.get(row.payload.product_id),slug=product?.target,context=row.payload.context;
    const target=baseline.prices.find(p=>p.product_slug===slug&&p.context===context);
    const unique=prices.filter(p=>productDecisions.get(p.payload.product_id)?.target===slug&&p.payload.context===context).length===1;
    entries.push(product?.action==='product'&&target&&unique?exact(row,{...retain(row,'Import exact product association and supported pricing fields; original values remain preserved.'),
      action:'price',target:{product_slug:slug},expected_target_sha256:target.sha256}):retain(row,'Price target or product association is absent or ambiguous; original values remain preserved.'));
  }
  for(const category of CONFIGURATION_CATEGORIES.filter(c=>!['commercial_products','commercial_prices'].includes(c))){
    for(const row of sealed.grouped.get(category)){
      if(category!=='platform_controls'||sealed.grouped.get(category).length!==1){
        entries.push(retain(row,'No complete native behavior contract exists; original configuration remains preserved.'));continue;
      }
      const keys=Object.keys(controlTargets).filter(k=>typeof row.payload[k]==='boolean'&&baseline.controls.some(t=>t.control_key===controlTargets[k]));
      const expected=Object.fromEntries(keys.map(k=>[controlTargets[k],baseline.controls.find(t=>t.control_key===controlTargets[k]).sha256]));
      entries.push(keys.length?exact(row,{...retain(row,'Import supported portal controls; signup and Migrate flags remain preserved.'),
        action:'control',controls:keys,expected_targets:expected}):retain(row,'No exact supported control target exists; original values remain preserved.'));
    }
  }
  return {schema:'hid.customer-configuration-map-draft/v1',source_checksum:sealed.sourceChecksum,
    parent_run_id:baseline.parent_run_id,parent_source_checksum:baseline.parent_source_checksum,baseline_checksum:baseline.checksum,
    entries,summary:{mapped:entries.filter(e=>e.action!=='retain').length,retained:entries.filter(e=>e.action==='retain').length}};
}
async function main(){
  const [metadataPath,baselinePath,outputPath,approvedBy,actorSubject]=process.argv.slice(2);
  if(!metadataPath||!baselinePath||!outputPath||process.argv.length>7||Boolean(approvedBy)!==Boolean(actorSubject)) throw new Error('Supply source metadata, baseline and a new output path; optional reviewer and existing actor subject together');
  const metadata=JSON.parse(await readFile(metadataPath,'utf8'));
  if(dirname(resolve(outputPath))!==dirname(resolve(metadata.protected_source_path))) throw new Error('Save mapping decisions beside the protected source export');
  const bytes=await readFile(metadata.protected_source_path);
  if(sha256(bytes)!==metadata.sha256) throw new Error('Protected source bytes changed');
  const bundle=JSON.parse(bytes);if(bundle.checksum!==metadata.source_checksum) throw new Error('Protected source checksum differs');
  const plan=prepareConfigurationMap(bundle,JSON.parse(await readFile(baselinePath,'utf8')));
  if(approvedBy){
    if(approvedBy.trim().length<3||!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,127}$/.test(actorSubject)) throw new Error('Reviewer and existing authorized actor are required');
    plan.schema='hid.customer-configuration-map/v1';plan.approved_by=approvedBy.trim();plan.actor_subject=actorSubject;
  }
  await writeFile(outputPath,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({schema:plan.schema,source_checksum:plan.source_checksum,...plan.summary,output_path:outputPath}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{process.stderr.write('Configuration mapping preparation failed; inspect protected inputs privately.\n');process.exitCode=1;});
