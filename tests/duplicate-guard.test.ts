import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  argvDisablesDiscovery,
  argvExtensionSources,
  assertSingleInstall,
  duplicatesFor,
  findPluginCopies,
  findPackageRoot,
  formatDuplicateError,
  GUARD_BYPASS_ENV,
  npmPackageName,
  parseGitSource,
  resolvePackageDir,
  type FsLike,
  type GuardInput,
  type PluginCopy,
} from "../extensions/duplicate-guard.ts";

// Spec: two configured copies of pi-alibaba-models both call
// registerProvider("alibaba-cloud", …), and pi keeps whichever loads last.
// The shadowed copy's wire format / maxTokens silently lose — observed on
// 2026-09-25 as Anthropic-path truncation at 1024 answer tokens. The guard
// must therefore be accurate in BOTH directions: catch a real second copy,
// and never block a single-copy install.

// ── In-memory filesystem ──────────────────────────────────────────────
interface Entry { dirs?: Record<string, Entry>; files?: Record<string, string> }
const fsOf = (tree: Entry): FsLike => ({
  exists: (p) => resolveIn(tree, p) !== undefined,
  readFile: (p) => {
    const node = resolveIn(tree, p);
    return typeof node === "string" ? node : null;
  },
  readdir: (p) => {
    const node = resolveIn(tree, p);
    return node && typeof node === "object" && node.dirs ? Object.keys(node.dirs) : null;
  },
  // Identity: no symlinks in the fixture.
  realpath: (p) => (resolveIn(tree, p) === undefined ? null : p),
});

// Walk the tree; returns either a subtree or the file contents.
function resolveIn(tree: Entry, target: string): Entry | string | undefined {
  const parts = target.split("/").filter(Boolean);
  let node: Entry | string | undefined = tree;
  for (const part of parts) {
    if (typeof node === "string") return undefined;
    if (!node || typeof node !== "object") return undefined;
    const dir = node.dirs?.[part];
    const file = node.files?.[part];
    if (dir && file) return undefined;
    node = dir ?? file;
  }
  return node;
}

const dir = (...children: [string, Entry][]): Entry =>
  ({ dirs: Object.fromEntries(children) });
const withFiles = (files: Record<string, string>, children: [string, Entry][] = []): Entry =>
  ({ files, dirs: Object.fromEntries(children) });
const manifest = (name: string, version: string): Entry =>
  withFiles({ "package.json": JSON.stringify({ name, version }) });
// A directory that contains settings.json plus child directories.
const withSettings = (packages: unknown[], children: [string, Entry][] = []): Entry =>
  withFiles({ "settings.json": JSON.stringify({ packages }) }, children);
const empty: Entry = { dirs: {} };

const BASE: GuardInput = {
  agentDir: "/agent",
  cwd: "/work",
  home: "/home",
  selfDir: "/local/alibaba",
  argv: [],
};

// A plausible two-copy install: the local fork plus a stale npm copy.
const twoCopies = (): Entry => dir(
  ["agent", withSettings(["npm:pi-alibaba-models", "/local/alibaba"], [
    ["extensions", dir(["pi-tool-repair.json", empty])],
    ["npm", dir(["node_modules", dir(["pi-alibaba-models", manifest("pi-alibaba-models", "1.1.1")])])],
  ])],
  ["local", dir(["alibaba", manifest("pi-alibaba-models", "1.5.1")])],
  ["work", dir([".pi", withSettings([])])],
);

describe("npmPackageName", () => {
  it("strips a version or range but keeps the scope", () => {
    assert.equal(npmPackageName("pi-alibaba-models"), "pi-alibaba-models");
    assert.equal(npmPackageName("pi-alibaba-models@1.1.1"), "pi-alibaba-models");
    assert.equal(npmPackageName("pi-alibaba-models@^1.1.1"), "pi-alibaba-models");
    assert.equal(npmPackageName("@scope/pkg@2.0.0"), "@scope/pkg");
    assert.equal(npmPackageName("@scope/pkg"), "@scope/pkg");
  });

  it("rejects junk instead of guessing a path", () => {
    assert.equal(npmPackageName(""), null);
    assert.equal(npmPackageName("@noscope"), null);
  });
});

describe("parseGitSource", () => {
  it("handles pi's git: shorthand and full URLs", () => {
    assert.deepEqual(parseGitSource("git:github.com/Fornace/pi-alibaba-models"), {
      host: "github.com", path: "Fornace/pi-alibaba-models",
    });
    assert.deepEqual(parseGitSource("https://github.com/Fornace/pi-alibaba-models.git"), {
      host: "github.com", path: "Fornace/pi-alibaba-models",
    });
  });

  it("normalizes host case and strips a pinned ref / port", () => {
    assert.deepEqual(parseGitSource("ssh://git@ssh.forge.org.ru:11/freedom4/x.git@v2.3.0"), {
      host: "ssh.forge.org.ru", path: "freedom4/x",
    });
    assert.deepEqual(parseGitSource("git@GitHub.com:Fornace/pi-alibaba-models.git"), {
      host: "github.com", path: "Fornace/pi-alibaba-models",
    });
  });

  it("returns null for non-git sources so they fall through to the local branch", () => {
    assert.equal(parseGitSource("../../pi-plugins/pi-alibaba-models"), null);
    assert.equal(parseGitSource("~/dev/alibaba"), null);
    assert.equal(parseGitSource("c:/src/plugin"), null);
  });
});

