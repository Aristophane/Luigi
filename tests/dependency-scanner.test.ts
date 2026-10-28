import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { scanGitHubTechnologies, type DetectedDependency } from "@/lib/technology-scanner";
import { inspectDependencies } from "@/lib/dependency-freshness";
import { comparePythonVersions, parsePythonRequirements, pythonVersionSatisfies } from "@/lib/python-requirements";
import { dependencyUpdateKind, groupDependencies, technologyDependency } from "@/lib/dependency-groups";

const head = "0123456789012345678901234567890123456789";
type FixtureFiles = Record<string, { content: string; size?: number }>;

function mockRepository(t: TestContext, files: FixtureFiles, versions: Record<string, string> = {}) {
  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (target: string | URL | Request) => {
    const url = new URL(String(target));
    calls.push(url);
    if (url.hostname === "pypi.org") return Response.json({ info: { version: versions[decodeURIComponent(url.pathname.split("/")[2])] } });
    if (url.hostname === "registry.npmjs.org") return Response.json({ version: versions[decodeURIComponent(url.pathname.slice(1).replace(/\/latest$/, ""))] });
    assert.equal(url.hostname, "api.github.com", "All external requests must use the fixture");
    if (url.pathname.includes("/branches/")) return Response.json({ commit: { sha: head, commit: { message: "fixture", tree: { sha: "tree" } } } });
    if (url.pathname.includes("/git/trees/")) return Response.json({ truncated: false,
      tree: Object.entries(files).map(([path, file]) => ({ path, type: "blob", size: file.size ?? Buffer.byteLength(file.content) })) });
    if (url.pathname.includes("/contents/")) {
      assert.equal(url.searchParams.get("ref"), head, "Manifest content must come from the exact inspected commit");
      const path = decodeURIComponent(url.pathname.split("/contents/")[1]);
      assert.ok(files[path], `Unexpected manifest ${path}`);
      return new Response(files[path].content);
    }
    return Response.json({ full_name: "fixture/project" });
  });
  return calls;
}

function dependency(name: string, requestedRange: string, extra: Partial<DetectedDependency> = {}): DetectedDependency {
  return { ecosystem: "npm", name, requestedRange, manifestPath: "package.json", development: false, evidence: "fixture", ...extra };
}

test("Python requirements detect Felix packages and compare final PEP 440 versions, including calendar releases", async (t) => {
  mockRepository(t, { "requirements.txt": { content: "Flask==3.1.3\nPillow==12.3.0\ntzdata==2026.3\n" } },
    { flask: "3.1.3", pillow: "12.3.1", tzdata: "2026.3" });
  const scan = await scanGitHubTechnologies("fixture/project", "main");
  assert.deepEqual(scan.dependencies.map((item) => [item.ecosystem, item.name, item.currentVersion]),
    [["pypi", "flask", "3.1.3"], ["pypi", "pillow", "12.3.0"], ["pypi", "tzdata", "2026.3"]]);
  assert.equal(scan.coverage.complete, true);
  assert.equal(scan.coverage.declaredDependencies, 3);
  const result = await inspectDependencies(scan.dependencies);
  assert.deepEqual(result.map((item) => [item.name, item.status]), [["flask", "current"], ["pillow", "outdated"], ["tzdata", "current"]]);
  assert.equal(technologyDependency({ name: "Flask" }, result)?.name, "flask");
  assert.equal(groupDependencies(result).find((group) => group.lead.name === "flask")?.framework, true);
  assert.equal(result.find((item) => item.name === "pillow")?.updateKind, undefined);
  assert.equal(dependencyUpdateKind({ ...result[1], latestVersion: "13.0.0" }), undefined, "Calendar/Python versions do not imply npm major migration severity");
});

test("PEP 440 final comparisons normalize zeros and apply compatible releases and prefixes", () => {
  assert.equal(comparePythonVersions("1.0", "1.0.0"), 0);
  assert.equal(comparePythonVersions("2026.10", "2026.3"), 1);
  assert.equal(pythonVersionSatisfies("1.4.9", "~=1.4.5"), true);
  assert.equal(pythonVersionSatisfies("1.5.0", "~=1.4.5"), false);
  assert.equal(pythonVersionSatisfies("1.9", "~=1.4"), true);
  assert.equal(pythonVersionSatisfies("2.0", "~=1.4"), false);
  assert.equal(pythonVersionSatisfies("1.2.0", "(>=1.0,!=1.1.*,<2,)"), true);
  assert.equal(pythonVersionSatisfies("1.1.9", ">=1.0,!=1.1.*,<2"), false);
  assert.equal(pythonVersionSatisfies("1.0", "==1.0.*"), true);
  assert.equal(pythonVersionSatisfies("1.0rc1", ">=1.0"), undefined);
});

test("Unsupported Python syntax is explicit and never considered current or looked up under a private index", async (t) => {
  const calls = mockRepository(t, { "requirements-dev.txt": { content: [
    "Flask==3.2rc1", "Pillow==12.3.0; python_version >= '3.11'", "tzdata @ https://example.com/custom.whl", "-r base.txt",
  ].join("\n") } });
  const scan = await scanGitHubTechnologies("fixture/project", "main");
  assert.equal(scan.coverage.complete, false);
  assert.equal(scan.dependencies.every((item) => item.development), true);
  assert.ok(scan.coverage.limitations.some((item) => item.code === "unsupported_requirement"));
  const inspected = await inspectDependencies(scan.dependencies);
  assert.equal(inspected.every((item) => item.status === "unsupported"), true);
  assert.equal(calls.some((url) => url.hostname === "pypi.org"), false);
  const privateIndex = parsePythonRequirements("--index-url https://example.com/simple\nFlask==3.1.3");
  assert.match(privateIndex.dependencies[0].unsupportedReason ?? "", /Index pip personnalisé/);
});

