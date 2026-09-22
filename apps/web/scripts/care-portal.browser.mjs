// Source-only browser proof using explicit synthetic API fixtures. Never contacts staging.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
class CdpSession {
  constructor(url) {
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.socket = new WebSocket(url)
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  waitFor(method, timeoutMilliseconds = 15_000) {
    return new Promise((resolve, reject) => {
      const listeners = this.listeners.get(method) ?? []
      const timeout = setTimeout(() => {
        const index = listeners.indexOf(onEvent)
        if (index >= 0) listeners.splice(index, 1)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMilliseconds)
      const onEvent = value => {
        clearTimeout(timeout)
        const index = listeners.indexOf(onEvent)
        if (index >= 0) listeners.splice(index, 1)
        resolve(value)
      }
      listeners.push(onEvent)
      this.listeners.set(method, listeners)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

const fixture = `(() => {
  const id = n => n + '0000000-0000-4000-8000-000000000001';
  const s = window.__careFixture = { mode: null, calls: [], denied: false, auditFailure: false, leaseMs: 60000 };
  const patient = {patientId:id(2),hid:'HID-ABCDEFGH',firstName:'Synthetic',lastName:'Patient',fullName:'Synthetic Patient',dateOfBirth:'1990-01-01',gender:'female',country:'NG',state:'Lagos',version:1};
  const actor = () => ({subject:s.mode+':synthetic',accountId:id(1),kind:s.mode,patientId:s.mode==='patient'?id(2):undefined,email:'synthetic@example.invalid',displayName:'Synthetic Clinician',roles:s.mode==='patient'?[]:['doctor'],permissions:[],facilities:s.mode==='patient'?[]:[{id:id(3),membershipId:id(4),organizationId:id(5),name:'Synthetic Facility',roles:['doctor'],permissions:['identity.break-glass.write','identity.consent.write','identity.registration.write','identity.registration.approve'],isPrimary:true}]});
  const records = { encounters:[],notes:[{id:id(6),encounterId:id(7),facilityId:id(3),noteType:'progress',title:'Synthetic released note',status:'signed',revisionNo:1,content:'Synthetic clinical summary',signedAt:'2026-09-01T10:00:00Z'}],limit:50 };
  const respond=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','x-csrf-token':'synthetic-csrf'}}));
  window.fetch = (url,init={}) => {
    const p=new URL(typeof url==='string'?url:url.url,location.href).pathname;
    if (!p.startsWith('/api/v1/')) return Promise.reject(new Error('External fetch blocked by source fixture'));
    s.calls.push({path:p,method:init.method||'GET',headers:Object.fromEntries(new Headers(init.headers)),body:init.body?JSON.parse(init.body):null});
    if(p.includes('/functions/')) return respond({detail:'Legacy request forbidden'},500);
    if(p.endsWith('/auth/patient/login')||p.endsWith('/auth/login')) { s.mode=p.endsWith('/patient/login')?'patient':'staff';return respond({actor:actor(),expiresAt:new Date(Date.now()+60000).toISOString()}); }
    if(p.endsWith('/auth/session')) return s.mode?respond({actor:actor()}):respond({detail:'Please sign in again.'},401);
    if(p.endsWith('/auth/logout')){s.mode=null;return respond({signedOut:true});}
    if(p.endsWith('/auth/otp/start'))return respond({accepted:true,challengeId:id(8),deliveryChannels:['email'],expiresInSeconds:300,resendAfterSeconds:0},202);
    if(p.endsWith('/auth/otp/verify'))return JSON.parse(init.body).code==='123456'?respond({verified:true,challengeId:id(8),verificationToken:'synthetic-verification'}):respond({detail:'Code expired or invalid'},400);
    if(p.endsWith('/auth/otp/complete'))return respond({completed:true});
    if(p.endsWith('/identity/registration-capabilities'))return respond({nin:{enabled:false,state:'deferred'},newPatientRegistrationRequiresNin:true});
    if(p==='/api/v1/identity/me')return s.mode==='patient'?respond(patient):respond({detail:'Please sign in again.'},401);
    if(p==='/api/v1/ehr/me/records')return s.mode==='patient'?respond(records):respond({detail:'Please sign in again.'},401);
    if(p.endsWith('/me/access-history'))return respond({items:[{consentGrantId:id(9),scope:'break_glass',purpose:'emergency',status:'expired',startsAt:'2026-09-01T09:00:00Z',expiresAt:'2026-09-01T10:00:00Z',reason:'Synthetic emergency care',facilityName:'Synthetic Facility'}]});
    if(p.endsWith('/identity/break-glass')) { if(s.auditFailure)return respond({detail:'Audit recording unavailable'},503);s.denied=false;return respond({accessRequestId:id(8),consentGrantId:id(9),patientId:id(2),status:'active',expiresAt:new Date(Date.now()+s.leaseMs).toISOString(),existingGrant:false}); }
    if(p.endsWith('/emergency-records'))return s.denied?respond({detail:'Emergency access revoked'},403):respond(records);
    if(p.endsWith('/close')){s.denied=true;return respond({consentGrantId:id(9),patientId:id(2),status:'revoked',closedAt:new Date().toISOString(),alreadyClosed:false});}
    return respond({detail:'Unexpected fixture path '+p},500);
  };
})()`
const temp = await mkdtemp(path.join(tmpdir(),'hid-care-browser-'))
let chrome, session
const server = createServer(async (req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname)
    const root=path.resolve('dist'), target=path.resolve(root,'.'+pathname)
    if(!target.startsWith(root+path.sep)&&target!==root){res.writeHead(404);res.end();return}
    let file=target
    try{if(!(await stat(file)).isFile())file=path.join(root,'index.html')}catch{file=path.join(root,'index.html')}
    const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2'}
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await readFile(file))
  }catch{res.writeHead(500);res.end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`
const checks=[]
try{
  chrome=spawn(process.env.CHROME_BIN||'google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check',`--user-data-dir=${temp}`,'--remote-debugging-port=0','about:blank'],{stdio:'ignore'})
  let debugPort
  for(let i=0;i<100;i++){try{debugPort=Number((await readFile(path.join(temp,'DevToolsActivePort'),'utf8')).split('\n')[0]);break}catch{await delay(100)}}
  assert.ok(debugPort,'Chrome did not start')
  const target=await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'})).json()
  session=new CdpSession(target.webSocketDebuggerUrl);await session.connect();await session.send('Page.enable');await session.send('Runtime.enable')
  await session.send('Network.enable');await session.send('Network.setBlockedURLs',{urls:['https://*','http://*.com/*']})
  await session.send('Page.addScriptToEvaluateOnNewDocument',{source:fixture})
  async function waitText(text){for(let i=0;i<100;i++){if(await session.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`))return;await delay(100)}throw new Error('Missing UI text: '+text+'; body: '+await session.evaluate('document.body.innerText'))}
  async function click(text){await session.evaluate(`(()=>{const e=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('missing button');e.click()})()`);await delay(150)}
  async function fill(selector,value){await session.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing input');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
  async function visit(route){await session.send('Page.navigate',{url:origin+route});await delay(250)}
  async function noLegacy(){assert.equal(await session.evaluate(`window.__careFixture.calls.some(x=>x.path.includes('/functions/'))`),false)}
  await visit('/patient');await waitText('Sign in')
  await fill('input[type=email]','synthetic@example.invalid');await fill('input[type=password]','synthetic-password');await click('Sign in');await waitText('HID-ABCDEFGH')
  await click('My records');await waitText('Synthetic released note');await click('Access history');await waitText('Synthetic emergency care');await click('Access notifications');await waitText('requires facility review')
  await noLegacy();checks.push('patient canonical login/profile/HID/released records/history/notifications')
  await session.evaluate(`window.__careFixture.mode=null;document.dispatchEvent(new Event('visibilitychange'))`);await waitText('Please sign in again.');assert.equal(await session.evaluate(`document.body.innerText.includes('Synthetic emergency care')`),false);checks.push('patient expired session clears medical information')
  await visit('/patient');await waitText('Forgot password or activate an issued account');await click('Forgot password or activate an issued account')
  await fill('input','synthetic@example.invalid');await click('Send recovery code');await waitText('Six-digit code');await fill('input','000000');await click('Verify code');await waitText('Code expired or invalid')
  await fill('input','123456');await click('Verify code');await waitText('Confirm password');await fill('input[type=password]','synthetic-new-password');await fill('input[autocomplete=new-password]:nth-of-type(1)','synthetic-new-password')
  await session.evaluate(`(()=>{const e=document.querySelectorAll('input[type=password]')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'synthetic-new-password');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await click('Save password');await waitText('Password saved. Sign in using your new password.');assert.equal(await session.evaluate('window.__careFixture.mode'),null);await noLegacy();checks.push('OTP invalid code/verify/password completion requires fresh sign-in')
  await visit('/hospital/auth');await waitText('Clinical account');await fill('input[type=email]','clinician@example.invalid');await fill('input[type=password]','synthetic-password');await click('Sign in');await waitText('Activate emergency read access')
  const activate=async()=>{await fill('input[placeholder="HID-ABCDEFGH"]','HID-ABCDEFGH');await fill('textarea','Urgent synthetic clinical care');await click('Activate emergency read access')}
  await activate();await waitText('Synthetic released note');assert.equal(await session.evaluate(`window.__careFixture.calls.find(x=>x.path.endsWith('/emergency-records')).headers['x-purpose-of-use']`),'emergency')
  await session.evaluate(`window.__careFixture.denied=true;document.dispatchEvent(new Event('visibilitychange'))`);await waitText('Emergency access revoked');assert.equal(await session.evaluate(`document.body.innerText.includes('Synthetic released note')`),false)
  await click('Revoke access now');await waitText('Emergency access revoked. Records have been cleared.');checks.push('staff facility/emergency activation/read/revoked denial/revoke')
  await session.evaluate('window.__careFixture.leaseMs=600');await activate();await waitText('Emergency access expired. Records have been cleared.');assert.equal(await session.evaluate(`document.body.innerText.includes('Synthetic released note')`),false);checks.push('emergency expiry timer clears records')
  await session.evaluate('window.__careFixture.auditFailure=true');await activate();await waitText('Audit recording unavailable');assert.equal(await session.evaluate(`document.body.innerText.includes('Synthetic released note')`),false);await noLegacy();checks.push('audit-required denial renders no records')
  await click('Patient registration');await waitText('NIN registration is deferred in staging');
  assert.equal(await session.evaluate(`document.querySelector('input[pattern="[0-9]{11}"]') === null`),true);
  assert.equal(await session.evaluate(`window.__careFixture.calls.some(call => call.path.endsWith('/nin/resolve'))`),false);
  await noLegacy();checks.push('deferred NIN registration displays state without NIN inputs or verification calls')
  console.log(JSON.stringify({status:'PASS',scope:'SOURCE_ONLY_SYNTHETIC_API_FIXTURES',browser:'Google Chrome',checks},null,2))
}finally{
  session?.close();chrome?.kill('SIGTERM');await new Promise(resolve=>server.close(resolve));await delay(500);await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200})
}
