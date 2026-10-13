import { BlockList, isIP } from 'node:net';
import type { Environment } from '../config/environment';

/**
 * The address without an IPv6 zone, with IPv4-mapped IPv6 as IPv4, or null
 * for anything that is not an IP address.
 */
function clientAddress(remoteIp: string | undefined): { address: string; family: 4 | 6 } | null {
  if (!remoteIp) return null;
  const address = remoteIp.split('%', 1)[0] ?? '';
  const family = isIP(address);
  if (family === 4) return { address, family };
  if (family !== 6) return null;
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return { address: `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`, family: 4 };
  }
  return { address, family: 6 };
}

/** The eight 16-bit groups of a valid IPv6 address (dotted IPv4 tail allowed). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  return [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing]
    .map((group) => Number.parseInt(group, 16));
}

/**
 * The client network a public, IP-keyed limit is charged to: an IPv4 address,
 * or the /64 prefix of an IPv6 address (one subscriber allocation, so rotating
 * addresses inside it does not reset a limit). IPv4-mapped IPv6 is treated as
 * IPv4. Returns null for anything that is not an IP address.
 */
export function quotaNetwork(remoteIp: string | undefined): string | null {
  const client = clientAddress(remoteIp);
  if (!client) return null;
  if (client.family === 4) return client.address;
  return `${ipv6Groups(client.address).slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

const trustedProxyLists = new Map<string, BlockList | null>();

/** The TRUST_PROXY_CIDRS entries as a BlockList, or null when one does not parse. */
function trustedProxies(cidrs: string): BlockList | null {
  if (trustedProxyLists.has(cidrs)) return trustedProxyLists.get(cidrs)!;
  let list: BlockList | null = new BlockList();
  try {
    for (const entry of cidrs.split(',').map((value) => value.trim())) {
      const [address = '', prefix, extra] = entry.split('/');
      const family = isIP(address);
      if (family === 0 || extra !== undefined) throw new Error('invalid proxy entry');
      const type = family === 6 ? 'ipv6' : 'ipv4';
      if (prefix === undefined) list.addAddress(address, type);
      else list.addSubnet(address, Number(prefix), type);
    }
  } catch {
    list = null;
  }
  trustedProxyLists.set(cidrs, list);
  return list;
}

/**
 * The client network for a public flow's IP-keyed limit, or null when there is
 * no usable client address; callers then answer 503 rather than charge a
 * bucket other clients share.
 *
 * request.ip is the client only when the edge put the client address in the
 * forwarding chain: the Cloudflare Worker sends X-Real-IP, and the
 * gateway's realip module makes it the X-Forwarded-For it sends here. In
 * production an address inside TRUST_PROXY_CIDRS is one of our own proxies
 * (the public load balancer, when that header was missing), shared by every
 * client, so it is refused too. Outside production any address is a client.
 */
export function publicClientNetwork(remoteIp: string | undefined,
  environment: Pick<Environment, 'NODE_ENV' | 'TRUST_PROXY_CIDRS'>): string | null {
  const network = quotaNetwork(remoteIp);
  if (!network || environment.NODE_ENV !== 'production') return network;
  if (!environment.TRUST_PROXY_CIDRS) return null;
  const proxies = trustedProxies(environment.TRUST_PROXY_CIDRS);
  const client = clientAddress(remoteIp)!;
  if (!proxies || proxies.check(client.address, client.family === 6 ? 'ipv6' : 'ipv4')) return null;
  return network;
}
