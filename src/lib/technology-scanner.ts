import { getGitHubFile, inspectGitHubRepository } from "@/lib/github";

export type DetectedTechnology = {
  name: string;
  version?: string;
  evidence: string;
};

export type DetectedDependency = {
  ecosystem: "npm";
  name: string;
  requestedRange: string;
  development: boolean;
  evidence: string;
};

const supportedManifests = new Set([
  "package.json",
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
  const knownPackages: Record<string, string> = {
    next: "Next.js",
    react: "React",
    vue: "Vue",
    nuxt: "Nuxt",
    express: "Express",
    "@nestjs/core": "NestJS",
    svelte: "Svelte",
    astro: "Astro",
  };

  if (manifest.engines?.node) detections.push({ name: "Node.js", version: cleanVersion(manifest.engines.node), evidence });
  if (manifest.packageManager) {
    const [manager, version] = manifest.packageManager.split("@");
    detections.push({ name: manager, version, evidence });
  }
  for (const [packageName, technologyName] of Object.entries(knownPackages)) {
    if (dependencies[packageName]) detections.push({
      name: technologyName,
      version: cleanVersion(dependencies[packageName]),
      evidence,
    });
  }
  return detections;
}

function packageJsonDependencies(content: string, evidence: string): DetectedDependency[] {
  const manifest = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const runtimeDependencies = Object.entries(manifest.dependencies ?? {}).map(([name, requestedRange]) => ({
    ecosystem: "npm" as const,
    name,
    requestedRange,
    development: false,
    evidence,
  }));
  const developmentDependencies = Object.entries(manifest.devDependencies ?? {}).map(([name, requestedRange]) => ({
    ecosystem: "npm" as const,
    name,
    requestedRange,
    development: true,
    evidence,
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
  const lowerName = name.toLowerCase();

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
  const manifests = inspection.rootContents.filter((entry) => supportedManifests.has(entry.name.toLowerCase()));
  const files = await Promise.all(manifests.map(async (manifest) => ({
    manifest,
    content: await getGitHubFile(repository, manifest.path, branch, token),
  })));
  const detections = new Map<string, DetectedTechnology>();
  const dependencies = new Map<string, DetectedDependency>();

  for (const { manifest, content } of files) {
    for (const detection of parseManifest(manifest.path, content, inspection.commitSha)) {
      addDetection(detections, detection);
    }
    if (manifest.name.toLowerCase() === "package.json") {
      for (const dependency of packageJsonDependencies(content, `${manifest.path} · ${inspection.commitSha.slice(0, 7)}`)) {
        dependencies.set(`${dependency.ecosystem}:${dependency.name}`, dependency);
      }
    }
  }

  return {
    repository: inspection.metadata,
    commitSha: inspection.commitSha,
    technologies: [...detections.values()],
    dependencies: [...dependencies.values()],
  };
}
