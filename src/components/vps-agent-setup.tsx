"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Clipboard, KeyRound, RadioTower, TerminalSquare } from "lucide-react";
import { issueVpsAgentEnrollment, type VpsAgentActionState } from "@/app/settings/vps/actions";

const initialState: VpsAgentActionState = { status: "idle", message: "" };

type VpsAgentSetupProps = {
  configured: boolean;
  connected: boolean;
  label?: string;
  lastSyncedAt?: string;
  lastSyncedLabel?: string;
  enrolledAt?: string;
  systemLabel?: string;
  endpoint: string;
};

type StepState = "pending" | "active" | "done";

export function VpsAgentSetup({
  configured,
  connected,
  label,
  lastSyncedAt,
  lastSyncedLabel,
  enrolledAt,
  systemLabel,
  endpoint,
}: VpsAgentSetupProps) {
  const router = useRouter();
  const [state, action, pending] = useActionState(issueVpsAgentEnrollment, initialState);
  const [copied, setCopied] = useState<"primary" | "fallback" | null>(null);
  const [expired, setExpired] = useState(false);
  const activeEndpoint = state.endpoint ?? endpoint;
  const waitingForNewReport = !expired && Boolean(
    state.installCommand
    && state.issuedAt
    && (!lastSyncedAt || new Date(lastSyncedAt) <= new Date(state.issuedAt)),
  );
  const enrollmentRedeemed = Boolean(
    state.issuedAt
    && enrolledAt
    && new Date(enrolledAt) >= new Date(state.issuedAt),
  );
  const installationComplete = Boolean(state.installCommand && !waitingForNewReport);

  useEffect(() => {
    if (!waitingForNewReport) return;
    const interval = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(interval);
  }, [router, waitingForNewReport]);

  useEffect(() => {
    if (!state.expiresAt || enrollmentRedeemed) return;
    const delay = new Date(state.expiresAt).getTime() - Date.now();
    const timeout = window.setTimeout(() => setExpired(true), Math.max(0, delay));
    return () => window.clearTimeout(timeout);
  }, [enrollmentRedeemed, state.expiresAt]);

  const expiryLabel = useMemo(() => state.expiresAt
    ? new Date(state.expiresAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : null, [state.expiresAt]);

  async function copyCommand(value: string, target: "primary" | "fallback") {
    await navigator.clipboard.writeText(value);
    setCopied(target);
    window.setTimeout(() => setCopied(null), 1800);
  }

  function stepState(step: number): StepState {
    if (state.installCommand) {
      if (step === 1) return "done";
      if (step === 2) return enrollmentRedeemed || installationComplete ? "done" : "active";
      if (step === 3) return installationComplete ? "done" : enrollmentRedeemed ? "active" : "pending";
      return installationComplete ? "done" : "pending";
    }
    if (lastSyncedAt) return "done";
    if (configured) return step <= 2 ? "done" : step === 3 ? "active" : "pending";
    return step === 1 ? "active" : "pending";
  }

  const steps = [
    ["Commande prête", "Code éphémère"],
    ["Installation", "Ubuntu ou Debian"],
    ["Premier rapport", "Connexion sortante"],
    ["VPS en ligne", "Métriques actives"],
  ];

  return (
    <section className="agent-setup" aria-labelledby="agent-setup-title">
      <div className="agent-setup__status">
        <span className={`agent-beacon ${connected ? "agent-beacon--online" : ""}`} aria-hidden="true"><RadioTower /></span>
        <div>
          <p className="eyebrow">Collecteur sortant</p>
          <h2 id="agent-setup-title">{label ?? "Connecter un VPS"}</h2>
          <p>
            {lastSyncedLabel
              ? `${systemLabel ? `${systemLabel} · ` : ""}Dernier rapport ${lastSyncedLabel}`
              : configured
                ? "L’agent est authentifié. Luigi attend son premier rapport."
                : "Une commande, puis Luigi détecte automatiquement Ubuntu ou Debian."}
          </p>
        </div>
        <span className={`connection-state ${connected ? "" : "connection-state--idle"}`}>
          {connected ? <><Check aria-hidden="true" /> En ligne</> : configured ? "Connexion…" : "Non connecté"}
        </span>
      </div>

      <ol className="agent-steps agent-steps--four" aria-label="Progression de la connexion du VPS">
        {steps.map(([title, detail], index) => {
          const status = stepState(index + 1);
          return (
            <li className={`agent-step agent-step--${status}`} key={title}>
              <span>{status === "done" ? <Check aria-hidden="true" /> : index + 1}</span>
              <strong>{title}</strong>
              <small>{detail}</small>
            </li>
          );
        })}
      </ol>

      {installationComplete ? (
        <div className="agent-connected" role="status">
          <Check aria-hidden="true" />
          <div><strong>Le VPS transmet ses métriques.</strong><p>La prochaine collecte sera envoyée automatiquement dans environ cinq minutes.</p></div>
        </div>
      ) : state.installCommand ? (
        <div className="agent-credentials" aria-live="polite">
          <div className="agent-credentials__heading">
            <TerminalSquare aria-hidden="true" />
            <span><strong>Colle cette commande sur le VPS</strong><small>{state.message}{expiryLabel ? ` Expiration à ${expiryLabel}.` : ""}</small></span>
          </div>
          <div className="copy-field copy-field--command">
            <code>{state.installCommand}</code>
            <button type="button" onClick={() => copyCommand(state.installCommand!, "primary")}><Clipboard aria-hidden="true" />{copied === "primary" ? "Copiée" : "Copier"}</button>
          </div>
          <div className={`agent-waiting ${expired && !enrollmentRedeemed ? "agent-waiting--expired" : ""}`}>
            <span className="agent-waiting__signal" aria-hidden="true" />
            <p>
              <strong>{expired && !enrollmentRedeemed ? "La commande a expiré." : enrollmentRedeemed ? "Agent installé, premier rapport en cours…" : "En attente de la commande…"}</strong>
              <small>{expired && !enrollmentRedeemed ? "Recharge la page pour générer un nouveau code sécurisé." : "Tu peux laisser cette page ouverte : elle se met à jour toute seule."}</small>
            </p>
            {expired && !enrollmentRedeemed && <button className="button button--secondary" type="button" onClick={() => window.location.reload()}>Nouvelle commande</button>}
          </div>
          <details className="agent-details">
            <summary>Vérifier le script avant de l’exécuter</summary>
            <p>Le script détecte Ubuntu ou Debian, crée un compte système dédié et installe un timer toutes les cinq minutes.</p>
            {state.installUrl && <a className="text-link" href={state.installUrl} target="_blank" rel="noreferrer">Ouvrir le script d’installation</a>}
            {state.fallbackCommand && (
              <div className="agent-fallback-command">
                <span>Si <code>curl</code> n’est pas installé :</span>
                <div className="copy-field"><code>{state.fallbackCommand}</code><button type="button" onClick={() => copyCommand(state.fallbackCommand!, "fallback")}><Clipboard aria-hidden="true" />{copied === "fallback" ? "Copiée" : "Copier"}</button></div>
              </div>
            )}
          </details>
        </div>
      ) : (
        <form action={action} className="agent-setup__action">
          <div className="agent-setup__fields">
            <div className="agent-setup__action-heading">
              <KeyRound aria-hidden="true" />
              <span>
                <strong>{configured ? "Préparer une réinstallation" : "Prêt en moins de deux minutes"}</strong>
                <small>{configured ? "L’agent actuel reste valide jusqu’à l’exécution de la nouvelle commande." : "Ubuntu et Debian sont détectés automatiquement."}</small>
              </span>
            </div>
            <details className="agent-details agent-details--compact">
              <summary>Options avancées</summary>
              <label>
                <span>Adresse de Luigi accessible depuis le VPS</span>
                <input name="endpoint" type="url" required defaultValue={activeEndpoint} placeholder="https://monitoring.example.com" />
                <small>HTTPS est obligatoire en production. Le chemin de réception est ajouté automatiquement.</small>
              </label>
            </details>
          </div>
          <div className="agent-setup__submit">
            {state.status === "error" && <p className="form-error" role="alert">{state.message}</p>}
            <button className={configured ? "button button--secondary" : "button button--primary"} type="submit" disabled={pending}>
              {pending ? "Préparation…" : configured ? "Générer une nouvelle commande" : "Connecter mon VPS"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
