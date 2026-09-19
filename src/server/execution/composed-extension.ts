import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const STAGEHAND_ARCHIVE_SHA256 = "8efc7d171a625cca95c02d02d369b59435fae776cae6c7dd2f6fe72eb19785c0";
export const COMPOSED_POLICY_VERSION = "native-public-v1";
const maximumBytes = 4 * 1024 * 1024;
const names = [
  "blank.html", "content-script.js", "manifest.json",
  "offscreen/service-worker-heartbeat.html", "offscreen/service-worker-heartbeat.js",
  "service-worker.js", "wake-service-worker.html", "wake-service-worker.js",
];
const vendorManifest = {
  manifest_version: 3, name: "Stagehand Runtime", minimum_chrome_version: "116",
  permissions: ["debugger", "offscreen", "scripting", "tabs"],
  host_permissions: ["<all_urls>"],
  background: { service_worker: "service-worker.js", type: "module" },
  content_scripts: [{
    matches: ["<all_urls>"], js: ["content-script.js"], run_at: "document_start",
    all_frames: true, world: "ISOLATED", match_about_blank: true, match_origin_as_fallback: true,
  }],
  options_page: "wake-service-worker.html", version: "1.0.2",
};
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function boundedFile(path: URL, maximum = maximumBytes): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("extension_input_rejected");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new Error("extension_input_changed");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/** Only the audited, exact pinned archive is parsed, never a caller-supplied ZIP. */
export function readPinnedStagehandArchive(archive: Buffer): Map<string, Buffer> {
  if (archive.length > maximumBytes || sha256(archive) !== STAGEHAND_ARCHIVE_SHA256) {
    throw new Error("stagehand_archive_identity_rejected");
  }
  const end = archive.length - 22;
  if (archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt32LE(end + 4) !== 0
    || archive.readUInt16LE(end + 8) !== names.length || archive.readUInt16LE(end + 10) !== names.length
    || archive.readUInt16LE(end + 20) !== 0) throw new Error("stagehand_archive_shape_rejected");
  const directory = archive.readUInt32LE(end + 16);
  if (directory + archive.readUInt32LE(end + 12) !== end) throw new Error("stagehand_archive_shape_rejected");
  const files = new Map<string, Buffer>();
  let cursor = directory;
  let expanded = 0;
  for (let index = 0; index < names.length; index++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("stagehand_archive_shape_rejected");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const mode = archive.readUInt32LE(cursor + 38) >>> 16;
    const local = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    expanded += size;
    if (!names.includes(name) || files.has(name) || (flags & ~0x800) !== 0
      || ![0, 8].includes(method) || expanded > maximumBytes || (mode & 0xf000) === 0xa000
      || archive.readUInt16LE(cursor + 34) !== 0
      || archive.readUInt32LE(local) !== 0x04034b50
      || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method
      || archive.readUInt32LE(local + 14) !== checksum
      || archive.readUInt32LE(local + 18) !== compressedSize || archive.readUInt32LE(local + 22) !== size
      || archive.readUInt16LE(local + 26) !== nameLength
      || archive.subarray(local + 30, local + 30 + nameLength).toString("utf8") !== name) {
      throw new Error("stagehand_archive_entry_rejected");
    }
    const start = local + 30 + nameLength + archive.readUInt16LE(local + 28);
    if (start + compressedSize > directory) throw new Error("stagehand_archive_entry_rejected");
    const compressed = archive.subarray(start, start + compressedSize);
    const bytes = method === 0 ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: maximumBytes });
    if (bytes.length !== size || crc32(bytes) !== checksum) throw new Error("stagehand_archive_entry_rejected");
    files.set(name, bytes);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) throw new Error("stagehand_archive_shape_rejected");
  return files;
}

function deterministicZip(files: ReadonlyMap<string, Buffer>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const filename = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x0314, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(0o100644 * 65536, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...local, directory, end]);
  if (result.length > maximumBytes) throw new Error("composed_extension_size_rejected");
  return result;
}

export async function buildComposedExtension() {
  const base = new URL(".", import.meta.resolve("@browserbasehq/stagehand"));
  const [archive, license, policy, bootstrap, candidateManifest] = await Promise.all([
    boundedFile(new URL("assets/stagehand-extension.zip", base)),
    boundedFile(new URL("../LICENSE", base), 16 * 1024),
    boundedFile(new URL("./native-policy-extension/policy.js", import.meta.url), 64 * 1024),
    boundedFile(new URL("./native-policy-extension/composed.js", import.meta.url), 64 * 1024),
    boundedFile(new URL("./native-policy-extension/manifest.json", import.meta.url), 16 * 1024),
  ]);
  const files = readPinnedStagehandArchive(archive);
  const manifest: unknown = JSON.parse(files.get("manifest.json")!.toString("utf8"));
  if (JSON.stringify(manifest) !== JSON.stringify(vendorManifest)
    || !license.toString("utf8").startsWith("MIT License\n")) throw new Error("stagehand_manifest_rejected");
  files.set("manifest.json", Buffer.from(JSON.stringify({
    ...vendorManifest, permissions: [...vendorManifest.permissions, "proxy", "privacy"],
  }, null, 2) + "\n"));
  files.set("service-worker.js", Buffer.concat([
    files.get("service-worker.js")!, Buffer.from('\nimport "./flash-flood/composed.js";\n'),
  ]));
  files.set("flash-flood/policy.js", policy);
  files.set("flash-flood/composed.js", bootstrap);
  files.set("LICENSE.stagehand", license);
  const provenance = {
    policyVersion: COMPOSED_POLICY_VERSION, stagehandVersion: "4.1.0",
    vendorArchiveSha256: STAGEHAND_ARCHIVE_SHA256,
    licenseSha256: sha256(license), policySha256: sha256(policy),
    bootstrapSha256: sha256(bootstrap), candidateManifestSha256: sha256(candidateManifest),
    modification: "Added proxy/privacy permissions and debugger-only deferred policy module; vendor root worker retained.",
  };
  files.set("flash-flood/provenance.json", Buffer.from(JSON.stringify(provenance, null, 2) + "\n"));
  const bytes = deterministicZip(files);
  return { bytes, sha256: sha256(bytes), provenance, files };
}

export const pinnedStagehandArchivePath = () => fileURLToPath(
  new URL("./assets/stagehand-extension.zip", import.meta.resolve("@browserbasehq/stagehand")),
);
