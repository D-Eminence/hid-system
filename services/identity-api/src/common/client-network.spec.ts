import { publicClientNetwork, quotaNetwork } from './client-network';

describe('public client network (IP-1)', () => {
  const production = (TRUST_PROXY_CIDRS?: string) => ({ NODE_ENV: 'production' as const, TRUST_PROXY_CIDRS });

  it('keys IPv4 by address and IPv6 by its /64, as quotaNetwork', () => {
    expect(quotaNetwork('203.0.113.44')).toBe('203.0.113.44');
    expect(quotaNetwork('::ffff:203.0.113.44')).toBe('203.0.113.44');
    expect(quotaNetwork('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    for (const environment of [production('10.40.0.0/16'), { NODE_ENV: 'test' as const, TRUST_PROXY_CIDRS: undefined }]) {
      expect(publicClientNetwork('203.0.113.44', environment)).toBe('203.0.113.44');
      expect(publicClientNetwork('2001:db8:1:2::9', environment)).toBe('2001:db8:1:2::/64');
      expect(publicClientNetwork('2001:db8:1:2:ffff::1', environment)).toBe('2001:db8:1:2::/64');
    }
  });

  it('has no network for a missing or non-IP address in any environment', () => {
    for (const environment of [production('10.40.0.0/16'), { NODE_ENV: 'development' as const, TRUST_PROXY_CIDRS: undefined }]) {
      for (const value of [undefined, '', 'localhost', '203.0.113.256', '2001:db8::1::2', '198.51.100.1, 10.40.0.9']) {
        expect(publicClientNetwork(value, environment)).toBeNull();
      }
    }
  });

  it('in production refuses every address of a trusted proxy range, in each notation', () => {
    const environment = production('10.40.0.0/16, 192.0.2.7,2001:db8:ffff::/48');
    for (const value of ['10.40.0.1', '10.40.255.254', '::ffff:10.40.3.4', '0:0:0:0:0:ffff:a28:304', '192.0.2.7',
      '2001:db8:ffff:1::5', '2001:db8:ffff:1::5%eth0']) {
      expect(publicClientNetwork(value, environment)).toBeNull();
    }
    for (const value of ['10.41.0.1', '192.0.2.8', '2001:db8:fffe::1']) {
      expect(publicClientNetwork(value, environment)).not.toBeNull();
    }
  });

  it('in production fails closed without a usable proxy list', () => {
    for (const cidrs of [undefined, '', 'not-a-cidr', '10.40.0.0/16/1']) {
      expect(publicClientNetwork('203.0.113.44', production(cidrs))).toBeNull();
    }
  });

  it('outside production treats a private address as an ordinary client (local runs)', () => {
    expect(publicClientNetwork('10.40.1.10', { NODE_ENV: 'development', TRUST_PROXY_CIDRS: '10.40.0.0/16' })).toBe('10.40.1.10');
    expect(publicClientNetwork('127.0.0.1', { NODE_ENV: 'test', TRUST_PROXY_CIDRS: undefined })).toBe('127.0.0.1');
  });
});
