import {invokeApiFunction} from '../../../lib/functionApi'
export type ProcessingJob={id:string;source_folder_id:string|null;job_type:'security_scan'|'image_process'|'ocr';status:string;provider:string|null;attempt_count:number;max_attempts:number;last_error_code:string|null;last_error_message:string|null;created_at:string}
export type ProcessingFolder={id:string;folder_reference:string;status:string;created_at:string;assets:Array<{id:string;status:string}>}
export async function listProcessing<T>(projectId:string,resource:'jobs'|'folders'|'intelligence'='jobs'){
 return invokeApiFunction<{data:T[];page:{next_cursor:string|null}}>(`migration-processing?project_id=${encodeURIComponent(projectId)}&resource=${resource}&limit=100`,{method:'GET'},'Migration processing information could not be loaded right now.')
}
export async function processingCommand<T>(projectId:string,action:string,payload:Record<string,unknown>){
 const result=await invokeApiFunction<{data:T}>('migration-processing',{method:'POST',body:{project_id:projectId,action,...payload}},'The migration processing action could not be completed right now.');return result.data
}
