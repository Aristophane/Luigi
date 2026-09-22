"use client";
import { useActionState } from "react";
import { saveEssentialService } from "@/app/settings/vps/actions";

export function EssentialServiceForm({ serverId, serviceKey, label, applicationId, applications }: {
  serverId: string; serviceKey: string; label: string; applicationId?: string;
  applications: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(saveEssentialService, { message: "" });
  return <form action={action} className="essential-service-form">
    <input type="hidden" name="serverId" value={serverId} />
    <input type="hidden" name="serviceKey" value={serviceKey} />
    <label><span>{label}</span><select name="applicationId" defaultValue={applicationId ?? ""} aria-label={`Application dépendant de ${label}`}>
      <option value="">Hors du statut des applications</option>
      {applications.map((app) => <option key={app.id} value={app.id}>Essentiel pour {app.name}</option>)}
    </select></label>
    <button type="submit" className="button button--secondary" disabled={pending}>{pending ? "Enregistrement…" : "Enregistrer"}</button>
    <small role="status">{state.message}</small>
  </form>;
}
