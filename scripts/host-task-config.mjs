/** Local setup only: no credentials, cloud registration, downloads or personal Codex configuration.
 * node --experimental-transform-types scripts/host-task-config.mjs <config.json> <codex-binary> <project> [node-binary]
 * Refuses to overwrite a policy. Changing projects later uses the App's local chooser.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CODEX_TASK_VERSION, loadTaskPolicy } from "../electron/host-task-runtime.ts";
import { HOST_TASK_CANCELLATION } from "../src/host/host-task-protocol.ts";

/** Pin the Node installation and its non-system library directories, not the Homebrew prefix.
 * The returned paths are reviewable local policy, never additions supplied by a remote job.
 */
export function nodeToolchain(binary) {
  const node = realpathSync(binary);
  if (!node.endsWith("/bin/node")) throw new Error("Select an installed Node binary in a bin directory");
  const root = dirname(dirname(node));
  if (["/", "/usr", "/usr/local", "/opt/homebrew"].includes(root)) throw new Error("Select a versioned Node installation; refusing an entire system/package-manager prefix");
  const paths = new Set([root]), visited = new Set();
  const visit = (file, inheritedRpaths = []) => {
    if (visited.has(file)) return;
    visited.add(file);
    if (visited.size > 64) throw new Error("Node toolchain dependency limit exceeded");
    const expand = value => value.replace(/^@loader_path(?=\/|$)/, dirname(file)).replace(/^@executable_path(?=\/|$)/, dirname(node));
    const headers = execFileSync("/usr/bin/otool", ["-l", file], { encoding: "utf8", timeout: 5000 });
    const rpaths = [...headers.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)].map(match => expand(match[1])).concat(inheritedRpaths);
    const libraries = execFileSync("/usr/bin/otool", ["-L", file], { encoding: "utf8", timeout: 5000 }).split("\n").slice(1);
    for (const line of libraries) {
      const library = line.trim().split(" (compatibility version", 1)[0];
      if (!library || library.startsWith("/usr/lib/") || library.startsWith("/System/")) continue;
      const candidates = library.startsWith("@rpath/") ? rpaths.filter(path => path.startsWith("/")).map(path => resolve(path, library.slice(7))) : [expand(library)];
      const target = candidates.find(path => path.startsWith("/") && existsSync(path));
      if (!target) throw new Error(`Unresolved toolchain dependency: ${library}`);
      const resolved = realpathSync(target);
      paths.add(dirname(resolved)); visit(resolved, rpaths);
    }
  };
  visit(node);
  return { toolchainReadPaths: [...paths].sort(), toolchainBinPaths: [dirname(node)], nodeBinary: node,
    toolchainLibraryPaths: [...paths].filter(path => path !== root).sort() };
}

export function taskConfig(runtimePath, roots, nodeBinary) {
  const binary = realpathSync(runtimePath);
  return { enabled: true, cancellation: HOST_TASK_CANCELLATION, deviceId: randomUUID(), roots: roots.map(root => realpathSync(root)),
    runtimeVersion: CODEX_TASK_VERSION, runtimePath: binary, runtimeSha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    ...(nodeBinary ? nodeToolchain(nodeBinary) : { toolchainReadPaths: [], toolchainBinPaths: [] }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== "darwin") throw new Error("Mac task setup requires macOS");
  const [config, runtime, project, nodeBinary] = process.argv.slice(2);
  if (!config || !runtime || !project) throw new Error("Supply config path, Codex binary and local project");
  const data = taskConfig(runtime, [project], nodeBinary);
  mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
  writeFileSync(config, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const policy = loadTaskPolicy(config);
  console.log(JSON.stringify({ config, roots: policy.capabilities.roots, toolchainReadPaths: policy.capabilities.toolchainReadPaths,
    cancellation: HOST_TASK_CANCELLATION, receipts: join(policy.storage, "results") }, null, 2));
}
