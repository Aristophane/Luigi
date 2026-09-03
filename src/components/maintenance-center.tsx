"use client";

import { AlertTriangle, Check, ChevronDown, CircleDot, Clock3, History, ListChecks, RotateCcw, ShieldCheck, Wrench } from "lucide-react";
import { useActionState, useEffect, useMemo, useState } from "react";
import { completeMaintenanceTask, createMaintenanceTask, reopenMaintenanceTask, setMaintenanceTaskStatus, type CreateTaskState } from "@/app/actions";
import type { MaintenanceTask } from "@/lib/domain";
import { maintenanceGuidance } from "@/lib/maintenance-guidance";

type Event = { id: string; taskId: string; action: string; note: string | null; createdLabel: string };
type Props = { tasks: MaintenanceTask[]; events: Event[]; applications: { id: string; name: string }[]; initialCategory: string };

const severityLabels = { critical: "Critique", high: "Élevée", medium: "Moyenne", low: "Faible" };
const categoryLabels = { security: "Sécurité", dependency: "Dépendances", capacity: "Capacité", backup: "Sauvegardes", lifecycle: "Cycle de vie" };
const statusLabels = { open: "À faire", planned: "Planifiée", in_progress: "En cours", done: "Terminée", dismissed: "Classée" };
const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

