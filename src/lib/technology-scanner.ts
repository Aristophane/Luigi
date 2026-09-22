import { frameworkPackages } from "@/lib/dependency-groups";
import { getGitHubFile, inspectGitHubRepository } from "@/lib/github";

export type DetectedTechnology = {
  name: string;
  version?: string;
  evidence: string;
};

export type DetectedDependency = {
  ecosystem: "npm";
  name: string;
  manifestPath: string;
  requestedRange: string;
  currentVersion?: string;
  development: boolean;
  evidence: string;
};

const supportedManifests = new Set([
  "package.json",
  "package-lock.json",
  "pyproject.toml",
  "requirements.txt",
  "composer.json",
  "go.mod",
  "cargo.toml",
  "dockerfile",
  ".nvmrc",
  ".node-version",
  ".python-version",
]);

function cleanVersion(value?: string) {
  return value?.trim().replace(/^[~^<>=\sv]+/i, "") || undefined;
}

function addDetection(target: Map<string, DetectedTechnology>, detection: DetectedTechnology) {
  const key = detection.name.toLowerCase();
  const current = target.get(key);
  if (!current || (!current.version && detection.version)) target.set(key, detection);
}

function packageJsonDetections(content: string, evidence: string) {
  const detections: DetectedTechnology[] = [];
  const manifest = JSON.parse(content) as {
    packageManager?: string;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };

  if (manifest.engines?.node) detections.push({ name: "Node.js", version: cleanVersion(manifest.engines.node), evidence });
  if (manifest.packageManager) {
    const [manager, version] = manifest.packageManager.split("@");
    detections.push({ name: manager, version, evidence });
  }
  for (const [packageName, technologyName] of Object.entries(frameworkPackages)) {
    if (dependencies[packageName]) detections.push({
      name: technologyName,
      version: cleanVersion(dependencies[packageName]),
      evidence,
    });
  }
  return detections;
}

