import { promises as dns } from 'dns';
import net from 'net';
import { config } from '../config.js';

const PRIVATE_IPV4_RANGES = [
  { start: [10, 0, 0, 0], end: [10, 255, 255, 255] },
  { start: [172, 16, 0, 0], end: [172, 31, 255, 255] },
  { start: [192, 168, 0, 0], end: [192, 168, 255, 255] },
  { start: [127, 0, 0, 0], end: [127, 255, 255, 255] },
  { start: [169, 254, 0, 0], end: [169, 254, 255, 255] },
  { start: [0, 0, 0, 0], end: [0, 255, 255, 255] },
];

function ipToBytes(ip: string): number[] | null {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function isIpv4InRange(ip: string, range: { start: number[]; end: number[] }): boolean {
  const bytes = ipToBytes(ip);
  if (!bytes) return false;
  for (let i = 0; i < 4; i += 1) {
    if (bytes[i] < range.start[i]) return false;
    if (bytes[i] > range.end[i]) return false;
  }
  return true;
}

function normalizeIpv4FromIpv6(ip: string): string | null {
  const v4Match = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/i);
  return v4Match ? v4Match[1] : null;
}

function isPrivateIp(ip: string): boolean {
  const v4 = normalizeIpv4FromIpv6(ip) || ip;
  if (net.isIP(v4) === 4) {
    return PRIVATE_IPV4_RANGES.some((range) => isIpv4InRange(v4, range));
  }

  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // Unique local
    if (normalized.startsWith('fe80')) return true; // Link-local
  }

  return false;
}

async function resolvesToPrivateIp(hostname: string): Promise<boolean> {
  try {
    const results = await dns.lookup(hostname, { all: true });
    return results.some((result) => isPrivateIp(result.address));
  } catch {
    return true;
  }
}

export async function isUrlAllowed(url: string): Promise<boolean> {
  if (config.ALLOW_PRIVATE_NETWORK_URLS) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }

  if (net.isIP(hostname)) {
    return !isPrivateIp(hostname);
  }

  return !(await resolvesToPrivateIp(hostname));
}