describe("resolvePackageDir", () => {
  it("resolves pi's managed npm layout", () => {
    const io = fsOf(twoCopies());
    assert.equal(
      resolvePackageDir("npm:pi-alibaba-models", "user", BASE, io),
      "/agent/npm/node_modules/pi-alibaba-models",
    );
  });

  it("resolves the git layout under host/path", () => {
    const tree = dir(["agent", dir(["git", dir(["github.com", dir(["Fornace", dir(["pi-alibaba-models", manifest("pi-alibaba-models", "1.5.1")])])])])]);
    assert.equal(
      resolvePackageDir("git:github.com/Fornace/pi-alibaba-models", "user", BASE, fsOf(tree)),
      "/agent/git/github.com/Fornace/pi-alibaba-models",
    );
  });

  it("resolves a local path relative to the agent dir", () => {
    const io = fsOf(twoCopies());
    assert.equal(resolvePackageDir("/local/alibaba", "user", BASE, io), "/local/alibaba");
    assert.equal(resolvePackageDir("~/dev/alibaba", "user", BASE, io), null);
  });

  it("returns null when the source is not installed", () => {
    const io = fsOf(dir(["agent", empty]));
    assert.equal(resolvePackageDir("npm:not-installed", "user", BASE, io), null);
    assert.equal(resolvePackageDir("git:github.com/absent/repo", "user", BASE, io), null);
    assert.equal(resolvePackageDir("/nope", "user", BASE, io), null);
  });
});

describe("findPackageRoot", () => {
  it("finds the manifest one level up from extensions/", () => {
    const io = fsOf(dir(["pkg", withFiles(
      { "package.json": JSON.stringify({ name: "pi-alibaba-models" }) },
      [["extensions", empty]],
    )]));
    assert.equal(findPackageRoot("/pkg/extensions", io), "/pkg");
  });

  it("returns null when nothing up the chain is a package", () => {
    assert.equal(findPackageRoot("/nowhere/deep", fsOf(empty)), null);
  });
});

describe("CLI argument handling", () => {
  it("detects --no-extensions / -ne", () => {
    assert.equal(argvDisablesDiscovery(["-ne"]), true);
    assert.equal(argvDisablesDiscovery(["--no-extensions"]), true);
    assert.equal(argvDisablesDiscovery(["--print"]), false);
  });

  it("collects -e and --extension, ignoring a detached flag", () => {
    assert.deepEqual(argvExtensionSources(["-e", "/a", "--extension", "/b"]), ["/a", "/b"]);
    assert.deepEqual(argvExtensionSources(["--extension=/c"]), ["/c"]);
    assert.deepEqual(argvExtensionSources(["-e", "--print"]), []);
  });
});

describe("findPluginCopies", () => {
  it("sees both configured copies, with versions and sources", () => {
    const copies = findPluginCopies(BASE, fsOf(twoCopies()));
    assert.equal(copies.length, 2);
    const npm = copies.find((c) => c.source === "npm:pi-alibaba-models");
    const local = copies.find((c) => c.source === "/local/alibaba");
    assert.equal(npm?.version, "1.1.1");
    assert.equal(local?.version, "1.5.1");
  });

  it("ignores unrelated packages and auto-discovered non-plugin dirs", () => {
    const tree = dir(
      ["agent", withSettings(["npm:pi-subagents", "/local/alibaba"], [
        ["extensions", dir(["pi-tool-repair.json", empty])],
        ["npm", dir(["node_modules", dir(["pi-subagents", manifest("pi-subagents", "0.71.0")])])],
      ])],
      ["local", dir(["alibaba", manifest("pi-alibaba-models", "1.5.1")])],
    );
    const copies = findPluginCopies(BASE, fsOf(tree));
    assert.deepEqual(copies.map((c) => c.source), ["/local/alibaba"]);
  });

  it("finds a copy dropped into the auto-discovered extensions dir", () => {
    const tree = dir(["agent", withSettings([], [
      ["extensions", dir(["pi-alibaba-models", manifest("pi-alibaba-models", "1.5.1")])],
    ])]);
    const copies = findPluginCopies(BASE, fsOf(tree));
    assert.equal(copies.length, 1);
    assert.equal(copies[0].scope, "user");
  });

  it("honors autoload:false — a configured-but-not-loaded copy is not a duplicate", () => {
    const tree = dir(
      ["agent", withSettings([{ source: "npm:pi-alibaba-models", autoload: false }])],
      ["local", dir(["alibaba", manifest("pi-alibaba-models", "1.5.1")])],
    );
    assert.deepEqual(findPluginCopies(BASE, fsOf(tree)), []);
  });

  it("skips everything under --no-extensions but still honors -e", () => {
    const io = fsOf(twoCopies());
    assert.deepEqual(
      findPluginCopies({ ...BASE, argv: ["-ne"] }, io).map((c) => c.source),
      [],
    );
    const explicit = findPluginCopies({ ...BASE, argv: ["-ne", "-e", "/local/alibaba"] }, io);
    assert.equal(explicit.length, 1);
    assert.equal(explicit[0].scope, "temporary");
  });

  it("reads project packages only when the project is trusted", () => {
    const tree = dir(
      ["agent", withSettings([])],
      ["work", dir([".pi", withSettings(["npm:pi-alibaba-models"], [
        ["npm", dir(["node_modules", dir(["pi-alibaba-models", manifest("pi-alibaba-models", "1.1.1")])])],
      ])])],
    );
    assert.deepEqual(findPluginCopies(BASE, fsOf(tree)), []);
    assert.equal(findPluginCopies({ ...BASE, trustedProject: true }, fsOf(tree)).length, 1);
  });

  it("dedupes the same directory referenced two ways", () => {
    const tree = dir(
      ["local", dir(["alibaba", manifest("pi-alibaba-models", "1.5.1")])],
      ["agent", withSettings(["/local/alibaba", "/local/alibaba"])],
    );
    assert.equal(findPluginCopies(BASE, fsOf(tree)).length, 1);
  });
});

