import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { deliveryAttempts, jobs, notificationDeliveries, notifications } from "@/db/schema";
import { readiness } from "@/lib/readiness";
import { retryDelivery } from "@/app/settings/integrations/actions";

const labels: Record<string, string> = { queued: "En attente", sending: "En cours", delivered: "Livrée", retrying: "Nouvelle tentative prévue",
  failed: "Échec définitif", skipped: "Canal non disponible", started: "Démarrée · résultat non confirmé", succeeded: "Traitée" };

export async function DeliveryLog({ workspaceId }: { workspaceId: string }) {
  const state = await readiness();
  const entries = await db.select({ delivery: notificationDeliveries, notification: notifications })
    .from(notificationDeliveries).innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .where(eq(notifications.workspaceId, workspaceId)).orderBy(desc(notificationDeliveries.createdAt)).limit(40);
  const attempts = entries.length ? await db.select().from(deliveryAttempts)
    .where(inArray(deliveryAttempts.deliveryId, entries.map(({ delivery }) => delivery.id))).orderBy(desc(deliveryAttempts.createdAt)) : [];
  const failedJobs = await db.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.status, "failed")))
    .orderBy(desc(jobs.updatedAt)).limit(20);
  return <section id="delivery-log" className="delivery-log" aria-labelledby="delivery-log-title">
    <h2 id="delivery-log-title">Supervision et livraison</h2>
    <p className={state.ready ? "" : "collection-warning"}>{state.ready ? "Worker actif · files surveillées" : "Worker absent, périmé ou file en retard"}</p>
    <p>Readiness : <code>/api/ready</code>. Ce témoin doit être contrôlé depuis une autre machine pour détecter un arrêt complet de Luigi.</p>
    {failedJobs.length > 0 && <details><summary>{failedJobs.length} tâches en échec (20 dernières au maximum)</summary><ul>
      {failedJobs.map((job) => <li key={job.id}>{job.kind} · {job.attempts}/{job.maxAttempts} tentatives · {job.lastError ?? "Délai dépassé"}</li>)}
    </ul></details>}
    {!entries.length && <p>Aucun envoi enregistré. Les prochaines alertes afficheront ici leur résultat par canal.</p>}
    {entries.map(({ delivery, notification }) => {
      const failed = failedJobs.some((job) => job.payload.deliveryId === delivery.id);
      const status = failed && delivery.status !== "delivered" ? "failed" : delivery.status;
      return <details key={delivery.id} className="delivery-log__entry">
        <summary><strong>{notification.title}</strong><span>{delivery.channel === "discord" ? "Discord" : "Web Push"} · {labels[status] ?? status}</span></summary>
        <small>{delivery.createdAt.toLocaleString("fr-FR")} · {delivery.recipient === "webhook" ? "Salon configuré" : delivery.recipient === "none" ? "Aucun navigateur" : "Navigateur " + delivery.recipient.slice(0, 8)}</small>
        <ol>{attempts.filter((attempt) => attempt.deliveryId === delivery.id).map((attempt) => <li key={attempt.id}>
          {attempt.createdAt.toLocaleString("fr-FR")} · {labels[attempt.outcome] ?? attempt.outcome}{attempt.detail ? " · " + attempt.detail : ""}
        </li>)}</ol>
        {["failed", "skipped"].includes(status) && !notification.resolvedAt && delivery.recipient !== "none" && <form action={retryDelivery.bind(null, delivery.id)}>
          <button type="submit" className="button button--secondary">Relancer l’envoi</button>
        </form>}
      </details>;
    })}
  </section>;
}
