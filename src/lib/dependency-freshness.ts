import { gt, major, minVersion, satisfies, valid, validRange } from "semver";
import type { DetectedDependency } from "@/lib/technology-scanner";
import { dependencyInspectionLimit } from "@/lib/dependency-scan";
import { comparePythonVersions, pinnedPythonVersion, pythonRelease, pythonVersionSatisfies, supportsPythonSpecifier } from "@/lib/python-requirements";

export type DependencyFreshness = DetectedDependency & {
  currentVersion?: string;
  latestVersion?: string;
  status: "current" | "outdated" | "unknown" | "unsupported";
  updateKind?: "major" | "compatible";
};

async function latestNpmVersion(name: string) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
    headers: { Accept: "application/json", "User-Agent": "Luigi-Monitoring" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { version?: string };
  return body.version && valid(body.version) ? body.version : undefined;
}

async function latestPythonVersion(name: string) {
  const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
    headers: { Accept: "application/json", "User-Agent": "Luigi-Monitoring" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { info?: { version?: string } };
  return typeof body.info?.version === "string" ? body.info.version : undefined;
}

async function inspectNpmDependency(
  dependency: DetectedDependency,
  getLatestVersion: (name: string) => Promise<string | undefined>,
): Promise<DependencyFreshness> {
  if (dependency.unsupportedReason || !validRange(dependency.requestedRange)) {
    return { ...dependency, status: "unsupported" };
  }

  try {
    const baseline = minVersion(dependency.requestedRange)?.version;
    if (!baseline) return { ...dependency, status: "unknown" };
    const exactVersion = valid(dependency.requestedRange) ?? undefined;
    const installedVersion = dependency.currentVersion && valid(dependency.currentVersion)
      ? dependency.currentVersion
      : exactVersion;
    const latest = await getLatestVersion(dependency.name);
    if (!latest) return { ...dependency, currentVersion: installedVersion, status: "unknown" };
    const outdated = installedVersion
      ? gt(latest, installedVersion)
      : !satisfies(latest, dependency.requestedRange);
    const comparisonVersion = installedVersion ?? baseline;
    return {
      ...dependency,
      currentVersion: installedVersion,
      latestVersion: latest,
      // A range accepting the newest release does not prove what is installed.
      status: outdated ? "outdated" : installedVersion ? "current" : "unknown",
      updateKind: outdated ? (major(latest) > major(comparisonVersion) ? "major" : "compatible") : undefined,
    };
  } catch {
    return { ...dependency, status: "unknown" };
  }
}

async function inspectPythonDependency(
  dependency: DetectedDependency,
  getLatestVersion: (name: string) => Promise<string | undefined>,
): Promise<DependencyFreshness> {
  if (dependency.unsupportedReason || !supportsPythonSpecifier(dependency.requestedRange)) return { ...dependency, status: "unsupported" };
  const currentVersion = dependency.currentVersion ?? pinnedPythonVersion(dependency.requestedRange);
  try {
    const latestVersion = await getLatestVersion(dependency.name);
    if (!latestVersion || !pythonRelease(latestVersion) || (currentVersion && !pythonRelease(currentVersion))) {
      return { ...dependency, currentVersion, latestVersion, status: "unknown" };
    }
    const outdated = currentVersion
      ? comparePythonVersions(latestVersion, currentVersion)! > 0
      : pythonVersionSatisfies(latestVersion, dependency.requestedRange) === false;
    return {
      ...dependency,
      currentVersion,
      latestVersion,
      status: outdated ? "outdated" : currentVersion ? "current" : "unknown",
      // Python's release numbers may be calendar based. Do not infer npm-style
      // compatibility or migration urgency from the first numeric component.
    };
  } catch {
    return { ...dependency, currentVersion, status: "unknown" };
  }
}

export async function inspectDependencies(dependencies: DetectedDependency[]) {
  const ordered = [...dependencies]
    .sort((left, right) => Number(left.development) - Number(right.development)
      || left.manifestPath.localeCompare(right.manifestPath)
      || left.name.localeCompare(right.name));
  const selected = ordered.slice(0, dependencyInspectionLimit);
  const results: DependencyFreshness[] = [];
  const latestVersions = new Map<string, Promise<string | undefined>>();
  const getLatestVersion = (dependency: DetectedDependency) => {
    const key = `${dependency.ecosystem}:${dependency.name}`;
    const pending = latestVersions.get(key) ?? (dependency.ecosystem === "pypi" ? latestPythonVersion(dependency.name) : latestNpmVersion(dependency.name));
    latestVersions.set(key, pending);
    return pending;
  };

  for (let index = 0; index < selected.length; index += 12) {
    results.push(...await Promise.all(selected.slice(index, index + 12).map((dependency) => (
      (dependency.ecosystem === "pypi" ? inspectPythonDependency : inspectNpmDependency)(dependency, () => getLatestVersion(dependency))
    ))));
  }
  return [...results, ...ordered.slice(dependencyInspectionLimit).map((dependency): DependencyFreshness => ({
    ...dependency,
    status: "unknown",
    evidence: `${dependency.evidence} · non vérifiée : limite de ${dependencyInspectionLimit} dépendances`,
  }))];
}

export function inspectNpmDependencies(dependencies: DetectedDependency[]) {
  return inspectDependencies(dependencies.filter((dependency) => dependency.ecosystem === "npm"));
}
