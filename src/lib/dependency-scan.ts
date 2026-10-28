export type DependencyEcosystem = "npm" | "pypi";

export const dependencyInspectionLimit = 200;

export type DependencyScanLimitation = {
  code: "unsupported_lockfile" | "oversized_manifest" | "dependency_limit" | "unsupported_requirement" | "missing_lockfile";
  path?: string;
  ecosystem?: DependencyEcosystem;
  detail: string;
};

export type DependencyScanCoverage = {
  complete: boolean;
  manifestPaths: string[];
  declaredDependencies: number;
  inspectedDependencies: number;
  limitations: DependencyScanLimitation[];
};
