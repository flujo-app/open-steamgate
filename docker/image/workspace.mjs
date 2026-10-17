// Optional durable development workspace. Source, inactive copies, generations
// and their exact compiler travel together; a database volume alone is not one.
import {cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync} from "node:fs";
import {createHash, randomUUID} from "node:crypto";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const MARKER = ".osd-workspace.json";
const ROOTS = ["src", "gen", "data", "webapp", "test", "tools", "bin", "scripts", "docker/image", "packs",
  "abap_transpile.json", "abaplint.jsonc", "libs.lock.json", "package.json", "package-lock.json", "LICENSE",
  "node_modules", ".local/lars", "build", "output", "release.json", "image-licenses.json",
  "workbench-overlay.json", "workbench-preflight.json"];
const contains = (parent, child) => child === parent || child.startsWith(parent + sep);
const canonical = path => existsSync(path) ? realpathSync(path) : join(canonical(dirname(path)), relative(dirname(path), path));

export function seedWorkspace(imageRoot, target, {nodeMajor = process.versions.node.split(".")[0]} = {}) {
  imageRoot = resolve(imageRoot);
  if (!isAbsolute(target)) throw new Error("OSD_WORKSPACE must be an absolute path on persistent storage");
  target = resolve(target);
  const realImage = canonical(imageRoot), realTarget = canonical(target);
  if (target === dirname(target) || contains(realImage, realTarget) || contains(realTarget, realImage)) {
    throw new Error("OSD_WORKSPACE must be separate from the image directory");
  }
  const live = readlinkSync(join(imageRoot, "build/live")).replaceAll("\\", "/");
  if (!/^by-input\/[a-f0-9]{16}$/.test(live)) throw new Error("Image has no valid serving generation");
  const identity = createHash("sha256");
  for (const name of ["release.json", "libs.lock.json", "package-lock.json", "workbench-overlay.json"]) {
    if (existsSync(join(imageRoot, name))) identity.update(name).update(readFileSync(join(imageRoot, name)));
  }
  identity.update(live);
  const seed = identity.digest("hex");
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error("OSD_WORKSPACE must be a real directory");
    let saved;
    try { saved = JSON.parse(readFileSync(join(target, MARKER), "utf8")); }
    catch { throw new Error("Existing OSD_WORKSPACE has no valid seed marker; it was not changed"); }
    if (saved.version !== 1 || saved.seed !== seed || saved.nodeMajor !== nodeMajor) {
      throw new Error("OSD_WORKSPACE belongs to another image/toolchain. Use that image or migrate a copy; existing source was not changed");
    }
    return {root: target, created: false, seed};
  }
  mkdirSync(dirname(target), {recursive: true});
  const stage = `${target}.seed-${randomUUID()}`;
  mkdirSync(stage);
  // A failed copy remains beside the target for diagnosis/explicit cleanup.
  // Nothing partially initialized is ever selected as a running workspace.
  for (const name of ROOTS) {
    const source = join(imageRoot, name);
    if (!existsSync(source)) continue;
    const destination = join(stage, name);
    mkdirSync(dirname(destination), {recursive: true});
    cpSync(source, destination, {recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false});
  }
  writeFileSync(join(stage, MARKER), JSON.stringify({version: 1, seed, nodeMajor, generation: live,
    createdAt: new Date().toISOString()}, null, 2) + "\n", {flag: "wx"});
  renameSync(stage, target);
  return {root: target, created: true, seed};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const imageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const workspace = process.env.OSD_WORKSPACE;
  const result = workspace ? seedWorkspace(imageRoot, workspace) : {root: imageRoot, created: false};
  process.chdir(result.root);
  if (workspace) console.log(`OSD persistent workspace: ${result.created ? "initialized" : "reused"} ${result.root}`);
  await import(pathToFileURL(join(result.root, "docker/image/entrypoint.mjs")).href);
}
