import { useEffect, useState } from 'react';
import { api } from './api';

interface PreservedConfiguration {
  category: string; source_pk: string; disposition: string; target_reference: string | null;
  value: Record<string, unknown>;
}

export function ImportedConfiguration() {
  const [items,setItems] = useState<PreservedConfiguration[] | null>(null);
  const [error,setError] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{items:PreservedConfiguration[]}>('/admin/imported-configuration')
      .then(value => { if (active) setItems(value.items); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  return <section aria-label="Preserved configuration"><header className="page-head"><h1>Preserved settings</h1>
    <p>Original catalogue, billing, controls, staff policies and AI routing. Only categories your account can read are shown.</p></header>
    <p>Pending settings are saved for review. Mapping target fields does not activate unsupported settings, grant staff permissions or approve AI models.</p>
    {error ? <p role="alert">Preserved settings are unavailable. Please try again.</p> : items === null ? <p role="status">Loading preserved settings…</p>
      : items.length === 0 ? <p>No preserved settings are available for your account.</p>
        : items.map(item => <article className="card" key={`${item.category}:${item.source_pk}`}>
          <h2>{item.category.replaceAll('_',' ')}</h2><p>{item.disposition.replaceAll('-',' ')}{item.target_reference ? ` · ${item.target_reference}` : ''}</p>
          <dl>{Object.entries(item.value).map(([key,value]) => <div key={key}><dt>{key.replaceAll('_',' ')}</dt>
            <dd style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value === null ? 'Not recorded' : typeof value === 'object' ? JSON.stringify(value,null,2) : String(value)}</dd></div>)}</dl>
        </article>)}
  </section>;
}