export function MaintenanceCenter({ tasks, events, applications, initialCategory }: Props) {
  const [application, setApplication] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [category, setCategory] = useState(initialCategory);
  const [scope, setScope] = useState<"active" | "history">("active");
  const [creating, setCreating] = useState(false);
  const [createState, createAction, createPending] = useActionState<CreateTaskState, FormData>(createMaintenanceTask, { status: "idle", message: "" });

  useEffect(() => {
    const stored = window.localStorage.getItem("luigi-theme");
    document.documentElement.dataset.theme = stored === "dark" || (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }, []);

  const activeTasks = tasks.filter((task) => ["open", "planned", "in_progress"].includes(task.status));
  const securityCount = activeTasks.filter((task) => task.category === "security").length;
  const urgentCount = activeTasks.filter((task) => ["critical", "high"].includes(task.severity)).length;
  const applicationCount = new Set(activeTasks.map((task) => task.applicationId ?? "infrastructure")).size;
  const filtered = useMemo(() => tasks.filter((task) => {
    const active = ["open", "planned", "in_progress"].includes(task.status);
    return (scope === "active" ? active : !active)
      && (application === "all" || (application === "infrastructure" ? task.applicationId === null : task.applicationId === application))
      && (severity === "all" || task.severity === severity)
      && (category === "all" || task.category === category);
  }).sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]), [tasks, scope, application, severity, category]);

  const groups = useMemo(() => Array.from(new Map(filtered.map((task) => [task.applicationId ?? "infrastructure", task.applicationName])))
    .map(([id, name]) => ({ id, name, tasks: filtered.filter((task) => (task.applicationId ?? "infrastructure") === id) })), [filtered]);

  return <>
    <header className="maintenance-heading">
      <div><p className="eyebrow">Centre d’intervention</p><h1>Maintenance & sécurité.</h1><p>Chaque signal mène à une procédure, une ressource et un contrôle de sortie.</p></div>
      <button className="button button--secondary" type="button" onClick={() => setCreating((value) => !value)}><Wrench aria-hidden="true" /> {creating ? "Fermer" : "Ajouter une action"}</button>
    </header>

    {creating && <form className="maintenance-create" action={createAction}>
      <div className="maintenance-create__heading"><div><p className="eyebrow">Action manuelle</p><h2>Décrire l’intervention</h2></div><p>Les détails serviront de procédure et de preuve de sortie.</p></div>
      <label className="maintenance-create__title"><span>Action à réaliser</span><input name="title" required minLength={3} maxLength={140} placeholder="Ex. Renouveler le certificat du service" /></label>
      <label><span>Application</span><select name="applicationId" defaultValue="infrastructure"><option value="infrastructure">VPS · Infrastructure</option>{applications.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span>Catégorie</span><select name="category" defaultValue={initialCategory === "all" ? "lifecycle" : initialCategory}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>Criticité</span><select name="severity" defaultValue="medium"><option value="critical">Critique</option><option value="high">Élevée</option><option value="medium">Moyenne</option><option value="low">Faible</option></select></label>
      <label><span>Échéance</span><input name="dueDate" type="date" /></label>
      <label className="maintenance-create__wide"><span>Contexte et impact</span><textarea name="description" maxLength={2000} rows={2} placeholder="Pourquoi faut-il intervenir ?" /></label>
      <label className="maintenance-create__wide"><span>Étapes à réaliser, une par ligne</span><textarea name="remediation" maxLength={4000} rows={3} /></label>
      <label className="maintenance-create__wide"><span>Contrôles avant clôture, un par ligne</span><textarea name="verification" maxLength={2000} rows={2} /></label>
      <div className="maintenance-create__footer">{createState.message && <p className={createState.status === "error" ? "form-error" : "form-success"} role={createState.status === "error" ? "alert" : "status"}>{createState.message}</p>}<button className="button button--primary" type="submit" disabled={createPending}>{createPending ? "Ajout…" : "Créer l’action"}</button></div>
    </form>}

    <section className="maintenance-pulse" aria-label="Résumé des actions actives">
      <div><strong>{activeTasks.length}</strong><span>actions actives</span></div>
      <div className={urgentCount ? "has-attention" : ""}><strong>{urgentCount}</strong><span>priorités haute ou critique</span></div>
      <button type="button" className={category === "security" ? "is-active" : ""} onClick={() => { setCategory(category === "security" ? "all" : "security"); setScope("active"); }}><strong>{securityCount}</strong><span><ShieldCheck aria-hidden="true" /> actions de sécurité</span></button>
      <div><strong>{applicationCount}</strong><span>périmètres concernés</span></div>
    </section>

    <section className="maintenance-controls" aria-label="Classer les actions">
      <div className="maintenance-scope"><button className={scope === "active" ? "is-active" : ""} onClick={() => setScope("active")}><CircleDot aria-hidden="true" /> Actives</button><button className={scope === "history" ? "is-active" : ""} onClick={() => setScope("history")}><History aria-hidden="true" /> Historique</button></div>
      <label><span>Application</span><select value={application} onChange={(event) => setApplication(event.target.value)}><option value="all">Toutes</option><option value="infrastructure">VPS · Infrastructure</option>{applications.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span>Criticité</span><select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">Toutes</option><option value="critical">Critique</option><option value="high">Élevée</option><option value="medium">Moyenne</option><option value="low">Faible</option></select></label>
      <label><span>Catégorie</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">Toutes</option>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </section>

    <div className="maintenance-results" aria-live="polite"><span>{filtered.length} action{filtered.length > 1 ? "s" : ""}</span><button type="button" onClick={() => { setApplication("all"); setSeverity("all"); setCategory("all"); }}>Effacer les filtres</button></div>

    {groups.length ? <div className="maintenance-groups">{groups.map((group) => <section key={group.id} className="maintenance-group" aria-labelledby={`maintenance-group-${group.id}`}>
      <header><div><span className="maintenance-line" aria-hidden="true" /><h2 id={`maintenance-group-${group.id}`}>{group.name}</h2></div><small>{group.tasks.length} action{group.tasks.length > 1 ? "s" : ""}</small></header>
      <div className="maintenance-action-list">{group.tasks.map((task) => {
        const guidance = maintenanceGuidance(task);
        const taskEvents = events.filter((event) => event.taskId === task.id);
        const historical = ["done", "dismissed"].includes(task.status);
        return <article className={`maintenance-action maintenance-action--${task.severity}`} id={`maintenance-task-${task.id}`} key={task.id}>
          <div className="maintenance-action__signal" aria-hidden="true" />
          <div className="maintenance-action__main">
            <div className="maintenance-action__labels"><span className={`severity severity--${task.severity}`}>{severityLabels[task.severity]}</span><span>{categoryLabels[task.category]}</span><span>{statusLabels[task.status]}</span></div>
            <h3>{task.title}</h3>
            <p className="maintenance-action__meta"><Clock3 aria-hidden="true" /> {task.dueLabel} · {task.source} · créée le {task.createdLabel}</p>
            <details className="maintenance-procedure">
              <summary><span>Voir la procédure et les preuves</span><ChevronDown aria-hidden="true" /></summary>
              <div className="maintenance-procedure__body">
                <section><p className="eyebrow">Pourquoi agir</p><p>{guidance.impact}</p></section>
                <section><p className="eyebrow">Étapes proposées</p><ol>{guidance.remediation.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></section>
                <section><p className="eyebrow">Avant de terminer</p><ul>{guidance.verification.map((step, index) => <li key={`${index}-${step}`}><Check aria-hidden="true" />{step}</li>)}</ul></section>
                <section className="maintenance-evidence"><p className="eyebrow">Journal</p>{taskEvents.length ? <ol>{taskEvents.map((event) => <li key={event.id}><time>{event.createdLabel}</time><span>{event.note ?? event.action}</span></li>)}</ol> : <p>Aucun événement supplémentaire.</p>}</section>
              </div>
            </details>
          </div>
          <div className="maintenance-action__controls">
            {!historical ? <>
              <form action={setMaintenanceTaskStatus}><input type="hidden" name="taskId" value={task.id} /><select name="nextStatus" defaultValue={task.status} aria-label={`Statut de ${task.title}`}><option value="open">À faire</option><option value="planned">Planifiée</option><option value="in_progress">En cours</option><option value="dismissed">Classer</option></select><button type="submit">Appliquer</button></form>
              <form action={completeMaintenanceTask.bind(null, task.id)}><button className="button button--secondary button--compact" type="submit"><Check aria-hidden="true" /> Terminer</button></form>
            </> : <form action={reopenMaintenanceTask.bind(null, task.id)}><button className="button button--quiet button--compact" type="submit"><RotateCcw aria-hidden="true" /> Rouvrir</button></form>}
          </div>
        </article>;
      })}</div>
    </section>)}</div> : <section className="maintenance-zero"><ListChecks aria-hidden="true" /><h2>{scope === "active" ? "La voie est libre." : "Aucune opération classée."}</h2><p>{tasks.length ? "Aucune action ne correspond à ces filtres." : "Les actions créées automatiquement ou manuellement apparaîtront ici avec leur procédure."}</p></section>}

    {urgentCount > 0 && <aside className="maintenance-safety-note"><AlertTriangle aria-hidden="true" /><div><strong>Une criticité n’autorise jamais une action aveugle.</strong><p>Confirme l’accès de secours, les sauvegardes et le retour arrière avant une opération de sécurité ou d’infrastructure.</p></div></aside>}
  </>;
}
