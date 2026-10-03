#!/usr/bin/env node
// Read-only export. Output path must be in a pre-created operator-private folder.
import {writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {databaseOptions} from './database-options.mjs';
import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
import {CUSTOMER_SOURCE_TABLES} from './customer-source-tables.mjs';
import {sealCustomerSource,prepareCustomerSource,ninCoverage} from './customer-data-validation.mjs';
const [output]=process.argv.slice(2),e=process.env;
if(!output||!e.LEGACY_DATABASE_URL||!e.MIGRATION_SNAPSHOT_ID||e.HID_DEPLOYMENT_ENV!=='staging') throw new Error('Staging export requires protected output, source URL and snapshot ID');
if(!(await stat(path.dirname(path.resolve(output)))).isDirectory()) throw new Error('Private output directory is required');
let sourceUrl;
try{sourceUrl=new URL(e.LEGACY_DATABASE_URL);}catch{throw new Error('The source connection URL is invalid; re-enter it privately');}
if(!['postgres:','postgresql:'].includes(sourceUrl.protocol)||!sourceUrl.hostname.endsWith('.supabase.com')
  ||!e.LEGACY_DATABASE_SSL_ROOT_CERT_BASE64) throw new Error('A Supabase source and verified CA certificate are required');
for(const key of ['sslmode','sslcert','sslkey','sslrootcert']) sourceUrl.searchParams.delete(key);
const client=new pg.Client(databaseOptions(sourceUrl.toString(),'hid-readonly-customer-source','LEGACY_DATABASE'));
try{
  await client.connect();await client.query('begin isolation level repeatable read read only');
  await client.query("set local statement_timeout='30s'");
  const transaction=(await client.query('select pg_current_snapshot()::text snapshot')).rows[0].snapshot;
  const tables=(await client.query("select schemaname||'.'||tablename name from pg_tables where schemaname='public' order by tablename")).rows;
  const inventory={};
  for(const {name} of tables){
    if(!/^public\.[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Source table name is unsupported');
    inventory[name]=Number((await client.query(`select count(*)::text n from ${name}`)).rows[0].n);
  }
  const rows=[];
  for(const {table,category,pk} of CUSTOMER_SOURCE_TABLES){
    if(!(table in inventory)) throw new Error('A required source table is absent');
    const values=(await client.query(`select to_jsonb(t)::text payload_json from ${table} t order by to_jsonb(t)->>'${pk}'`)).rows;
    for(const {payload_json} of values){
      const payload=JSON.parse(payload_json,(_key,value)=>{
        if(typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)) throw new Error('A source integer exceeds the exact supported range; preserve its backup and review its representation');
        return value;
      });
      if(payload[pk]==null) throw new Error('A source table primary coordinate is absent; inspect its schema');
      rows.push({entity_type:category,source_pk:String(payload[pk]),payload,payload_sha256:sha256(canonicalJson(payload))});
    }
  }
  const bundle=sealCustomerSource(e.MIGRATION_SNAPSHOT_ID,transaction,inventory,rows);
  prepareCustomerSource(bundle,bundle.checksum);
  const coverage=ninCoverage(rows.filter(r=>r.entity_type==='patients'));
  await client.query('rollback');
  const bytes=Buffer.from(JSON.stringify(bundle));
  await writeFile(output,bytes,{flag:'wx',mode:0o600});
  const stored=await readFile(output);if(sha256(stored)!==sha256(bytes)) throw new Error('Protected export verification failed');
  process.stdout.write(JSON.stringify({snapshot_id:bundle.snapshot_id,size_bytes:bytes.length,sha256:sha256(bytes),source_checksum:bundle.checksum,
    counts:bundle.counts,populated_public_tables:Object.values(inventory).filter(n=>n>0).length,nin_coverage:coverage})+'\n');
}catch(error){
  await client.query('rollback').catch(()=>{});
  // PostgreSQL details can include row values, URLs or PHI. Do not print them.
  process.stderr.write(error.code?'Read-only customer export failed; check source connectivity/schema privately.\n':error.message+'\n');process.exitCode=1;
}finally{await client.end().catch(()=>{});}
