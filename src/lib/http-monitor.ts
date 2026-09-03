import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  applications,
  checks,
  incidents,
  observations,
} from "@/db/schema";
import { createOrRefreshNotification, resolveNotification } from "@/lib/notifications";

const MAX_REDIRECTS = 5;
const MONITOR_USER_AGENT = "Luigi-Monitoring/0.1";

type ObservationStatus = "healthy" | "warning" | "critical";

export type HttpCheckResult = {
  checkId: string;
  applicationId: string;
  status: ObservationStatus;
  statusCode?: number;
  latencyMs: number;
  detail: string;
  incidentOpened: boolean;
  incidentResolved: boolean;
};

class MonitorTargetError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "MonitorTargetError";
  }
}

function isPrivateIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

async function assertPublicTarget(target: URL) {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new MonitorTargetError("Seules les URL HTTP et HTTPS sont autorisées.");
  }
  if (target.username || target.password) {
    throw new MonitorTargetError("Les identifiants intégrés à l’URL sont interdits.");
  }

  const addresses = await lookup(target.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new MonitorTargetError("La cible ne doit pas pointer vers une adresse locale ou privée.");
  }
}

async function fetchTarget(initialTarget: string, timeoutSeconds: number) {
  let target = new URL(initialTarget);
  const startedAt = performance.now();

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicTarget(target);
    const response = await fetch(target, {
      method: "GET",
      headers: { "User-Agent": MONITOR_USER_AGENT, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(Math.max(1, timeoutSeconds) * 1000),
    });

    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      if (redirect === MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new MonitorTargetError("Trop de redirections.");
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      target = new URL(location!, target);
      continue;
    }

    await response.body?.cancel();
    return {
      statusCode: response.status,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  throw new MonitorTargetError("Trop de redirections.");
}

function safeFailureDetail(error: unknown) {
  if (error instanceof MonitorTargetError) return error.reason;
  if (error instanceof Error && error.name === "TimeoutError") return "Le contrôle a dépassé son délai maximal.";
  if (error instanceof Error && error.name === "AbortError") return "Le contrôle a été interrompu après expiration du délai.";
  return "La cible n’a pas pu être jointe.";
}

export async function runHttpCheck(checkId: string): Promise<HttpCheckResult> {
  const [configuration] = await db
    .select({
      checkId: checks.id,
      applicationId: applications.id,
      workspaceId: applications.workspaceId,
      applicationName: applications.name,
      target: checks.target,
      timeoutSeconds: checks.timeoutSeconds,
      failureThreshold: checks.failureThreshold,
      latencyWarningMs: checks.latencyWarningMs,
    })
    .from(checks)
    .innerJoin(applications, eq(applications.id, checks.applicationId))
    .where(and(
      eq(checks.id, checkId),
      eq(checks.enabled, true),
      eq(checks.kind, "http"),
      isNull(applications.archivedAt),
    ))
    .limit(1);

  if (!configuration) throw new Error("CHECK_NOT_FOUND");

  let status: ObservationStatus = "critical";
  let statusCode: number | undefined;
  let latencyMs = 0;
  let detail = "La cible n’a pas pu être jointe.";

  const startedAt = performance.now();
  try {
    const response = await fetchTarget(configuration.target, configuration.timeoutSeconds);
    statusCode = response.statusCode;
    latencyMs = response.latencyMs;
    if (statusCode >= 200 && statusCode < 400) {
      status = latencyMs >= configuration.latencyWarningMs ? "warning" : "healthy";
      detail = status === "warning"
        ? `HTTP ${statusCode} · réponse lente (${latencyMs} ms)`
        : `HTTP ${statusCode}`;
    } else {
      detail = `HTTP ${statusCode}`;
    }
  } catch (error) {
    latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    detail = safeFailureDetail(error);
  }

  let incidentOpened = false;
  let incidentResolved = false;
  let openedIncidentId: string | undefined;
  let resolvedIncidentId: string | undefined;
  const observedAt = new Date();

  await db.transaction(async (transaction) => {
    await transaction.insert(observations).values({
      checkId: configuration.checkId,
      status,
      statusCode,
      latencyMs,
      detail,
      observedAt,
    });

    const recent = await transaction
      .select({ status: observations.status })
      .from(observations)
      .where(eq(observations.checkId, configuration.checkId))
      .orderBy(desc(observations.observedAt))
      .limit(configuration.failureThreshold);
    const thresholdReached = recent.length >= configuration.failureThreshold
      && recent.every((observation) => observation.status === "critical");
    const [openIncident] = await transaction
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(
        eq(incidents.checkId, configuration.checkId),
        inArray(incidents.status, ["open", "acknowledged"]),
      ))
      .limit(1);

    if (thresholdReached && !openIncident) {
      const [incident] = await transaction.insert(incidents).values({
        applicationId: configuration.applicationId,
        checkId: configuration.checkId,
        status: "open",
        title: `${configuration.applicationName} ne répond plus`,
        startedAt: observedAt,
      }).returning({ id: incidents.id });
      openedIncidentId = incident.id;
      incidentOpened = true;
    }

    if (status !== "critical" && openIncident) {
      await transaction
        .update(incidents)
        .set({ status: "resolved", resolvedAt: observedAt, updatedAt: observedAt })
        .where(eq(incidents.id, openIncident.id));
      resolvedIncidentId = openIncident.id;
      incidentResolved = true;
    }

    const applicationStatus = thresholdReached || openIncident && status === "critical"
      ? "critical"
      : status === "critical"
        ? "warning"
        : status;
    await transaction
      .update(applications)
      .set({ status: applicationStatus, lastCheckedAt: observedAt, updatedAt: observedAt })
      .where(eq(applications.id, configuration.applicationId));
  });

  if (openedIncidentId) {
    await createOrRefreshNotification({
      workspaceId: configuration.workspaceId,
      title: `${configuration.applicationName} est indisponible`,
      body: `${configuration.failureThreshold} contrôles ont échoué consécutivement. Dernier résultat : ${detail}`,
      severity: "critical",
      targetUrl: `/#application-${configuration.applicationId}`,
      fingerprint: `availability:incident:${openedIncidentId}`,
    });
  }
  if (resolvedIncidentId) {
    await resolveNotification(configuration.workspaceId, `availability:incident:${resolvedIncidentId}`, {
      title: `${configuration.applicationName} répond à nouveau`,
      body: `${detail} en ${latencyMs} ms. L’incident a été résolu automatiquement.`,
      targetUrl: `/#application-${configuration.applicationId}`,
    });
  }

  return {
    checkId: configuration.checkId,
    applicationId: configuration.applicationId,
    status,
    statusCode,
    latencyMs,
    detail,
    incidentOpened,
    incidentResolved,
  };
}

export async function runWorkspaceHttpChecks(workspaceId?: string, dueOnly = false) {
  const predicates = [eq(checks.enabled, true), eq(checks.kind, "http"), isNull(applications.archivedAt)];
  if (workspaceId) predicates.push(eq(applications.workspaceId, workspaceId));
  if (dueOnly) {
    predicates.push(or(
      isNull(applications.lastCheckedAt),
      sql`${applications.lastCheckedAt} <= now() - (${checks.intervalSeconds} * interval '1 second')`,
    )!);
  }
  const configuredChecks = await db
    .select({ id: checks.id })
    .from(checks)
    .innerJoin(applications, eq(applications.id, checks.applicationId))
    .where(and(...predicates));

  const results: HttpCheckResult[] = [];
  for (let index = 0; index < configuredChecks.length; index += 4) {
    results.push(...await Promise.all(
      configuredChecks.slice(index, index + 4).map(({ id }) => runHttpCheck(id)),
    ));
  }
  return results;
}
