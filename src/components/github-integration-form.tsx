"use client";

import { useActionState, useEffect, useRef } from "react";
import { Check, GitBranch, ShieldCheck } from "lucide-react";
import { connectGitHub, type IntegrationActionState } from "@/app/settings/integrations/actions";

const initialState: IntegrationActionState = { status: "idle", message: "" };

export function GitHubIntegrationForm({ connectedLabel }: { connectedLabel?: string }) {
  const [state, action, pending] = useActionState(connectGitHub, initialState);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success") form.current?.reset();
  }, [state.status]);

  return (
    <form className="integration-form" action={action} ref={form}>
      <div className="integration-form__status">
        <span className="integration-icon"><GitBranch aria-hidden="true" /></span>
        <div>
          <h2>GitHub</h2>
          <p>{connectedLabel ?? "Aucun compte connecté"}</p>
          {connectedLabel && <small>L’identité est vérifiée ; l’accès aux dépôts privés dépend de leur sélection dans les réglages du jeton.</small>}
        </div>
        {connectedLabel && <span className="connection-state"><Check aria-hidden="true" /> Connecté</span>}
      </div>
      <div className="integration-form__body">
        <label>
          <span>Jeton d’accès finement paramétré</span>
          <input name="token" type="password" autoComplete="off" required minLength={20} placeholder="github_pat_…" />
          <small>Dans GitHub, sélectionne les dépôts à surveiller puis accorde « Contents: Read-only ». Le jeton est chiffré avant stockage.</small>
        </label>
        {state.message && (
          <p className={state.status === "error" ? "form-error" : "form-success"} role={state.status === "error" ? "alert" : "status"}>
            {state.status === "success" && <Check aria-hidden="true" />}{state.message}
          </p>
        )}
        <button className="button button--primary" type="submit" disabled={pending}>
          <ShieldCheck aria-hidden="true" />
          {pending ? "Vérification…" : connectedLabel ? "Remplacer le jeton" : "Vérifier et connecter"}
        </button>
      </div>
    </form>
  );
}
