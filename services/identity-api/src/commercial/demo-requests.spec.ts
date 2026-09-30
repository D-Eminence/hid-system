import { REQUIRED_PERMISSIONS, PUBLIC_ROUTE } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import * as environment from '../config/environment';
import { AdminDemoRequestsController, PublicDemoRequestsController } from './demo-requests.controller';
import type { CreateDemoRequestDto } from './demo-request.dto';
import { DemoRequestsService } from './demo-requests.service';

const input: CreateDemoRequestDto = {
  contactName: 'Ada Example', contactEmail: 'Ada@Example.Invalid',
  organizationName: 'Example Clinic', productCode: 'ehr',
  turnstileAction: 'book-demo', turnstileToken: 'opaque-proof',
};
const request = {
  correlationId: 'demo-correlation-0001', ip: '203.0.113.1',
  header: jest.fn((name: string) => name === 'origin' ? 'https://www.healthidentitydirectory.com' : undefined),
} as unknown as HidRequest;

describe('commercial demo intake boundary', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requires an allowed origin and a completed Turnstile check before storing a public request', async () => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com',
    } as environment.Environment);
    const submit = jest.fn().mockResolvedValue({ accepted: true, replayed: false });
    const verify = jest.fn().mockResolvedValue(undefined);
    const controller = new PublicDemoRequestsController(
      { submit } as unknown as DemoRequestsService, { verify } as never);
    await expect(controller.submit(input, 'public-demo-key-0001', request)).resolves.toEqual({
      accepted: true, replayed: false,
    });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      action: 'book-demo', origin: 'https://www.healthidentitydirectory.com',
    }));
    expect(submit).toHaveBeenCalledTimes(1);

    const denied = { ...request, header: () => 'https://untrusted.example' } as unknown as HidRequest;
    await expect(controller.submit(input, 'public-demo-key-0002', denied)).rejects.toMatchObject({
      code: 'ORIGIN_DENIED',
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('keeps admin list and state changes behind explicit platform permissions', () => {
    expect(Reflect.getMetadata(PUBLIC_ROUTE, PublicDemoRequestsController.prototype.submit)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, AdminDemoRequestsController.prototype.list))
      .toEqual(['platform.demo.read']);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, AdminDemoRequestsController.prototype.transition))
      .toEqual(['platform.demo.manage']);
  });

  it('deduplicates a public retry and never writes contact details to semantic audit', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    const database = { withSystemTransaction: jest.fn(async (_id, operation) => operation({ query })) };
    const audit = { recordWithClient: jest.fn() };
    const service = new DemoRequestsService(database as never, audit as never);
    await expect(service.submit(input, 'public-demo-key-0001', request)).resolves.toEqual({
      accepted: true, replayed: false,
    });
    await expect(service.submit(input, 'public-demo-key-0001', request)).resolves.toEqual({
      accepted: true, replayed: true,
    });
    expect(query.mock.calls[0]?.[1]?.[3]).toBe('ada@example.invalid');
    expect(query.mock.calls[0]?.[1]?.[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    const event = audit.recordWithClient.mock.calls[0]?.[1];
    expect(JSON.stringify(event)).not.toContain('Ada@Example.Invalid');
    expect(JSON.stringify(event)).not.toContain('Example Clinic');
  });
});
