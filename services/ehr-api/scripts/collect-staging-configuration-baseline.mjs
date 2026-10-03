#!/usr/bin/env node
import pg from 'pg';
import {databaseOptions,managedDatabaseUrl} from './database-options.mjs';
import {collectConfigurationBaseline} from './configuration-baseline.mjs';
async function main(){
  const e=process.env;
  if(e.HID_DEPLOYMENT_ENV!=='staging'||process.argv.length!==2||!/^[a-f0-9-]{36}$/.test(e.MIGRATION_PARENT_RUN_ID??'')
    ||!/^[a-f0-9]{64}$/.test(e.MIGRATION_PARENT_SOURCE_CHECKSUM??'')) throw new Error('Verified staging parent is required');
  const connection=e.DATABASE_URL||managedDatabaseUrl();
  if(connection&&new URL(connection).search) throw new Error('Database URL TLS overrides are not permitted');
  if(!connection||!/^hid-staging-postgres\.[a-z0-9]+\.eu-west-1\.rds\.amazonaws\.com$/.test(new URL(connection).hostname)
    ||!e.DATABASE_SSL_ROOT_CERT_BASE64) throw new Error('Verified private staging database and CA are required');
  const client=new pg.Client(databaseOptions(connection,'hid-configuration-baseline'));
  try{await client.connect();console.log(JSON.stringify(await collectConfigurationBaseline(client,{
    parentId:e.MIGRATION_PARENT_RUN_ID,parentChecksum:e.MIGRATION_PARENT_SOURCE_CHECKSUM})));}
  finally{await client.end();}
}
main().catch(()=>{process.stderr.write('Read-only configuration baseline failed; inspect privately.\n');process.exitCode=1;});
