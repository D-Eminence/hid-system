import { invokeApiFunction } from '../../../lib/functionApi'
import {
  fetchWithTimeout,
  HidRequestTimeoutError,
} from '../../../../../../packages/api-client/src/index'

async function command<T>(action:string,payload:Record<string,unknown>):Promise<T>{
  const result=await invokeApiFunction<{data:T}>(
    'migration-capture',
    {method:'POST',body:{action,...payload}},
    'The capture operation could not be completed right now.',
  )
  return result.data
}

export async function sha256Hex(file:File){
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer())
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('')
}

export const startCaptureSession=(project_id:string,client_session_id:string,device_id:string)=>
  command<{id:string}>('start_session',{project_id,client_session_id,device_id})
export const createCaptureFolder=(project_id:string,scan_session_id:string,folder_reference:string)=>
  command<{folder:{id:string};document:{id:string}}>('create_folder',{project_id,scan_session_id,folder_reference})

export async function uploadCapturePage(project_id:string,folderId:string,documentId:string,file:File){
  const signed=await command<{asset:{id:string};path:string;signed_url:string;token:string}>('sign_upload',{
    project_id,source_folder_id:folderId,source_document_id:documentId,file_name:file.name,
    mime_type:file.type,size_bytes:file.size,sha256_hex:await sha256Hex(file),
  })
  let upload:Response
  try{
    upload=await fetchWithTimeout(signed.signed_url,{
      method:'PUT',
      headers:{'Content-Type':file.type||'application/octet-stream'},
      body:file,
      credentials:'omit',
    },60000)
  }catch(error){
    if(error instanceof HidRequestTimeoutError){
      throw new Error('The captured file upload took too long. Please try again.')
    }
    throw error
  }
  if(!upload.ok)throw new Error('The captured file could not be uploaded right now. Please try again.')
  return command<{id:string;status:string}>('complete_upload',{project_id,asset_id:signed.asset.id})
}

export const finishCaptureFolder=(project_id:string,source_folder_id:string)=>
  command<{id:string;status:string}>('finish_folder',{project_id,source_folder_id})
