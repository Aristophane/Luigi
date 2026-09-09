import { gt, major, minVersion, satisfies, valid } from "semver";
import type { DetectedDependency } from "@/lib/technology-scanner";

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

async function inspectDependency(dependency: DetectedDependency): Promise<DependencyFreshness> {
  if (/^(?:workspace:|catalog:|npm:|file:|link:|git(?:hub)?:|https?:)/i.test(dependency.requestedRange)) {
    return { ...dependency, status: "unsupported" };
  }

  const baseline = minVersion(dependency.requestedRange)?.version;
  if (!baseline) return { ...dependency, status: "unknown" };
  const exactVersion = valid(dependency.requestedRange) ?? undefined;
  const installedVersion = dependency.currentVersion && valid(dependency.currentVersion)
    ? dependency.currentVersion
    : exactVersion;

  try {
    const latest = await latestNpmVersion(dependency.name);
    if (!latest) return { ...dependency, currentVersion: installedVersion, status: "unknown" };
    const outdated = installedVersion
      ? gt(latest, installedVersion)
      : !satisfies(latest, dependency.requestedRange);
    const comparisonVersion = installedVersion ?? baseline;
    return {
      ...dependency,
      currentVersion: installedVersion,
      latestVersion: latest,
      status: outdated ? "outdated" : "current",
      updateKind: outdated ? (major(latest) > major(comparisonVersion) ? "major" : "compatible") : undefined,
    };
  } catch {
    return { ...dependency, currentVersion: installedVersion, status: "unknown" };
  }
}

export async function inspectNpmDependencies(dependencies: DetectedDependency[]) {
  const selected = dependencies
    .filter((dependency) => dependency.ecosystem === "npm")
    .sort((left, right) => Number(left.development) - Number(right.development) || left.name.localeCompare(right.name))
    .slice(0, 60);
  const results: DependencyFreshness[] = [];

  for (let index = 0; index < selected.length; index += 8) {
    results.push(...await Promise.all(selected.slice(index, index + 8).map(inspectDependency)));
  }
  return results;
}
