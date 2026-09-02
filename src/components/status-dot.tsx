import type { HealthStatus } from "@/lib/domain";

const statusLabels: Record<HealthStatus, string> = {
  healthy: "Sain",
  warning: "À surveiller",
  critical: "Incident",
  unknown: "Inconnu",
};

export function StatusDot({ status, compact = false }: { status: HealthStatus; compact?: boolean }) {
  return (
    <span className={`status-dot status-dot--${status}`} aria-label={statusLabels[status]}>
      <span className="status-dot__mark" aria-hidden="true" />
      {!compact && <span>{statusLabels[status]}</span>}
    </span>
  );
}
