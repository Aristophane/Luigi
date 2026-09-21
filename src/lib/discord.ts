import "server-only";

type DiscordSeverity = "critical" | "high" | "medium" | "low";

export type DiscordAlert = {
  title: string;
  body: string;
  severity: DiscordSeverity;
  targetUrl: string;
};

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);
const DELIVERY_TIMEOUT_MS = 5_000;

const severityColors: Record<DiscordSeverity, number> = {
  critical: 0xd6453d,
  high: 0xd99a1e,
  medium: 0x6b5bd2,
  low: 0x2f9e62,
};

const severityLabels: Record<DiscordSeverity, string> = {
  critical: "Critique",
  high: "Élevée",
  medium: "Moyenne",
  low: "Information",
};

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/** N’accepte qu’un webhook Discord en HTTPS : une faute de frappe ne doit pas envoyer les alertes ailleurs. */
export function parseDiscordWebhookUrl(value: string | undefined) {
  try {
    const url = new URL(value?.trim() ?? "");
    return url.protocol === "https:" && DISCORD_HOSTS.has(url.hostname) && url.pathname.startsWith("/api/webhooks/")
      ? url
      : null;
  } catch {
    return null;
  }
}

export function isDiscordConfigured() {
  return parseDiscordWebhookUrl(process.env.DISCORD_WEBHOOK_URL) !== null;
}

export function buildDiscordMessage(alert: DiscordAlert, baseUrl: string | undefined, sentAt: Date) {
  let link: string | undefined;
  try {
    link = baseUrl ? new URL(alert.targetUrl, baseUrl).toString() : undefined;
  } catch {
    link = undefined;
  }
  return {
    username: "Luigi",
    // Le texte vient des constats ; aucune mention @everyone ou @here ne doit pouvoir s’y glisser.
    allowed_mentions: { parse: [] },
    embeds: [{
      title: truncate(alert.title, 256),
      description: truncate(alert.body, 2_000),
      url: link,
      color: severityColors[alert.severity],
      footer: { text: `Luigi · ${severityLabels[alert.severity]}` },
      timestamp: sentAt.toISOString(),
    }],
  };
}

/** Ne lève jamais d’erreur : un canal indisponible ne doit pas bloquer le traitement d’un incident. */
export async function sendDiscordAlert(alert: DiscordAlert) {
  const webhook = parseDiscordWebhookUrl(process.env.DISCORD_WEBHOOK_URL);
  if (!webhook) return { delivered: false, reason: "not_configured" as const };

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDiscordMessage(alert, process.env.BETTER_AUTH_URL, new Date())),
      cache: "no-store",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok) {
      console.error("Discord delivery failed", { status: response.status });
      return { delivered: false, reason: "delivery_failed" as const, status: response.status };
    }
    return { delivered: true as const };
  } catch (error) {
    console.error("Discord delivery failed", { error: error instanceof Error ? error.name : "unknown" });
    return { delivered: false, reason: "delivery_failed" as const };
  }
}
