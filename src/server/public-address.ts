import { isIP } from "node:net";

function ipv4Value(address: string): bigint {
  return address.split(".").reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function ipv6Value(address: string): bigint {
  const [left, right] = address.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups = right === undefined
    ? head
    : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inRange(value: bigint, base: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
}

const blockedV4: readonly [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  // Azure's platform virtual address is not in a private range.
  ["168.63.129.16", 32],
];

/** Shared admission/transport classification, never a development exception. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const value = ipv4Value(address);
    return !blockedV4.some(([base, prefix]) => inRange(value, ipv4Value(base), prefix, 32));
  }
  if (isIP(address) !== 6 || address.includes(".") || address.includes("%")) return false;
  const value = ipv6Value(address);
  // Only global unicast; exclude protocol assignments, documentation and 6to4.
  // This also excludes mapped IPv4, NAT64, local, multicast and reserved space.
  return (
    inRange(value, ipv6Value("2000::"), 3, 128) &&
    !inRange(value, ipv6Value("2001::"), 23, 128) &&
    !inRange(value, ipv6Value("2001:db8::"), 32, 128) &&
    !inRange(value, ipv6Value("2002::"), 16, 128) &&
    !inRange(value, ipv6Value("3ffe::"), 16, 128) &&
    !inRange(value, ipv6Value("3fff::"), 20, 128)
  );
}

export function loopbackAddress(address: string): boolean {
  return (
    (isIP(address) === 4 && inRange(ipv4Value(address), ipv4Value("127.0.0.0"), 8, 32)) ||
    (isIP(address) === 6 && !/[.%]/.test(address) && ipv6Value(address) === 1n)
  );
}
