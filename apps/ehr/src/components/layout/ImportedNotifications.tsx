import { useEffect, useState } from 'react';
import { identityApi } from '../../api/client';
type Items = Awaited<ReturnType<typeof identityApi.importedNotifications>>;
export function ImportedNotifications({onClose}: {onClose:()=>void}) {
  const [items,setItems]=useState<Items|null>(null),[offset,setOffset]=useState(0),[error,setError]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setItems(null);setError(false);
    void identityApi.importedNotifications(offset,controller.signal).then(value=>{if(!controller.signal.aborted)setItems(value);})
      .catch(()=>{if(!controller.signal.aborted)setError(true);});
    return()=>controller.abort();
  },[offset]);
  return <section aria-label="Earlier notifications"><h2>Earlier notifications</h2><button onClick={onClose}>Close notifications</button>
    {error?<p role="alert">Notifications are unavailable. Try again.</p>:items===null?<p role="status">Loading notifications…</p>
      :items.length===0?<p>No earlier notifications.</p>:items.map(item=><article key={item.id}><h3>{item.title}</h3>
        <p style={{whiteSpace:'pre-wrap'}}>{item.message}</p><p>{new Date(item.createdAt).toLocaleString()} · {item.readAt?'Read':'Unread'}</p>
        {!item.readAt&&<button onClick={()=>{void identityApi.markImportedNotificationRead(item.id).then(result=>setItems(current=>current?.map(row=>row.id===result.id?{...row,readAt:result.readAt}:row)??null)).catch(()=>setError(true));}}>Mark as read</button>}
      </article>)}
    {offset>0&&<button onClick={()=>setOffset(value=>Math.max(0,value-50))}>Newer notifications</button>}
    {items?.length===50&&<button onClick={()=>setOffset(value=>value+50)}>Older notifications</button>}
  </section>;
}
