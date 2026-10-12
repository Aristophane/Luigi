"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, GitBranch, RefreshCw, ShieldCheck } from "lucide-react";
import { connectGitHub, verifyStoredGitHubToken, type IntegrationActionState } from "@/app/settings/integrations/actions";
import { GitHubTokenStatus } from "@/components/github-token-status";
import type { GitHubTokenHealth } from "@/lib/github-token-health";

const initialState: IntegrationActionState = { status: "idle", message: "" };

export function GitHubIntegrationForm({ connectedLabel, health = { status: "unknown" } }: { connectedLabel?: string; health?: GitHubTokenHealth }) {
  const [state, action, pending] = useActionState(connectGitHub, initialState);
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [checking, startCheck] = useTransition();
  const [checkResult, setCheckResult] = useState<IntegrationActionState>();

  useEffect(() => {
    if (state.status === "success") form.current?.reset();
  }, [state.status]);

  return (
    <form className="integration-form" id="github-integration" action={action} ref={form} onSubmit={() => setCheckResult(undefined)}>
      <div className="integration-form__status">
        <span className="integration-icon"><GitBranch aria-hidden="true" /></span>
        <div>
          <h2>GitHub</h2>
          <p>{connectedLabel ?? "Aucun compte connecté"}</p>
          {connectedLabel && <small>L’accès aux dépôts privés dépend de leur sélection dans les réglages du jeton.</small>}
        </div>
        {connectedLabel && health.status === "valid" && <span className="connection-state"><Check aria-hidden="true" /> Vérifié</span>}
      </div>
      <div className="integration-form__body">
        {connectedLabel && <>
          <GitHubTokenStatus health={health} />
          <button className="button button--secondary" type="button" disabled={checking || pending}
            onClick={() => startCheck(async () => {
              setCheckResult(await verifyStoredGitHubToken());
              router.refresh();
            })}>
            <RefreshCw aria-hidden="true" className={checking ? "spin" : undefined} />
            {checking ? "Vérification…" : "Vérifier le jeton"}
          </button>
          {checkResult && <p className={checkResult.status === "error" ? "form-error" : "form-success"} role="status">{checkResult.message}</p>}
        </>}
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
        <button className="button button--primary" type="submit" disabled={pending || checking}>
          <ShieldCheck aria-hidden="true" />
          {pending ? "Vérification…" : connectedLabel ? "Remplacer le jeton" : "Vérifier et connecter"}
        </button>
      </div>
    </form>
  );
}
