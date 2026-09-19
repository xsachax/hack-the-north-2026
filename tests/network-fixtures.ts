import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { readFile, readlink } from "node:fs/promises";
import { isIP } from "node:net";

export async function verifyNetworkNamespace() {
  assert.equal(process.platform, "linux", "Use the verified Linux namespace launcher");
  const scratch = process.env.NATIVE_POLICY_LINUX_SCRATCH;
  const hostNet = process.env.NATIVE_POLICY_LINUX_HOST_NET;
  const hostMount = process.env.NATIVE_POLICY_LINUX_HOST_MOUNT;
  assert(scratch && hostNet && hostMount, "Namespace launcher is mandatory");
  assert.notEqual(await readlink("/proc/self/ns/net"), hostNet, "Must not use host networking");
  assert.notEqual(await readlink("/proc/self/ns/mnt"), hostMount, "Must not use host mounts");
  assert.equal(await readFile("/etc/resolv.conf", "utf8"), "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n");
  return scratch;
}

function addressBytes(address: string): Buffer {
  if (isIP(address) === 4) return Buffer.from(address.split(".").map(Number));
  assert.equal(isIP(address), 6);
  assert(!address.includes("."), "The fixture does not encode mapped IPv4");
  const [left, right] = address.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words = right === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  const result = Buffer.alloc(16);
  words.forEach((word, index) => result.writeUInt16BE(parseInt(word, 16), index * 2));
  return result;
}

/** Owned, TTL-zero authoritative DNS; bind only after verifyNetworkNamespace. */
export async function ownedDns(options: {
  names: readonly string[];
  addresses: readonly string[];
  /** Runs after constructing an answer, allowing a resolution/socket race control. */
  onAnswer?: (type: number) => void;
}) {
  await verifyNetworkNamespace();
  const socket = createSocket("udp4");
  let addresses = [...options.addresses];
  const answers: string[] = [];
  const questions: { name: string; type: number }[] = [];
  const errors: Error[] = [];
  const names = new Set(options.names);
  socket.on("error", (error) => errors.push(error));
  socket.on("message", (query, remote) => {
    if (query.length < 12 || query.readUInt16BE(4) !== 1 || (query[2] & 0x80)) return;
    let end = 12;
    const labels: string[] = [];
    while (end < query.length && query[end] !== 0) {
      const length = query[end++];
      if (length > 63 || end + length > query.length) return;
      labels.push(query.toString("ascii", end, end + length));
      end += length;
    }
    if (end + 5 > query.length) return;
    const type = query.readUInt16BE(end + 1);
    const name = labels.join(".").toLowerCase();
    const owned = names.has(name) && query.readUInt16BE(end + 3) === 1;
    questions.push({ name, type });
    const selected = owned ? addresses.filter((address) => (type === 1 && isIP(address) === 4) || (type === 28 && isIP(address) === 6)) : [];
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8480 | (query.readUInt16BE(2) & 0x0100) | (owned ? 0 : 3), 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(selected.length, 6);
    const parts: Buffer[] = [header, query.subarray(12, end + 5)];
    for (const address of selected) {
      const bytes = addressBytes(address);
      const record = Buffer.from([0xc0, 0x0c, 0, type, 0, 1, 0, 0, 0, 0, 0, bytes.length]);
      parts.push(record, bytes);
      answers.push(address);
    }
    socket.send(Buffer.concat(parts), remote.port, remote.address, (error) => { if (error) errors.push(error); });
    if (owned) options.onAnswer?.(type);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(53, "127.0.0.1", resolve);
  });
  return {
    answers, questions, errors,
    setAddresses(next: readonly string[]) {
      assert(next.length <= 32 && next.every((address) => isIP(address)));
      addresses = [...next];
    },
    close: () => new Promise<void>((resolve) => socket.close(resolve)),
  };
}
