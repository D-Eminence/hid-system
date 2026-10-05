import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectComponents,componentConfig,components,assertScan} from './staging-backend-build.mjs';
test('frontend-only changes do not build backend images',()=>assert.deepEqual(selectComponents(['apps/web/src/App.tsx']),[]));
test('Novu worker changes select only its image',()=>assert.deepEqual(selectComponents(['services/notification-worker/src/worker.ts']),['notification-worker']));
test('database changes also rebuild the migration runner',()=>assert.deepEqual(selectComponents(['services/ehr-api/database/migrations/0063_example.sql']),['ehr-api','database-migration']));
test('shared client and CI changes select the complete backend matrix',()=>assert.deepEqual(selectComponents(['packages/api-client/src/index.ts']),components));
test('reject unknown/path-injection components',()=>assert.throws(()=>componentConfig('../production')));
test('migration uses the existing EHR repository with the migration target',()=>assert.equal(componentConfig('database-migration').target,'migration'));
test('High/Critical findings and incomplete scan reports block publication',()=>{
  assert.throws(()=>assertScan({matches:[]}));
  assert.throws(()=>assertScan({descriptor:{version:'test'},matches:[{vulnerability:{severity:'High'}}]}));
  assertScan({descriptor:{version:'test'},matches:[]});
});
