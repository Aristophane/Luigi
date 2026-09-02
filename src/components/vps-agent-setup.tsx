"use client";

import { useActionState, useState } from "react";
import { Check, Clipboard, KeyRound, RadioTower } from "lucide-react";
import { issueVpsAgentToken, type VpsAgentActionState } from "@/app/settings/vps/actions";

const initialState: VpsAgentActionState = { status: "idle", message: "" };

type VpsAgentSetupProps = {
  configured: boolean;
  label?: string;
  lastSyncedLabel?: string;
  endpoint: string;
};

export function VpsAgentSetup({ configured, label, lastSyncedLabel, endpoint }: VpsAgentSetupProps) {
  const [state, action, pending] = useActionState(issueVpsAgentToken, initialState);
  const [copied, setCopied] = useState<"token" | "command" | null>(null);
  const activeEndpoint = state.endpoint ?? endpoint;
  const insecureFlag = activeEndpoint.startsWith("http://") ? " --allow-insecure-http" : "";
  const installCommand = `sudo bash agent/install.sh --endpoint ${JSON.stringify(activeEndpoint)} --agent-id ${JSON.stringify(state.agentId ?? "AGENT_ID")}${insecureFlag}`;

  async function copy(value: string, kind: "token" | "command") {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1800);
  }

  return (
    <section className="agent-setup" aria-labelledby="agent-setup-title">
      <div className="agent-setup__status">
        <span className={`agent-beacon ${lastSyncedLabel ? "agent-beacon--online" : ""}`} aria-hidden="true"><RadioTower /></span>
        <div>
          <p className="eyebrow">Collecteur sortant</p>
          <h2 id="agent-setup-title">{label ?? "Agent Ubuntu non configuré"}</h2>
          <p>{lastSyncedLabel ? `Dernier rapport ${lastSyncedLabel}` : "Aucun rapport reçu. Luigi ne peut pas encore confirmer l’état du VPS."}</p>
        </div>
        <span className={`connection-state ${lastSyncedLabel ? "" : "connection-state--idle"}`}>
          {lastSyncedLabel ? <><Check aria-hidden="true" /> En ligne</> : "En attente"}
        </span>
      </div>

      <ol className="agent-steps" aria-label="Étapes de connexion du VPS">
        <li className={configured ? "agent-step agent-step--done" : "agent-step agent-step--active"}><span>1</span><strong>Créer le jeton</strong><small>Empreinte stockée dans Luigi</small></li>
        <li className={state.token ? "agent-step agent-step--active" : "agent-step"}><span>2</span><strong>Installer l’agent</strong><small>Script Python sans dépendance</small></li>
        <li className={lastSyncedLabel ? "agent-step agent-step--done" : "agent-step"}><span>3</span><strong>Recevoir un rapport</strong><small>CPU, mémoire, disque et sécurité</small></li>
      </ol>

      {!state.token ? (
        <form action={action} className="agent-setup__action">
          <div className="agent-setup__fields">
            <div className="agent-setup__action-heading">
              <KeyRound aria-hidden="true" />
              <span><strong>{configured ? "Renouveler l’accès" : "Préparer l’enrôlement"}</strong><small>{configured ? "Le jeton actuellement installé sur le VPS sera immédiatement invalidé." : "Le secret brut ne sera affiché qu’une seule fois."}</small></span>
            </div>
            <label>
              <span>URL de Luigi accessible depuis le VPS</span>
              <input name="endpoint" type="url" required defaultValue={activeEndpoint} placeholder="https://monitoring.example.com" />
              <small>En production, utilise une adresse HTTPS. Luigi ajoutera automatiquement le chemin de réception.</small>
            </label>
          </div>
          <div className="agent-setup__submit">
            {state.status === "error" && <p className="form-error" role="alert">{state.message}</p>}
            <button className={configured ? "button button--secondary" : "button button--primary"} type="submit" disabled={pending}>
              {pending ? "Création…" : configured ? "Créer un nouveau jeton" : "Créer le jeton agent"}
            </button>
          </div>
        </form>
      ) : (
        <div className="agent-credentials" role="status">
          <div className="agent-credentials__heading"><Check aria-hidden="true" /><span><strong>Enrôlement prêt</strong><small>{state.message}</small></span></div>
          <label>
            <span>Jeton à saisir sur le VPS</span>
            <span className="copy-field"><code>{state.token}</code><button type="button" onClick={() => copy(state.token!, "token")}><Clipboard aria-hidden="true" />{copied === "token" ? "Copié" : "Copier"}</button></span>
          </label>
          <label>
            <span>Commande depuis la racine du dépôt Luigi</span>
            <span className="copy-field"><code>{installCommand}</code><button type="button" onClick={() => copy(installCommand, "command")}><Clipboard aria-hidden="true" />{copied === "command" ? "Copiée" : "Copier"}</button></span>
          </label>
          <p className="agent-credentials__note">Le script demandera le jeton sans l’ajouter à l’historique du shell, puis activera un timer systemd toutes les cinq minutes.</p>
        </div>
      )}
    </section>
  );
}
