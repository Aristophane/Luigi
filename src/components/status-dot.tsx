import type { HealthStatus } from "@/lib/domain";

const statusLabels: Record<HealthStatus, string> = {
  healthy: "Sain",
  warning: "À surveiller",
  critical: "Incident",
  unknown: "Inconnu",
};

export function StatusDot({ status, compact = false, label = statusLabels[status] }: { status: HealthStatus; compact?: boolean; label?: string }) {
  return (
    <span className={`status-dot status-dot--${status}`} aria-label={label}>
      <span className="status-dot__mark" aria-hidden="true" />
      {!compact && <span>{label}</span>}
    </span>
  );
}
