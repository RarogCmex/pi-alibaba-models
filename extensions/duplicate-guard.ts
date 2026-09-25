// ── Duplicate-install guard ───────────────────────────────────────────
//
// Two copies of this plugin can be configured at once (e.g. the local fork
// `../../pi-plugins/pi-alibaba-models` AND `npm:pi-alibaba-models`). Both
// factories run and both call `pi.registerProvider("alibaba-cloud", …)`; pi
// resolves the collision with *last registration wins*, so the copy that
// happens to load second silently replaces the other's models — wire format,
// `maxTokens`, base URL and all.
//
// That failure is invisible and expensive. Observed 2026-09-25: a stale npm
// 1.1.1 shadowed the 1.5.1 fork, so `cloudApiFormat: "openai-responses"` was
// ignored and every request went to the Anthropic path at `maxTokens: 8192`.
// pi's Anthropic path splits `max_tokens` into thinking + answer, so at
// `--thinking high` the answer budget collapsed to 1024 tokens and long
// answers were cut mid-sentence ("Response was truncated before completion",
// `stopReason: length`).
//
// The guard therefore runs *before* this copy registers anything and refuses
// to start when another copy is configured. Detection is a pure filesystem
// scan of the same sources pi itself loads from, so it does not depend on the
// other copy cooperating (the stale one is older code and has no guard):
//
//   • user settings `packages`            → ~/.pi/agent/settings.json
//   • project settings `packages`         → <cwd>/.pi/settings.json (trusted)
//   • auto-discovered extension dirs      → <agentDir>/extensions/*, <cwd>/.pi/extensions/*
//   • explicit `-e/--extension` arguments → temporary scope
//
// Every source is resolved the way pi's PackageManager resolves it (npm →
// `npm/node_modules/<name>`, git → `git/<host>/<path>`, local → relative to
// agentDir or `<cwd>/.pi`), symlink-resolved, and deduped, so the same
// directory named two different ways is not a false positive.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_NAME = "pi-alibaba-models";
/** Escape hatch: start anyway (e.g. while intentionally comparing two copies). */
export const GUARD_BYPASS_ENV = "PI_ALIBABA_ALLOW_DUPLICATE";

export interface PluginCopy {
  /** Package source as configured, `auto:<dir>` for discovered dirs, `-e:<arg>` for CLI. */
  source: string;
  scope: string;
  /** Absolute, symlink-resolved package directory. */
  dir: string;
  version?: string;
}

export interface GuardInput {
  agentDir: string;
  cwd: string;
  /** Home directory used to expand `~` in local package paths. Defaults to `os.homedir()`. */
  home?: string;
  /** This copy's own package directory, symlink-resolved. `null` when unknown. */
  selfDir: string | null;
  /**
   * Whether project-local resources are trusted for this run. Omit to let the
   * guard resolve it from `trust.json` / `--approve` / `defaultProjectTrust`.
   */
  trustedProject?: boolean;
  /** Raw CLI arguments, used for `-e` / `--no-extensions` / `--approve`. */
  argv?: string[];
}

// Injected so the scan is testable without touching the real filesystem.
export interface FsLike {
  exists(p: string): boolean;
  readFile(p: string): string | null;
  readdir(p: string): string[] | null;
  realpath(p: string): string | null;
}

export const defaultFs: FsLike = {
  exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  readFile: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
  readdir: (p) => { try { return fs.readdirSync(p); } catch { return null; } },
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
};

const readJsonFile = (io: FsLike, p: string): any | null => {
  const text = io.readFile(p);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
};

const packageSourceString = (pkg: unknown): string => {
  if (typeof pkg === "string") return pkg;
  if (pkg && typeof pkg === "object" && typeof (pkg as any).source === "string") return (pkg as any).source;
  return "";
};

// Object-form packages may set `autoload: false`, which means "load nothing
// unless an explicit resource pattern says so" — such an entry does not
// contribute a second extension factory, so it is not a duplicate.
const packageAutoloadsExtensions = (pkg: unknown): boolean =>
  typeof pkg === "string" ? true : (pkg as any)?.autoload !== false;

/** `@scope/name@1.2.3` → `@scope/name`; `name@^1` → `name`. */
export function npmPackageName(spec: string): string | null {
  const s = spec.trim();
  if (!s) return null;
  if (s.startsWith("@")) {
    const slash = s.indexOf("/");
    if (slash === -1) return null;
    const at = s.indexOf("@", slash);
    return at === -1 ? s : s.slice(0, at);
  }
  const at = s.indexOf("@");
  return at === -1 ? s : s.slice(0, at);
}

