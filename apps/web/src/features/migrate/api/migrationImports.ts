import{invokeApiFunction}from'../../../lib/functionApi'
export type ImportItem={id:string;source_folder_id:string;status:string;attempt_count:number;target_record_ids:string[];last_error_message:string|null;verified_at:string|null;patient:{hid_code:string;full_name:string}|null}
export type ImportJob={id:string;status:string;idempotency_key:string;total_items:number;succeeded_items:number;failed_items:number;created_at:string;items:ImportItem[]}
export async function listImports(projectId:string){return invokeApiFunction<{data:ImportJob[];page:{next_cursor:string|null}}>(`migration-imports?project_id=${encodeURIComponent(projectId)}`,{method:'GET'},'Migration imports could not be loaded right now.')}
export async function importCommand<T>(projectId:string,action:string,payload:Record<string,unknown>={}){return invokeApiFunction<{data:T}>('migration-imports',{method:'POST',body:{project_id:projectId,action,...payload}},'The migration import action could not be completed right now.')}