describe("duplicatesFor", () => {
  const copies: PluginCopy[] = [
    { source: "/local/alibaba", scope: "user", dir: "/local/alibaba", version: "1.5.1" },
    { source: "npm:pi-alibaba-models", scope: "user", dir: "/agent/npm/node_modules/pi-alibaba-models", version: "1.1.1" },
  ];

  it("reports only the other copies when this copy is known", () => {
    const dup = duplicatesFor("/local/alibaba", copies);
    assert.equal(dup.length, 1);
    assert.equal(dup[0].version, "1.1.1");
  });

  it("assumes a lone copy is itself when identity is unknown", () => {
    assert.deepEqual(duplicatesFor(null, [copies[0]]), []);
  });

  it("still reports real duplication when identity is unknown", () => {
    assert.equal(duplicatesFor(null, copies).length, 2);
  });
});

describe("assertSingleInstall", () => {
  it("passes silently for a single copy", () => {
    const tree = dir(
      ["local", dir(["alibaba", manifest("pi-alibaba-models", "1.5.1")])],
      ["agent", withSettings(["/local/alibaba"])],
    );
    assert.deepEqual(assertSingleInstall(BASE, fsOf(tree)), []);
  });

  it("throws when another copy would shadow this one", () => {
    assert.throws(
      () => assertSingleInstall(BASE, fsOf(twoCopies())),
      (err: Error) => {
        assert.equal(err.name, "DuplicatePluginInstallError");
        assert.match(err.message, /installed 2 times/);
        assert.match(err.message, /npm:pi-alibaba-models/);
        assert.match(err.message, /pi remove npm:pi-alibaba-models/);
        assert.match(err.message, /maxTokens/);
        return true;
      },
    );
  });

  it("never blocks startup when the scan itself fails", () => {
    const hostile: FsLike = {
      exists: () => true,
      readFile: () => { throw new Error("EACCES"); },
      readdir: () => { throw new Error("EACCES"); },
      realpath: () => { throw new Error("EACCES"); },
    };
    assert.deepEqual(assertSingleInstall(BASE, hostile), []);
  });

  it("honors the bypass env var", () => {
    const prev = process.env[GUARD_BYPASS_ENV];
    process.env[GUARD_BYPASS_ENV] = "1";
    try {
      assert.deepEqual(assertSingleInstall(BASE, fsOf(twoCopies())), []);
    } finally {
      if (prev === undefined) delete process.env[GUARD_BYPASS_ENV];
      else process.env[GUARD_BYPASS_ENV] = prev;
    }
  });
});

describe("formatDuplicateError", () => {
  it("names both copies, the consequence, and the exact fix", () => {
    const message = formatDuplicateError("/local/alibaba", [
      { source: "npm:pi-alibaba-models", scope: "user", dir: "/agent/npm/node_modules/pi-alibaba-models", version: "1.1.1" },
    ]);
    assert.match(message, /installed 2 times/);
    assert.match(message, /\/local\/alibaba/);
    assert.match(message, /v1\.1\.1/);
    assert.match(message, /pi remove npm:pi-alibaba-models/);
    assert.match(message, new RegExp(GUARD_BYPASS_ENV));
  });

  it("suggests a settings edit when no npm source is the culprit", () => {
    const message = formatDuplicateError(null, [
      { source: "auto:/agent/extensions/x", scope: "user", dir: "/agent/extensions/x" },
    ]);
    assert.match(message, /settings\.json/);
    assert.ok(!message.includes("pi remove"));
  });
});