/**
 * Split a git package source into pi's on-disk layout components.
 * Handles `git:host/path`, `https://host/path[.git]`, `ssh://user@host:port/path.git@ref`
 * and scp-like `git@host:path`. Returns null for anything that is not a git URL.
 */
export function parseGitSource(source: string): { host: string; path: string } | null {
  const shorthand = source.startsWith("git:");
  let s = shorthand ? source.slice(4) : source;
  if (!s) return null;
  s = s.replace(/\.git@[^/]*$/, ".git"); // drop a pinned ref after .git

  let host: string;
  let rest: string;
  const url = s.match(/^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
  if (url) {
    host = url[1];
    rest = url[2];
  } else {
    const scp = s.match(/^(?:[^@/]+@)?([^/:@]+):(.+)$/);
    if (scp) {
      host = scp[1];
      rest = scp[2];
      // `c:/src` is a Windows path, not host:path; and a host with no path
      // separator is not a repository.
      if (/^[a-zA-Z]$/.test(host) || !rest.includes("/")) return null;
    } else {
      // pi's `git:host/path` shorthand carries no colon after the host.
      const bare = shorthand ? s.match(/^([^/:]+)\/(.+)$/) : null;
      if (!bare) return null;
      host = bare[1];
      rest = bare[2];
    }
  }
  rest = rest.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !rest) return null;
  return { host: host.toLowerCase(), path: rest };
}

const expandHome = (p: string, home: string): string =>
  p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;

