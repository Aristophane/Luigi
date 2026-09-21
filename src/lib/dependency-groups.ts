import { compare, major, minVersion, valid } from "semver";

// Paquets qui identifient le framework principal d'une solution, associés au nom de la technologie affichée.
export const frameworkPackages: Record<string, string> = {
  "@vendure/core": "Vendure",
  next: "Next.js",
  react: "React",
  vue: "Vue",
  nuxt: "Nuxt",
  express: "Express",
  "@nestjs/core": "NestJS",
  svelte: "Svelte",
  astro: "Astro",
};

const technologyPackages = new Map(Object.entries(frameworkPackages).map(([packageName, technology]) => [technology, packageName]));

type DependencyStatus = "current" | "outdated" | "unknown" | "unsupported";

export type GroupableDependency = {
  name: string;
  manifestPath: string;
  currentVersion?: string | null;
  requestedRange: string;
  latestVersion?: string | null;
  status: DependencyStatus;
  development: boolean;
};

export type DependencyGroup<T extends GroupableDependency> = {
  // Paquet de référence : le framework de la famille, sinon le premier paquet par ordre alphabétique.
  lead: T;
  label: string;
  members: T[];
  manifestPath: string;
  currentVersion?: string;
  latestVersion?: string;
  status: DependencyStatus;
  development: boolean;
  framework: boolean;
  updateKind?: "major" | "compatible";
};

// Les paquets d'un même scope publiés dans la même version forment une seule mise à jour (@vendure/*, @aws-sdk/*).
// Les @types sont exclus : leurs versions suivent chacune une bibliothèque différente.
function releaseFamily(name: string) {
  const scope = name.match(/^(@[^/]+)\//)?.[1];
  return scope && scope !== "@types" ? scope : undefined;
}

export function dependencyUpdateKind(dependency: GroupableDependency) {
  if (dependency.status !== "outdated" || !dependency.latestVersion || !valid(dependency.latestVersion)) return undefined;
  try {
    const baseline = dependency.currentVersion && valid(dependency.currentVersion)
      ? dependency.currentVersion
      : minVersion(dependency.requestedRange)?.version;
    if (!baseline) return undefined;
    return major(dependency.latestVersion) > major(baseline) ? "major" as const : "compatible" as const;
  } catch {
    return undefined;
  }
}

function lowestVersion(versions: Array<string | null | undefined>) {
  return versions
    .filter((version): version is string => Boolean(version && valid(version)))
    .sort(compare)[0];
}

export function groupDependencies<T extends GroupableDependency>(dependencies: T[]): DependencyGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const dependency of dependencies) {
    const family = releaseFamily(dependency.name);
    const key = family
      ? [dependency.manifestPath, family, dependency.status, dependency.latestVersion ?? ""].join("\u0000")
      : [dependency.manifestPath, dependency.name].join("\u0000");
    buckets.set(key, [...buckets.get(key) ?? [], dependency]);
  }

  return [...buckets.values()].map((members) => {
    const sortedMembers = [...members].sort((left, right) => left.name.localeCompare(right.name));
    const frameworkMember = sortedMembers.find((member) => frameworkPackages[member.name]);
    const lead = frameworkMember ?? sortedMembers[0];
    const updateKinds = sortedMembers.map(dependencyUpdateKind);
    return {
      lead,
      label: sortedMembers.length > 1
        ? (frameworkMember ? frameworkPackages[frameworkMember.name] : releaseFamily(lead.name) ?? lead.name)
        : lead.name,
      members: sortedMembers,
      manifestPath: lead.manifestPath,
      currentVersion: lowestVersion(sortedMembers.map((member) => member.currentVersion)) ?? lead.currentVersion ?? undefined,
      latestVersion: lead.latestVersion ?? undefined,
      status: lead.status,
      development: sortedMembers.every((member) => member.development),
      framework: Boolean(frameworkMember),
      updateKind: updateKinds.includes("major") ? "major" : updateKinds.includes("compatible") ? "compatible" : undefined,
    };
  });
}

const statusRank: Record<DependencyStatus, number> = { outdated: 0, unknown: 1, unsupported: 2, current: 3 };

// Ordre d'importance : frameworks, dépendances d'exécution, mises à jour majeures, puis nom et dossier.
export function compareDependencyGroups<T extends GroupableDependency>(left: DependencyGroup<T>, right: DependencyGroup<T>) {
  return statusRank[left.status] - statusRank[right.status]
    || Number(right.framework) - Number(left.framework)
    || Number(left.development) - Number(right.development)
    || Number(right.updateKind === "major") - Number(left.updateKind === "major")
    || left.label.localeCompare(right.label)
    || left.manifestPath.localeCompare(right.manifestPath);
}

// Retrouve le paquet npm d'une technologie détectée, de préférence dans le manifeste qui l'a révélée.
export function technologyDependency<T extends GroupableDependency>(
  technology: { name: string; evidence?: string | null },
  dependencies: T[],
) {
  const packageName = technologyPackages.get(technology.name);
  if (!packageName) return undefined;
  const candidates = dependencies.filter((dependency) => dependency.name === packageName);
  return candidates.find((dependency) => technology.evidence?.startsWith(`${dependency.manifestPath} · `))
    ?? candidates.find((dependency) => dependency.status === "outdated")
    ?? candidates[0];
}