test("PyPI prereleases, post, dev, local and epoch versions cannot accidentally use semver ordering", async (t) => {
  mockRepository(t, {}, { flask: "3.2rc1" });
  const [result] = await inspectDependencies([dependency("flask", "==3.1.3", { ecosystem: "pypi", manifestPath: "requirements.txt" })]);
  assert.equal(result.status, "unknown");
  for (const version of ["1.0rc1", "1.0.dev1", "1.0.post1", "1!1.0", "1.0+local"]) {
    const parsed = parsePythonRequirements(`demo==${version}`);
    assert.ok(parsed.dependencies[0].unsupportedReason, version);
    assert.equal(comparePythonVersions(version, "1.0"), undefined);
  }
});

test("A repeated conflicting Python requirement remains unsupported instead of silently choosing the last pin", async (t) => {
  mockRepository(t, { "requirements.txt": { content: "Flask==3.0\nFlask==3.1\nFlask==3.1" } });
  const scan = await scanGitHubTechnologies("fixture/project", "main");
  assert.equal(scan.dependencies.length, 1);
  assert.equal(scan.dependencies[0].currentVersion, undefined);
  assert.ok(scan.dependencies[0].unsupportedReason);
  assert.equal((await inspectDependencies(scan.dependencies))[0].status, "unsupported");
});

test("npm tags and protocols do not abort analysis of valid sibling packages", async (t) => {
  const calls = mockRepository(t, {}, { pinned: "2.0.0" });
  const results = await inspectDependencies([
    dependency("latest-tag", "latest"), dependency("beta-tag", "beta"), dependency("workspace", "workspace:*"),
    dependency("pinned", "1.0.0"),
  ]);
  assert.equal(results.filter((item) => item.status === "unsupported").length, 3);
  assert.equal(results.find((item) => item.name === "pinned")?.status, "outdated");
  assert.equal(calls.filter((url) => url.hostname === "registry.npmjs.org").length, 1);
});

test("A compatible range without a known installed version stays unknown for npm and Python", async (t) => {
  mockRepository(t, {}, { demo: "1.9.0", flask: "3.1.3" });
  const results = await inspectDependencies([
    dependency("demo", "^1.0.0"), dependency("flask", ">=3,<4", { ecosystem: "pypi", manifestPath: "requirements.txt" }),
  ]);
  assert.equal(results.every((item) => item.status === "unknown"), true);
  assert.equal(results.every((item) => item.currentVersion === undefined), true);
});

test("Unsupported and oversized lockfiles remain visible in scan coverage; all content is pinned to SHA", async (t) => {
  const calls = mockRepository(t, {
    "package.json": { content: JSON.stringify({ dependencies: { demo: "^1.0.0" } }) },
    "package-lock.json": { content: "{}", size: 1_000_001 },
    "pnpm-lock.yaml": { content: "ignored" },
  }, { demo: "1.9.0" });
  const scan = await scanGitHubTechnologies("fixture/project", "main");
  assert.equal(scan.coverage.complete, false);
  assert.deepEqual(new Set(scan.coverage.limitations.map((item) => item.code)), new Set(["oversized_manifest", "unsupported_lockfile", "missing_lockfile"]));
  assert.equal(calls.filter((url) => url.pathname.includes("/contents/")).length, 1);
  assert.equal((await inspectDependencies(scan.dependencies))[0].status, "unknown");
});

test("Manifest formats with technology detection only are explicitly outside dependency coverage", async (t) => {
  mockRepository(t, { "pyproject.toml": { content: '[project]\nrequires-python = ">=3.11"' },
    "composer.json": { content: JSON.stringify({ require: { php: "^8.2" } }) } });
  const scan = await scanGitHubTechnologies("fixture/project", "main");
  assert.equal(scan.coverage.complete, false);
  assert.equal(scan.coverage.limitations.filter((item) => item.code === "unsupported_requirement").length, 2);
});

test("A Python add-on alone does not identify a framework that is not declared", async (t) => {
  mockRepository(t, { "requirements.txt": { content: "Flask-Cors==6.0.0" } });
  const scan = await scanGitHubTechnologies("fixture/project", "main");
  assert.equal(scan.technologies.some((technology) => technology.name === "Flask"), false);
});

test("The 200 package budget retains unchecked dependencies as unknown and reports the limit", async (t) => {
  const declared = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`pkg-${String(index).padStart(3, "0")}`, "1.0.0"]));
  const versions = Object.fromEntries(Object.keys(declared).map((name) => [name, "1.0.0"]));
  const calls = mockRepository(t, { "package.json": { content: JSON.stringify({ dependencies: declared }) } }, versions);
  const scan = await scanGitHubTechnologies("fixture/project", "main");
  assert.equal(scan.coverage.declaredDependencies, 205);
  assert.equal(scan.coverage.inspectedDependencies, 200);
  assert.ok(scan.coverage.limitations.some((item) => item.code === "dependency_limit"));
  const results = await inspectDependencies(scan.dependencies);
  assert.equal(results.length, 205);
  assert.equal(results.filter((item) => item.status === "unknown").length, 5);
  assert.equal(calls.filter((url) => url.hostname === "registry.npmjs.org").length, 200);
});

test("npm and PyPI packages with the same name remain separate groups", () => {
  const base = { ...dependency("demo", "1.0.0"), status: "outdated" as const, latestVersion: "2.0.0" };
  assert.equal(groupDependencies([base, { ...base, ecosystem: "pypi" as const }]).length, 2);
});