function packageLockVersions(content?: string) {
  const versions = new Map<string, string>();
  if (!content) return versions;

  try {
    const lockfile = JSON.parse(content) as {
      packages?: Record<string, { version?: string }>;
      dependencies?: Record<string, { version?: string }>;
    };
    for (const [path, metadata] of Object.entries(lockfile.packages ?? {})) {
      if (!metadata.version) continue;
      versions.set(path.replaceAll("\\", "/").replace(/^\.\//, ""), metadata.version);
    }
    for (const [name, metadata] of Object.entries(lockfile.dependencies ?? {})) {
      const path = `node_modules/${name}`;
      if (metadata.version && !versions.has(path)) versions.set(path, metadata.version);
    }
  } catch {
    // Un lockfile illisible ne doit pas empêcher l'analyse du manifeste.
  }
  return versions;
}

function directoryOf(path: string) {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function relativeDirectory(parent: string, child: string) {
  if (!parent) return child;
  if (child === parent) return "";
  return child.startsWith(`${parent}/`) ? child.slice(parent.length + 1) : undefined;
}

function lockedDependencyVersion(
  versions: Map<string, string>,
  packageName: string,
  manifestPath: string,
  lockPath: string,
) {
  const relativeManifestDirectory = relativeDirectory(directoryOf(lockPath), directoryOf(manifestPath));
  const localPath = relativeManifestDirectory
    ? `${relativeManifestDirectory}/node_modules/${packageName}`
    : `node_modules/${packageName}`;
  return versions.get(localPath) ?? versions.get(`node_modules/${packageName}`);
}

function packageJsonDependencies(
  content: string,
  evidence: string,
  manifestPath: string,
  lockedVersions: Map<string, string>,
  lockPath?: string,
  lockEvidence?: string,
): DetectedDependency[] {
  const manifest = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const runtimeDependencies = Object.entries(manifest.dependencies ?? {}).map(([name, requestedRange]) => ({
    ecosystem: "npm" as const,
    name,
    manifestPath,
    requestedRange,
    currentVersion: lockPath
      ? lockedDependencyVersion(lockedVersions, name, manifestPath, lockPath)
      : undefined,
    development: false,
    evidence: lockPath && lockedDependencyVersion(lockedVersions, name, manifestPath, lockPath) && lockEvidence
      ? `${evidence} · version via ${lockEvidence}`
      : evidence,
  }));
  const developmentDependencies = Object.entries(manifest.devDependencies ?? {}).map(([name, requestedRange]) => ({
    ecosystem: "npm" as const,
    name,
    manifestPath,
    requestedRange,
    currentVersion: lockPath
      ? lockedDependencyVersion(lockedVersions, name, manifestPath, lockPath)
      : undefined,
    development: true,
    evidence: lockPath && lockedDependencyVersion(lockedVersions, name, manifestPath, lockPath) && lockEvidence
      ? `${evidence} · version via ${lockEvidence}`
      : evidence,
  }));
  return [...runtimeDependencies, ...developmentDependencies];
}

function pythonDetections(content: string, evidence: string) {
  const detections: DetectedTechnology[] = [];
  const pythonVersion = content.match(/(?:requires-python|python)\s*=\s*["']([^"']+)/i)?.[1];
  if (pythonVersion) detections.push({ name: "Python", version: cleanVersion(pythonVersion), evidence });
  const frameworks: Array<[RegExp, string]> = [
    [/\bdjango(?:\W|$)/i, "Django"],
    [/\bfastapi(?:\W|$)/i, "FastAPI"],
    [/\bflask(?:\W|$)/i, "Flask"],
  ];
  for (const [pattern, name] of frameworks) {
    const match = content.match(new RegExp(`${pattern.source}[^\r\n=<>~]*[=<>~! ]*([0-9][^\s,;"']*)?`, "i"));
    if (match) detections.push({ name, version: cleanVersion(match[1]), evidence });
  }
  return detections;
}

function composerDetections(content: string, evidence: string) {
  const manifest = JSON.parse(content) as { require?: Record<string, string> };
  const dependencies = manifest.require ?? {};
  const detections: DetectedTechnology[] = [];
  if (dependencies.php) detections.push({ name: "PHP", version: cleanVersion(dependencies.php), evidence });
  if (dependencies["laravel/framework"]) detections.push({ name: "Laravel", version: cleanVersion(dependencies["laravel/framework"]), evidence });
  if (dependencies["symfony/framework-bundle"]) detections.push({ name: "Symfony", version: cleanVersion(dependencies["symfony/framework-bundle"]), evidence });
  return detections;
}

function parseManifest(name: string, content: string, commitSha: string) {
  const evidence = `${name} · ${commitSha.slice(0, 7)}`;
  const lowerName = name.split("/").at(-1)?.toLowerCase() ?? name.toLowerCase();

  try {
    if (lowerName === "package.json") return packageJsonDetections(content, evidence);
    if (lowerName === "pyproject.toml" || lowerName === "requirements.txt") return pythonDetections(content, evidence);
    if (lowerName === "composer.json") return composerDetections(content, evidence);
    if (lowerName === ".nvmrc" || lowerName === ".node-version") return [{ name: "Node.js", version: cleanVersion(content), evidence }];
    if (lowerName === ".python-version") return [{ name: "Python", version: cleanVersion(content), evidence }];
    if (lowerName === "go.mod") {
      return [{ name: "Go", version: cleanVersion(content.match(/^go\s+([^\s]+)/m)?.[1]), evidence }];
    }
    if (lowerName === "cargo.toml") {
      return [{ name: "Rust", version: cleanVersion(content.match(/^rust-version\s*=\s*["']([^"']+)/m)?.[1]), evidence }];
    }
    if (lowerName === "dockerfile") {
      const image = content.match(/^FROM\s+(?:--platform=\S+\s+)?([^\s]+)/im)?.[1];
      return image ? [{ name: "Docker", version: image, evidence }] : [];
    }
  } catch {
    return [];
  }
  return [];
}

export async function scanGitHubTechnologies(repository: string, branch: string, token?: string) {
  const inspection = await inspectGitHubRepository(repository, branch, token);
  const ignoredDirectories = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules", "vendor"]);
  const manifests = inspection.repositoryFiles.filter((entry) => (
    supportedManifests.has(entry.name.toLowerCase())
    && !entry.path.split("/").some((segment) => ignoredDirectories.has(segment.toLowerCase()))
  ));
  if (manifests.length > 200) throw new Error("TOO_MANY_MANIFESTS");
  const files: Array<{ manifest: (typeof manifests)[number]; content: string }> = [];
  for (let index = 0; index < manifests.length; index += 12) {
    files.push(...await Promise.all(manifests.slice(index, index + 12).map(async (manifest) => ({
      manifest,
      content: await getGitHubFile(repository, manifest.path, branch, token),
    }))));
  }
  const detections = new Map<string, DetectedTechnology>();
  const dependencies = new Map<string, DetectedDependency>();
  const packageLocks = files
    .filter(({ manifest }) => manifest.name.toLowerCase() === "package-lock.json")
    .map((file) => ({ ...file, versions: packageLockVersions(file.content) }));

  for (const { manifest, content } of files) {
    for (const detection of parseManifest(manifest.path, content, inspection.commitSha)) {
      addDetection(detections, detection);
    }
    if (manifest.name.toLowerCase() === "package.json") {
      const manifestDirectory = directoryOf(manifest.path);
      const packageLock = packageLocks
        .filter(({ manifest: lockManifest }) => relativeDirectory(directoryOf(lockManifest.path), manifestDirectory) !== undefined)
        .sort((left, right) => directoryOf(right.manifest.path).length - directoryOf(left.manifest.path).length)[0];
      const lockEvidence = packageLock
        ? `${packageLock.manifest.path} · ${inspection.commitSha.slice(0, 7)}`
        : undefined;
      for (const dependency of packageJsonDependencies(
        content,
        `${manifest.path} · ${inspection.commitSha.slice(0, 7)}`,
        manifest.path,
        packageLock?.versions ?? new Map(),
        packageLock?.manifest.path,
        lockEvidence,
      )) {
        dependencies.set(`${dependency.ecosystem}:${dependency.manifestPath}:${dependency.name}`, dependency);
      }
    }
  }

  return {
    repository: inspection.metadata,
    commitSha: inspection.commitSha,
    commitMessage: inspection.commitMessage,
    technologies: [...detections.values()],
    dependencies: [...dependencies.values()],
  };
}
