import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {ImportedConfiguration} from './ImportedConfiguration';
import {api} from './api';
vi.mock('./api',()=>({api:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('Preserved customer configuration',()=>{
  it('renders the bounded admin response and escapes source text',async()=>{
    vi.mocked(api).mockResolvedValue({items:[{category:'platform_billing_settings',source_pk:'true',disposition:'retained-pending-activation',
      target_reference:null,value:{default_trial_days:14,restriction_policy:'<script>synthetic</script>'}}]});
    const {container}=render(<ImportedConfiguration/>);
    expect(await screen.findByText('platform billing settings')).toBeTruthy();
    expect(screen.getByText('14')).toBeTruthy();expect(screen.getByText('<script>synthetic</script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();expect(api).toHaveBeenCalledWith('/admin/imported-configuration');
  });
  it('shows an honest error when the guarded read fails',async()=>{
    vi.mocked(api).mockRejectedValue(new Error('synthetic failure'));
    render(<ImportedConfiguration/>);expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
  });
});
