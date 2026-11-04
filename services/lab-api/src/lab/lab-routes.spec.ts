import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA,PATH_METADATA } from '@nestjs/common/constants';
import { AUDIT_ACTION,INTERNAL_CALLER,PUBLIC_ROUTE,REQUIRED_PERMISSIONS } from '../common/decorators';
import { LabAccessionsController } from './lab-accessions.controller';
import { LabExecutionsController } from './lab-executions.controller';
import { LabImportsController } from './lab-imports.controller';
import { LabWorkItemsController } from './lab-work-items.controller';
import { ResultDiscussionsController } from './result-discussions.controller';

type Handler=(...args:never[])=>unknown;
const join=(...parts:string[])=>parts.map(part=>part.replace(/^\/+|\/+$/g,'')).filter(Boolean).join('/');

/** Every Lab API route with the metadata the security guard and audit interceptor read. */
function routes(){
 return ([LabImportsController,LabWorkItemsController,LabAccessionsController,LabExecutionsController,ResultDiscussionsController] as {prototype:object}[]).flatMap(controller=>{
  const base=Reflect.getMetadata(PATH_METADATA,controller) as string;
  return Object.getOwnPropertyNames(controller.prototype).filter(name=>name!=='constructor').map(name=>{
   const handler=(controller.prototype as Record<string,Handler>)[name]!;
   const path=Reflect.getMetadata(PATH_METADATA,handler) as string|undefined;
   return {name,path:path===undefined?undefined:join(base,path),method:Reflect.getMetadata(METHOD_METADATA,handler) as RequestMethod|undefined,
    permissions:(Reflect.getMetadata(REQUIRED_PERMISSIONS,handler) as string[]|undefined)??[],
    audit:Reflect.getMetadata(AUDIT_ACTION,handler) as string|undefined,
    internal:Reflect.getMetadata(INTERNAL_CALLER,handler) as string|undefined,
    isPublic:Reflect.getMetadata(PUBLIC_ROUTE,handler)??Reflect.getMetadata(PUBLIC_ROUTE,controller)};
  }).filter(route=>route.method!==undefined);
 });
}
// The doctor role's Lab permissions (0017, 0018, 0021, 0121). Clinician and nurse hold fewer.
const DOCTOR=['lab.import.read','lab.import.write','lab.work-item.read','lab.work-item.accept','lab.result.released.read','lab.result.discuss'];

describe('Lab route permission inventory',()=>{
 it('serves the released results of an EHR order on one GET route that needs only lab.result.released.read',()=>{
  const byOrder=routes().filter(route=>route.path?.includes(':sourceEhrOrderId'));
  expect(byOrder).toEqual([{name:expect.any(String),path:'lab/ehr-orders/:sourceEhrOrderId/released-results',method:RequestMethod.GET,
   permissions:['lab.result.released.read'],audit:'lab.result.released.list.request',internal:undefined,isPublic:undefined}]);
 });

 it('lets the doctor role read released results by order and by result, and no execution, accession or unreleased value',()=>{
  const reachable=routes().filter(route=>route.method===RequestMethod.GET&&!route.internal&&route.permissions.every(permission=>DOCTOR.includes(permission)));
  expect(reachable.map(route=>route.path).sort()).toEqual(['lab/ehr-orders/:sourceEhrOrderId/released-results','lab/imports/:importId',
   'lab/patients/:patientId/result-discussions','lab/results/:resultId/history','lab/work-items','lab/work-items/:workItemId']);
  for(const route of routes())if(route.permissions.some(permission=>['lab.execution.read','lab.accession.read'].includes(permission)))
   expect(reachable).not.toContainEqual(route);
 });
});

describe('"Discussed with the patient" routes (0121)',()=>{
 it('serves the list, the mark and the withdrawal as browser routes with their permissions and audit actions',()=>{
  const discussion=routes().filter(route=>route.path?.startsWith('lab/patients/:patientId/'));
  expect(discussion.map(({name:_name,...route})=>route).sort((a,b)=>a.path!.localeCompare(b.path!))).toEqual([
   {path:'lab/patients/:patientId/result-discussions',method:RequestMethod.GET,permissions:['lab.result.released.read'],
    audit:'lab.result.discussion.list.request',internal:undefined,isPublic:undefined},
   {path:'lab/patients/:patientId/results/:resultId/discussion',method:RequestMethod.POST,permissions:['lab.result.discuss'],
    audit:'lab.result.discussion.record.request',internal:undefined,isPublic:undefined},
   {path:'lab/patients/:patientId/results/:resultId/discussion/withdrawal',method:RequestMethod.POST,permissions:['lab.result.discuss'],
    audit:'lab.result.discussion.withdraw.request',internal:undefined,isPublic:undefined},
  ]);
 });
});
