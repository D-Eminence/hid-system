import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {platformControlKeys} from '@hid/api-client';
import {PlatformControls} from './PlatformControls';
import {api} from './api';
vi.mock('./api',()=>({api:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const rows=()=>platformControlKeys.map(controlKey=>({controlKey,enabled:true,version:7,reason:'Synthetic last change',updatedAt:'2026-01-01T00:00:00Z'}));
describe('Platform controls',()=>{
  it('allows readers to see six controls but never offers a write action',async()=>{
    vi.mocked(api).mockResolvedValue(rows());render(<PlatformControls canManage={false}/>);
    expect(await screen.findByText('You have read access to platform controls.')).toBeTruthy();
    await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(6));
    for(const input of screen.getAllByRole('checkbox'))expect(input).toBeDisabled();
    expect(screen.queryByRole('button',{name:'Save controls'})).toBeNull();
    expect(api).toHaveBeenCalledWith('/admin/controls',expect.any(Object));
    expect(screen.getByText(/signup.*unavailable here/i)).toBeTruthy();
  });
  it('sends the original version and only the changed provider control',async()=>{
    const next=rows().map(row=>row.controlKey==='provider_portal_enabled'?{...row,enabled:false,version:8}:row);
    vi.mocked(api).mockResolvedValueOnce(rows()).mockResolvedValueOnce({controlKey:'provider_portal_enabled',enabled:false,version:8}).mockResolvedValueOnce(next);
    render(<PlatformControls canManage/>);
    const provider=await screen.findByRole('checkbox',{name:/Provider portals/});
    await waitFor(()=>expect(provider).not.toBeDisabled());fireEvent.click(provider);
    fireEvent.change(screen.getByRole('textbox',{name:'Reason for changes'}),{target:{value:'Approved synthetic maintenance'}});
    fireEvent.click(screen.getByRole('button',{name:'Save controls'}));
    expect(await screen.findByRole('status')).toHaveTextContent('saved');
    expect(api).toHaveBeenNthCalledWith(2,'/admin/controls',{method:'POST',version:7,
      body:{controlKey:'provider_portal_enabled',enabled:false,reason:'Approved synthetic maintenance'}});
    expect(api).toHaveBeenCalledTimes(3);
  });
  it('a conflicting write removes stale controls and requires a fresh read',async()=>{
    vi.mocked(api).mockResolvedValueOnce(rows()).mockRejectedValueOnce(new Error('The resource changed.'));
    render(<PlatformControls canManage/>);
    const uploads=await screen.findByRole('checkbox',{name:/File uploads/});
    await waitFor(()=>expect(uploads).not.toBeDisabled());fireEvent.click(uploads);
    fireEvent.change(screen.getByRole('textbox',{name:'Reason for changes'}),{target:{value:'Approved synthetic pause'}});
    fireEvent.click(screen.getByRole('button',{name:'Save controls'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload controls');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);expect(screen.getByRole('button',{name:'Save controls'})).toBeDisabled();
    expect(api).toHaveBeenCalledTimes(2);
  });
});
