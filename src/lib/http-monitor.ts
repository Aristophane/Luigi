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
import {
  describeResource,
  extractImageCandidates,
  resolveAssetUrl,
  truncateLabel,
} from "@/lib/content-probe";
import { createOrRefreshNotification, resolveNotification } from "@/lib/notifications";

const MAX_REDIRECTS = 5;
const MONITOR_USER_AGENT = "Luigi-Monitoring/0.1";
const PAGE_ACCEPT = "text/html,application/json;q=0.9,*/*;q=0.8";
const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
const MAX_PAGE_BYTES = 1024 * 1024;
const MIN_IMAGE_BYTES = 16;
const CONTENT_INCIDENT_SUFFIX = " : rendu dégradé";

type ObservationStatus = "healthy" | "warning" | "critical";

const statusRank: Record<ObservationStatus, number> = { healthy: 0, warning: 1, critical: 2 };

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

async function readBody(response: Response, maxBytes: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, Math.min(received, maxBytes));
}

type FetchOptions = {
  accept?: string;
  /** Nombre maximal d’octets du corps à conserver ; sans valeur, le corps est ignoré. */
  readBytes?: number;
};

async function fetchTarget(initialTarget: string, timeoutSeconds: number, options: FetchOptions = {}) {
  let target = new URL(initialTarget);
  const startedAt = performance.now();

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicTarget(target);
    const response = await fetch(target, {
      method: "GET",
      headers: { "User-Agent": MONITOR_USER_AGENT, Accept: options.accept ?? PAGE_ACCEPT },
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

    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    let body: Buffer | undefined;
    if (options.readBytes) {
      body = await readBody(response, options.readBytes);
    } else {
      await response.body?.cancel();
    }
    return {
      statusCode: response.status,
      latencyMs,
      url: target.toString(),
      contentType: response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "",
      cacheStatus: response.headers.get("x-nextjs-cache")?.trim().toUpperCase(),
      body,
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

type RenderingCheck = {
  expectedText: string | null;
  assetProbe: boolean;
  assetUrl: string | null;
  timeoutSeconds: number;
  latencyWarningMs: number;
};

type RenderingResult = { status: ObservationStatus; summary: string };

function assetFailureSummary(error: unknown, resource: string) {
  if (error instanceof MonitorTargetError) return `image non vérifiable (${resource}) · ${error.reason}`;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `l’image n’a pas répondu dans le délai (${resource})`;
  }
  return `image injoignable (${resource})`;
}

/**
 * Vérifie ce que voit réellement le visiteur : une page peut répondre HTTP 200
 * alors que ses images, servies par un processus Node saturé, ne se chargent plus.
 */
async function inspectRendering(check: RenderingCheck, page: { url: string; body?: Buffer }): Promise<RenderingResult> {
  const html = new TextDecoder("utf-8").decode(page.body ?? Buffer.alloc(0));
  const verified: string[] = [];

  if (check.expectedText) {
    if (!html.includes(check.expectedText)) {
      return { status: "critical", summary: `texte attendu absent : « ${truncateLabel(check.expectedText, 60)} »` };
    }
    verified.push("texte attendu présent");
  }
  if (!check.assetProbe) return { status: "healthy", summary: verified.join(" · ") };

  const assetTarget = check.assetUrl
    ? resolveAssetUrl(check.assetUrl, page.url)
    : extractImageCandidates(html, page.url)[0];
  if (!assetTarget) {
    return {
      status: "critical",
      summary: check.assetUrl ? "l’URL de l’image à vérifier est invalide" : "aucune image trouvée dans la page",
    };
  }

  const resource = describeResource(assetTarget);
  try {
    const asset = await fetchTarget(assetTarget, check.timeoutSeconds, { accept: IMAGE_ACCEPT, readBytes: MIN_IMAGE_BYTES });
    if (asset.statusCode < 200 || asset.statusCode >= 300) {
      return { status: "critical", summary: `image en erreur HTTP ${asset.statusCode} (${resource})` };
    }
    if (!asset.contentType.startsWith("image/")) {
      return { status: "critical", summary: `l’image renvoie ${asset.contentType || "un type inconnu"} (${resource})` };
    }
    const receivedBytes = asset.body?.byteLength ?? 0;
    if (receivedBytes < MIN_IMAGE_BYTES) {
      return { status: "critical", summary: `image vide (${receivedBytes} octet${receivedBytes > 1 ? "s" : ""}, ${resource})` };
    }
    const cache = asset.cacheStatus ? ` · cache ${asset.cacheStatus}` : "";
    if (asset.latencyMs >= check.latencyWarningMs) {
      return { status: "warning", summary: [...verified, `image lente (${asset.latencyMs} ms, ${resource})${cache}`].join(" · ") };
    }
    verified.push(`image servie en ${asset.latencyMs} ms${cache}`);
    return { status: "healthy", summary: verified.join(" · ") };
  } catch (error) {
    return { status: "critical", summary: assetFailureSummary(error, resource) };
  }
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
      expectedText: checks.expectedText,
      assetProbe: checks.assetProbe,
      assetUrl: checks.assetUrl,
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
  let failureKind: "availability" | "rendering" = "availability";
  const inspectsRendering = Boolean(configuration.expectedText) || configuration.assetProbe;

  const startedAt = performance.now();
  try {
    const response = await fetchTarget(
      configuration.target,
      configuration.timeoutSeconds,
      inspectsRendering ? { readBytes: MAX_PAGE_BYTES } : {},
    );
    statusCode = response.statusCode;
    latencyMs = response.latencyMs;
    if (statusCode >= 200 && statusCode < 400) {
      status = latencyMs >= configuration.latencyWarningMs ? "warning" : "healthy";
      detail = status === "warning"
        ? `HTTP ${statusCode} · réponse lente (${latencyMs} ms)`
        : `HTTP ${statusCode}`;
      if (inspectsRendering) {
        const rendering = await inspectRendering(configuration, response);
        if (rendering.summary) detail = `${detail} · ${rendering.summary}`;
        if (statusRank[rendering.status] > statusRank[status]) status = rendering.status;
        if (rendering.status === "critical") failureKind = "rendering";
      }
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
  let resolvedRenderingIncident = false;
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
      .select({ id: incidents.id, title: incidents.title })
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
        title: failureKind === "rendering"
          ? `${configuration.applicationName}${CONTENT_INCIDENT_SUFFIX}`
          : `${configuration.applicationName} ne répond plus`,
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
      resolvedRenderingIncident = openIncident.title.endsWith(CONTENT_INCIDENT_SUFFIX);
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
      title: failureKind === "rendering"
        ? `${configuration.applicationName} affiche un rendu dégradé`
        : `${configuration.applicationName} est indisponible`,
      body: failureKind === "rendering"
        ? `La page répond, mais ${configuration.failureThreshold} contrôles consécutifs signalent un rendu incomplet. Dernier résultat : ${detail}`
        : `${configuration.failureThreshold} contrôles ont échoué consécutivement. Dernier résultat : ${detail}`,
      severity: "critical",
      targetUrl: `/#application-${configuration.applicationId}`,
      fingerprint: `availability:incident:${openedIncidentId}`,
    });
  }
  if (resolvedIncidentId) {
    await resolveNotification(configuration.workspaceId, `availability:incident:${resolvedIncidentId}`, {
      title: resolvedRenderingIncident
        ? `${configuration.applicationName} s’affiche à nouveau correctement`
        : `${configuration.applicationName} répond à nouveau`,
      body: inspectsRendering
        ? `${detail} · page servie en ${latencyMs} ms. L’incident a été résolu automatiquement.`
        : `${detail} en ${latencyMs} ms. L’incident a été résolu automatiquement.`,
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
