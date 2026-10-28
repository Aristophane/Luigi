export const deploymentConfirmationMaxAgeMs = 2 * 60 * 60 * 1000;

export type DeploymentConfirmationState = "confirmed" | "stale" | "unverified";

// An old release may still be current. Only the confirmation channel expires.
export function deploymentConfirmationState(verifiedAt: Date | null | undefined, now = new Date()): DeploymentConfirmationState {
  if (!verifiedAt || !Number.isFinite(verifiedAt.getTime())) return "unverified";
  const age = now.getTime() - verifiedAt.getTime();
  return age >= -5 * 60 * 1000 && age <= deploymentConfirmationMaxAgeMs ? "confirmed" : "stale";
}

export function deploymentCommitsMatch(left: string, right: string) {
  if (!/^[a-f0-9]{7,64}$/i.test(left) || !/^[a-f0-9]{7,64}$/i.test(right)) return false;
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}
