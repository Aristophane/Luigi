"use client";

import { useActionState } from "react";
import { Check, MessageSquare, Send } from "lucide-react";
import { sendDiscordTest, type IntegrationActionState } from "@/app/settings/integrations/actions";

const initialState: IntegrationActionState = { status: "idle", message: "" };

export function DiscordIntegration({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(sendDiscordTest, initialState);

  return (
    <section className="integration-form" aria-labelledby="discord-integration-title">
      <div className="integration-form__status">
        <span className="integration-icon"><MessageSquare aria-hidden="true" /></span>
        <div>
          <h2 id="discord-integration-title">Discord</h2>
          <p>Deuxième canal d’alerte, indépendant des navigateurs abonnés.</p>
        </div>
        {configured && <span className="connection-state"><Check aria-hidden="true" /> Prêt</span>}
      </div>
      <form className="integration-form__body deployment-integration__body" action={action}>
        {configured ? (
          <p>
            Les alertes critiques et élevées, les silences de collecte et les retours à la normale sont publiés dans le salon
            relié, en même temps que les notifications Web Push.
          </p>
        ) : (
          <>
            <p>Ajoute l’URL d’un webhook Discord au serveur Luigi, puis redémarre-le.</p>
            <code>DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…</code>
            <small>Dans Discord : paramètres du salon → Intégrations → Webhooks → Nouveau webhook → Copier l’URL.</small>
          </>
        )}
        {state.message && (
          <p className={state.status === "error" ? "form-error" : "form-success"} role={state.status === "error" ? "alert" : "status"}>
            {state.status === "success" && <Check aria-hidden="true" />}{state.message}
          </p>
        )}
        {configured && (
          <button className="button button--secondary" type="submit" disabled={pending}>
            <Send aria-hidden="true" />
            {pending ? "Envoi…" : "Envoyer un message de test"}
          </button>
        )}
      </form>
    </section>
  );
}