/** Walk up from `start` looking for a package.json; returns that directory. */
export function findPackageRoot(start: string, io: FsLike = defaultFs): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 5; i++) {
    if (io.exists(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve one configured package source to its directory, mirroring pi's
 * PackageManager layouts. Returns null when the source is not installed.
 */
export function resolvePackageDir(
  source: string,
  scope: string,
  input: GuardInput,
  io: FsLike = defaultFs,
): string | null {
  if (!source) return null;

  if (source.startsWith("npm:")) {
    const name = npmPackageName(source.slice(4));
    if (!name) return null;
    const root = scope === "project"
      ? path.join(input.cwd, ".pi", "npm", "node_modules")
      : path.join(input.agentDir, "npm", "node_modules");
    const dir = path.join(root, name);
    return io.exists(dir) ? dir : null;
  }

  const git = parseGitSource(source);
  if (git) {
    const root = scope === "project"
      ? path.join(input.cwd, ".pi", "git")
      : path.join(input.agentDir, "git");
    const dir = path.join(root, git.host, git.path);
    return io.exists(dir) ? dir : null;
  }

  const base = scope === "project" ? path.join(input.cwd, ".pi") : input.agentDir;
  const expanded = expandHome(source, input.home ?? os.homedir());
  const dir = path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
  return io.exists(dir) ? dir : null;
}

/** pi's nearest-ancestor trust lookup, plus the `defaultProjectTrust` fallback. */
export function projectIsTrusted(input: GuardInput, io: FsLike = defaultFs): boolean {
  const argv = input.argv ?? [];
  if (argv.includes("--no-approve") || argv.includes("-na")) return false;
  if (argv.includes("--approve") || argv.includes("-a")) return true;

  const store = readJsonFile(io, path.join(input.agentDir, "trust.json")) ?? {};
  let dir = path.resolve(input.cwd);
  for (;;) {
    const decision = store[dir];
    if (decision === true) return true;
    if (decision === false) return false;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const settings = readJsonFile(io, path.join(input.agentDir, "settings.json"));
  return settings?.defaultProjectTrust === "always";
}

/** `--no-extensions` / `-ne`: discovery is off, so configured packages never load. */
export function argvDisablesDiscovery(argv: string[]): boolean {
  return argv.includes("--no-extensions") || argv.includes("-ne");
}

/** Explicit `-e/--extension` arguments, which load even under `--no-extensions`. */
export function argvExtensionSources(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-e" || arg === "--extension") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) out.push(next);
    } else if (arg.startsWith("--extension=")) {
      out.push(arg.slice("--extension=".length));
    }
  }
  return out;
}

/**
 * Every installed copy of this plugin that is configured to load, deduped by
 * real path. Includes this copy unless it is not configured (e.g. a dev run,
 * or a checkout that is not in settings).
 */
export function findPluginCopies(input: GuardInput, io: FsLike = defaultFs): PluginCopy[] {
  const argv = input.argv ?? [];
  const trustedProject = input.trustedProject ?? projectIsTrusted(input, io);
  const resolved: { source: string; scope: string; dir?: string }[] = [];

  if (!argvDisablesDiscovery(argv)) {
    const pushPackages = (settings: any, scope: string) => {
      for (const pkg of settings?.packages ?? []) {
        const source = packageSourceString(pkg);
        if (source && packageAutoloadsExtensions(pkg)) resolved.push({ source, scope });
      }
    };
    pushPackages(readJsonFile(io, path.join(input.agentDir, "settings.json")), "user");
    if (trustedProject) {
      pushPackages(readJsonFile(io, path.join(input.cwd, ".pi", "settings.json")), "project");
    }

    // Auto-discovered package dirs: any child directory holding a manifest.
    const scanDir = (root: string, scope: string) => {
      for (const entry of io.readdir(root) ?? []) {
        const dir = path.join(root, entry);
        if (io.exists(path.join(dir, "package.json"))) resolved.push({ source: `auto:${dir}`, scope, dir });
      }
    };
    scanDir(path.join(input.agentDir, "extensions"), "user");
    if (trustedProject) scanDir(path.join(input.cwd, ".pi", "extensions"), "project");
  }

  for (const source of argvExtensionSources(argv)) {
    const root = findPackageRoot(source, io);
    if (root) resolved.push({ source: `-e:${source}`, scope: "temporary", dir: root });
  }

  const seen = new Set<string>();
  const copies: PluginCopy[] = [];
  for (const entry of resolved) {
    const dir = entry.dir ?? resolvePackageDir(entry.source, entry.scope, input, io);
    if (!dir) continue;
    const real = io.realpath(dir) ?? path.resolve(dir);
    if (seen.has(real)) continue;
    seen.add(real);
    const manifest = readJsonFile(io, path.join(real, "package.json"));
    if (manifest?.name !== PLUGIN_NAME) continue;
    copies.push({
      source: entry.source,
      scope: entry.scope,
      dir: real,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
    });
  }
  return copies;
}

/**
 * The copies that are *not* this one. When this copy cannot identify itself
 * (bundled/inline factory) a single configured copy is assumed to be us, so
 * no false alarm is raised; two or more copies are still a real duplicate.
 */
export function duplicatesFor(selfDir: string | null, copies: PluginCopy[]): PluginCopy[] {
  if (selfDir) return copies.filter((c) => c.dir !== selfDir);
  return copies.length > 1 ? copies : [];
}

export function formatDuplicateError(selfDir: string | null, duplicates: PluginCopy[]): string {
  const line = (c: PluginCopy) =>
    `  • ${c.dir}${c.version ? ` (v${c.version})` : ""} ← ${c.source} [${c.scope}]`;
  const fix = duplicates[0]?.scope === "user" && duplicates[0].source.startsWith("npm:")
    ? `pi remove ${duplicates[0].source}`
    : `# drop any one of the entries above from ~/.pi/agent/settings.json`;
  return [
    `${PLUGIN_NAME} is installed ${duplicates.length + 1} times; ${duplicates.length} of those would`,
    `shadow this copy in the same pi process.`,
    selfDir ? `\nThis copy:\n  • ${selfDir}` : "",
    `\nAlso configured:\n${duplicates.map(line).join("\n")}`,
    `\nBoth copies register the same \`alibaba-cloud\` provider, and pi keeps the one that`,
    `loads last — so the other's wire format, maxTokens and endpoint are silently`,
    `replaced. That is how long answers end up truncated at 1024 tokens.`,
    `\nRemove every copy but one, then restart:`,
    `\n  ${fix}`,
    `\nShortcut while you untangle it: PI_ALIBABA_ALLOW_DUPLICATE=1 enables this run.`,
  ].filter(Boolean).join("\n");
}

/**
 * Throws when another configured copy of this plugin would fight over the same
 * provider ids. pi surfaces a factory failure as a fatal startup diagnostic
 * ("Failed to load extension …", exit 1) in every mode, so the session never
 * starts half-broken.
 */
export function assertSingleInstall(input: GuardInput, io: FsLike = defaultFs): PluginCopy[] {
  if (process.env[GUARD_BYPASS_ENV]) return [];
  let copies: PluginCopy[] = [];
  try {
    copies = findPluginCopies(input, io);
  } catch {
    return []; // never block startup on a scan failure
  }
  const duplicates = duplicatesFor(input.selfDir, copies);
  if (duplicates.length === 0) return [];
  const error = new Error(formatDuplicateError(input.selfDir, duplicates));
  error.name = "DuplicatePluginInstallError";
  throw error;
}