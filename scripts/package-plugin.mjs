import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_PACKAGE_PATHS = Object.freeze([
  "assets",
  "ui",
  "backend",
  "src/core",
  "src/ai-tool",
  "src/lib/ai-analysis-prompt.js",
  "src/lib/finding-presentation.js",
  "src/lib/hotspot-presentation.js",
  "src/lib/i18n",
  "src/lib/format.js",
  "src/lib/view-model.js",
]);
const TARGET = "universal";

/**
 * Package the platform-independent Node sidecar and already-built UI. DBX's
 * official CLI currently builds Rust/Go backends; this independent packager
 * stages the complete Node runtime graph and records executable modes in ZIP.
 *
 * @param {{ root?: string, outputDirectory?: string, target?: string }} [options]
 * @returns {Promise<{packagePath: string, metadataPath: string, files: string[]}>}
 */
export async function buildPluginPackage(options = {}) {
  const root = path.resolve(options.root ?? ROOT);
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(root, "dist"));
  const target = options.target ?? process.env.DBX_PLUGIN_TARGET ?? TARGET;
  if (target !== TARGET) {
    throw new Error(`Plan Detective's Node sidecar is platform-independent; target must be "${TARGET}" (received "${target}").`);
  }

  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (!manifest.entrypoints?.backend) throw new Error("manifest.json must declare entrypoints.backend.");
  manifest.entrypoints.backend.executable = `bin/${target}/plan-detective-runtime`;

  const files = new Map();
  putFile(files, "manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  putFile(files, "package.json", Buffer.from('{"type":"module"}\n'));
  for (const relative of REQUIRED_PACKAGE_PATHS) {
    const source = path.join(root, relative);
    const info = await lstat(source).catch((error) => {
      if (error.code === "ENOENT") throw new Error(`Required package input is missing: ${relative}`);
      throw error;
    });
    if (info.isSymbolicLink()) throw new Error(`Package input cannot contain symbolic link ${relative}`);
    await collectPath(files, root, relative);
  }

  const runtimePath = `bin/${target}/plan-detective-runtime`;
  files.set(runtimePath, {
    data: await readFile(path.join(root, "scripts/unix-launcher.sh")),
    mode: 0o100755,
  });
  files.set(`${runtimePath}.bat`, {
    data: await readFile(path.join(root, "scripts/windows-launcher.bat")),
    mode: 0o100644,
  });

  const checksums = Object.fromEntries(
    [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [name, sha256(entry.data)]),
  );
  putFile(files, "checksums.json", Buffer.from(`${JSON.stringify({ algorithm: "sha256", files: checksums }, null, 2)}\n`));

  const packageName = `${manifest.id}-${manifest.version}-${target}.dbxp`;
  const packagePath = path.join(outputDirectory, packageName);
  const metadataPath = packagePath.replace(/\.dbxp$/, ".artifact.json");
  await mkdir(outputDirectory, { recursive: true });
  const packageBytes = createStoredZip(files);
  await writeFile(packagePath, packageBytes);
  await writeFile(metadataPath, `${JSON.stringify({
    target,
    url: packageName,
    sha256: sha256(packageBytes),
    size: packageBytes.length,
  }, null, 2)}\n`);

  return { packagePath, metadataPath, files: [...files.keys()].sort() };
}

async function collectPath(files, root, relative) {
  const source = path.join(root, relative);
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Package input cannot contain symbolic link ${relative}`);
  if (info.isDirectory()) {
    const children = (await readdir(source)).sort();
    for (const child of children) await collectPath(files, root, path.posix.join(relative, child));
    return;
  }
  if (!info.isFile()) throw new Error(`Package input must be a regular file or directory: ${relative}`);
  putFile(files, relative, await readFile(source));
}

function putFile(files, name, data) {
  files.set(name, { data: Buffer.from(data), mode: 0o100644 });
}

function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const entries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right));

  for (const [name, entry] of entries) {
    const filename = Buffer.from(name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, filename, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((entry.mode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

/** Read names, modes and uncompressed contents from this packager's ZIP output. */
export function inspectStoredZip(buffer) {
  const entries = new Map();
  const endOffset = buffer.length - 22;
  if (endOffset < 0 || buffer.readUInt32LE(endOffset) !== 0x06054b50) {
    throw new Error("Invalid stored ZIP: missing end-of-central-directory record.");
  }
  const expectedEntries = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  while (entries.size < expectedEntries && offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
    const mode = buffer.readUInt32LE(offset + 38) >>> 16;
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = buffer.toString("utf8", nameStart, nameStart + filenameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, {
      mode,
      data: buffer.subarray(dataStart, dataStart + compressedSize),
    });
    offset = nameStart + filenameLength + extraLength + commentLength;
  }
  return entries;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildPluginPackage();
  console.log(`Built unsigned candidate ${result.packagePath}`);
  console.log(`Metadata ${result.metadataPath}`);
}
