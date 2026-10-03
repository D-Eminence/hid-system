import assert from 'node:assert/strict'
import {after,before,test} from 'node:test'
import {createServer} from 'vite'
import {fileURLToPath} from 'node:url'
let server,client,pricing,contract,service
const requests=[],responses=[],originalFetch=globalThis.fetch
before(async()=>{
  server=await createServer({configFile:false,resolve:{alias:{'@hid/api-client':fileURLToPath(new URL('../../../packages/api-client/src/index.ts',import.meta.url))}},server:{middlewareMode:true},appType:'custom'})
  client=await server.ssrLoadModule('/src/lib/identityClient.ts')
  pricing=await server.ssrLoadModule('/src/lib/publicPricingApi.ts')
  contract=await server.ssrLoadModule('/src/lib/platformControlsContract.ts')
  service=await server.ssrLoadModule('/src/services/adminDashboard.ts')
  globalThis.fetch=async(url,init)=>{requests.push({url:String(url),init});assert.ok(responses.length,'Unexpected request');return responses.shift()}
})
after(async()=>{globalThis.fetch=originalFetch;await server?.close()})
const reply=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}})
const rows=()=>contract.platformControlKeys.map(controlKey=>({controlKey,enabled:true,version:3,reason:'Synthetic reason',updatedAt:'2026-01-01T00:00:00.000Z'}))

test('public pricing reads the native route and unwraps its data envelope with cookie transport',async()=>{
  const prices=[{product_slug:'ehr',context:'standalone',visibility:'fixed',amount_minor:12500,currency:'NGN',billing_period:'month',unit:null}]
  responses.push(reply({data:prices}))
  assert.deepEqual(await pricing.fetchPublicPricing(),prices)
  const r=requests.at(-1);assert.equal(r.url,'/api/v1/commercial/pricing');assert.equal(r.init.credentials,'include');assert.equal(r.init.cache,'no-store')
  assert.equal(r.init.headers.has('Authorization'),false)
  responses.push(reply({data:{}}));await assert.rejects(pricing.fetchPublicPricing(),/could not be loaded/)
})
test('native controls preserve hospital/provider mapping, versions and unavailable flags',async()=>{
  responses.push(reply({data:rows()}))
  const controls=await service.fetchAdminPlatformControls({force:true})
  assert.equal(requests.at(-1).url,'/api/v1/admin/controls')
  assert.equal(controls.hospitalPortalEnabled,true);assert.equal(controls.nativeControls[0].version,3)
  for(const key of ['patientSignupEnabled','hospitalSignupEnabled','outreachSignupEnabled','migratePortalEnabled']) assert.equal(controls[key],null)
})
test('controls send only changed keys with If-Match, a reason and captured CSRF',async()=>{
  responses.push(reply({data:{}},200,{'x-csrf-token':'synthetic-csrf'}));await client.canonicalRequest('/api/v1/auth/session')
  const current=rows(),next=rows().map(r=>r.controlKey==='provider_portal_enabled'?{...r,enabled:false,version:4}:r)
  responses.push(reply({data:{controlKey:'provider_portal_enabled',enabled:false,version:4}}),reply({data:next}))
  const before=requests.length
  await contract.createPlatformControlsApi(client.canonicalRequest).save(current,{provider_portal_enabled:false,uploads_enabled:true},'Approved synthetic change')
  assert.equal(requests.length-before,2)
  const r=requests[before];assert.equal(r.url,'/api/v1/admin/controls');assert.equal(r.init.method,'POST')
  assert.equal(r.init.headers.get('If-Match'),'"3"');assert.equal(r.init.headers.get('X-CSRF-Token'),'synthetic-csrf')
  assert.deepEqual(JSON.parse(r.init.body),{controlKey:'provider_portal_enabled',enabled:false,reason:'Approved synthetic change'})
})
test('a conflict stops subsequent writes and forces reload without automatic overwrite',async()=>{
  const calls=[],api=contract.createPlatformControlsApi(async(path,init)=>{calls.push({path,init});throw new Error('Conflict: control changed')})
  await assert.rejects(api.save(rows(),{patient_portal_enabled:false,uploads_enabled:false},'Approved synthetic change'),/Conflict.*Reload/)
  assert.equal(calls.length,1);assert.equal(calls[0].init.headers['If-Match'],'"3"')
})
test('partial saves are reported honestly and do not continue after denial',async()=>{
  let count=0
  const api=contract.createPlatformControlsApi(async()=>{if(count++===0)return {controlKey:'patient_portal_enabled',enabled:false,version:4};throw new Error('Forbidden')})
  await assert.rejects(api.save(rows(),{patient_portal_enabled:false,uploads_enabled:false},'Approved synthetic change'),/Some changes were saved.*Reload/)
  assert.equal(count,2)
})
test('unknown controls, incomplete versions and empty reasons make no write requests',async()=>{
  const api=contract.createPlatformControlsApi(async()=>assert.fail('Invalid control must not be sent'))
  await assert.rejects(api.save(rows(),{patient_signup_enabled:true},'Synthetic reason'),/unavailable/)
  await assert.rejects(api.save(rows().slice(1),{uploads_enabled:false},'Synthetic reason'),/incomplete/)
  await assert.rejects(api.save(rows(),{uploads_enabled:false},''),/change reason/)
})
