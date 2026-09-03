"use client";

import {
  Activity,
  Archive,
  Bell,
  Check,
  CheckCheck,
  ChevronRight,
  CloudCog,
  GitBranch,
  HardDrive,
  History,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Moon,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  TrainFront,
  Trash2,
} from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  archiveApplication,
  archiveNotification,
  completeMaintenanceTask,
  createApplication,
  createMaintenanceTask,
  markAllNotificationsRead,
  openNotification,
  runMonitoringNow,
  reopenMaintenanceTask,
  type CreateApplicationState,
  type CreateTaskState,
} from "@/app/actions";
import { signOut } from "@/app/(auth)/actions";
import { LivingRail } from "@/components/living-rail";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { StatusDot } from "@/components/status-dot";
import { ScanApplicationButton } from "@/components/scan-application-button";
import type { ActivityEvent, DashboardNotification, GitHubRepositoryOption, MaintenanceTask, MonitoredApplication, VpsOverview } from "@/lib/domain";

type Theme = "light" | "dark";
type PushState = "idle" | "loading" | "enabled" | "denied" | "unsupported" | "not_configured" | "error";
type RepositoryLoadState = "idle" | "loading" | "success" | "error";

const navigation = [
  { label: "Vue générale", icon: LayoutDashboard, href: "#overview" },
  { label: "Applications", icon: CloudCog, href: "#applications" },
  { label: "VPS", icon: Server, href: "#vps" },
  { label: "Maintenance", icon: ListTodo, href: "#maintenance" },
  { label: "Sécurité", icon: ShieldCheck, href: "#security" },
];

const severityLabels = {
  critical: "Critique",
  high: "Élevée",
  medium: "Moyenne",
  low: "Faible",
};

const initialApplicationState: CreateApplicationState = { status: "idle", message: "" };
const initialTaskState: CreateTaskState = { status: "idle", message: "" };

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = window.atob(base64);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

type DashboardProps = {
  applications: MonitoredApplication[];
  maintenanceTasks: MaintenanceTask[];
  maintenanceHistory: MaintenanceTask[];
  notifications: DashboardNotification[];
  unreadNotificationCount: number;
  activity: ActivityEvent[];
  vps: VpsOverview;
  userName: string;
  githubIntegrationLabel?: string;
};

export function Dashboard({ applications, maintenanceTasks, maintenanceHistory, notifications, unreadNotificationCount, activity, vps, userName, githubIntegrationLabel }: DashboardProps) {
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>("light");
  const [lastRefresh, setLastRefresh] = useState("il y a 38 secondes");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pushState, setPushState] = useState<PushState>("idle");
  const [pushMessage, setPushMessage] = useState("");
  const [githubRepositories, setGitHubRepositories] = useState<GitHubRepositoryOption[]>([]);
  const [repositoryLoadState, setRepositoryLoadState] = useState<RepositoryLoadState>("idle");
  const [repositoryLoadMessage, setRepositoryLoadMessage] = useState("");
  const [applicationState, applicationAction, applicationPending] = useActionState(
    createApplication,
    initialApplicationState,
  );
  const [taskState, taskAction, taskPending] = useActionState(createMaintenanceTask, initialTaskState);
  const appDialog = useRef<HTMLDialogElement>(null);
  const appForm = useRef<HTMLFormElement>(null);
  const applicationNameInput = useRef<HTMLInputElement>(null);
  const applicationBranchInput = useRef<HTMLInputElement>(null);
  const applicationRepositoryInput = useRef<HTMLInputElement>(null);
  const taskDialog = useRef<HTMLDialogElement>(null);
  const taskForm = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const storedTheme = window.localStorage.getItem("luigi-theme") as Theme | null;
      const preferredTheme: Theme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
      const initialTheme = storedTheme ?? preferredTheme;
      setTheme(initialTheme);
      document.documentElement.dataset.theme = initialTheme;

      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        setPushState("unsupported");
      } else if (Notification.permission === "denied") {
        setPushState("denied");
      } else if (Notification.permission === "granted") {
        void navigator.serviceWorker.ready
          .then((registration) => registration.pushManager.getSubscription())
          .then(async (subscription) => {
            if (!subscription) {
              setPushState("idle");
              return;
            }
            const configurationResponse = await fetch("/api/push/subscriptions", { cache: "no-store" });
            const configuration = await configurationResponse.json() as { configured?: boolean };
            if (!configurationResponse.ok || !configuration.configured) {
              setPushState("not_configured");
              return;
            }
            const response = await fetch("/api/push/subscriptions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(subscription.toJSON()),
            });
            setPushState(response.ok ? "enabled" : "error");
          })
          .catch(() => setPushState("error"));
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (applicationState.status === "success") {
      appForm.current?.reset();
      router.refresh();
    }
  }, [applicationState.status, router]);

  useEffect(() => {
    if (taskState.status === "success") {
      taskForm.current?.reset();
      router.refresh();
    }
  }, [taskState.status, router]);

  const visibleTasks = maintenanceTasks;

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("luigi-theme", nextTheme);
  }

  async function refreshData() {
    setIsRefreshing(true);
    try {
      const result = await runMonitoringNow();
      setLastRefresh(result.checked === 0
        ? "— aucun contrôle configuré"
        : `à l’instant · ${result.healthy}/${result.checked} sain${result.healthy > 1 ? "s" : ""}`);
      router.refresh();
    } catch {
      setLastRefresh("— contrôle impossible");
    } finally {
      setIsRefreshing(false);
    }
  }

  async function loadGitHubRepositories() {
    if (!githubIntegrationLabel || repositoryLoadState === "loading" || repositoryLoadState === "success") return;

    setRepositoryLoadState("loading");
    setRepositoryLoadMessage("");

    try {
      const response = await fetch("/api/github/repositories", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const body = await response.json() as {
        repositories?: GitHubRepositoryOption[];
        message?: string;
      };

      if (!response.ok || !Array.isArray(body.repositories)) {
        throw new Error(body.message ?? "La liste des dépôts est indisponible.");
      }

      setGitHubRepositories(body.repositories);
      setRepositoryLoadState("success");
    } catch (error) {
      setRepositoryLoadState("error");
      setRepositoryLoadMessage(error instanceof Error
        ? error.message
        : "La liste des dépôts est indisponible.");
    }
  }

  function openApplicationDialog() {
    appDialog.current?.showModal();
    void loadGitHubRepositories();
  }

  function selectGitHubRepository(fullName: string) {
    const repository = githubRepositories.find((item) => item.fullName === fullName);
    if (!repository) return;

    if (applicationNameInput.current) applicationNameInput.current.value = repository.name;
    if (applicationBranchInput.current) applicationBranchInput.current.value = repository.defaultBranch;
    if (applicationRepositoryInput.current) applicationRepositoryInput.current.value = repository.fullName;
  }

  const overviewStatus = applications.some((application) => application.status === "critical")
    ? "critical"
    : applications.some((application) => application.status === "warning")
      ? "warning"
      : applications.length > 0 && applications.every((application) => application.status === "healthy")
        ? "healthy"
        : "unknown";
  const overviewTitle = overviewStatus === "critical"
    ? "Une application demande une intervention."
    : overviewStatus === "warning"
      ? "Un signal mérite ton attention."
      : overviewStatus === "healthy"
        ? "Les applications répondent normalement."
        : "Les premiers contrôles sont en attente.";
  const overviewDescription = applications.length === 0
    ? "Ajoute une application pour démarrer la surveillance."
    : `${applications.filter((application) => application.status === "healthy").length} application${applications.length > 1 ? "s" : ""} saine${applications.length > 1 ? "s" : ""} sur ${applications.length}. Les incidents ne sont ouverts qu’après trois échecs consécutifs.`;

  async function enableNotifications() {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setPushState("unsupported");
      return;
    }

    setPushState("loading");
    setPushMessage("");

    try {
      const configurationResponse = await fetch("/api/push/subscriptions", { cache: "no-store" });
      const configuration = await configurationResponse.json() as { configured?: boolean; publicKey?: string | null };
      if (!configurationResponse.ok || !configuration.configured || !configuration.publicKey) {
        setPushState("not_configured");
        setPushMessage("Ajoute les clés VAPID dans l’environnement de production.");
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState("denied");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(configuration.publicKey),
      });
      const body = subscription.toJSON();
      const subscriptionResponse = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!subscriptionResponse.ok) throw new Error("subscription_failed");

      setPushState("enabled");
      setPushMessage("Ce navigateur est relié. Une notification de test a été envoyée.");
      await sendTestNotification(subscription.endpoint);
    } catch {
      setPushState("error");
      setPushMessage("La connexion des notifications a échoué. Réessaie dans un instant.");
    }
  }

  async function sendTestNotification(knownEndpoint?: string) {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = knownEndpoint ? null : await registration.pushManager.getSubscription();
      const endpoint = knownEndpoint ?? subscription?.endpoint;
      if (!endpoint) throw new Error("missing_subscription");
      const response = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      if (!response.ok) throw new Error("test_failed");
      setPushMessage("Notification de test envoyée.");
    } catch {
      setPushMessage("Le test n’a pas pu être envoyé.");
    }
  }

  async function disableNotifications() {
    setPushState("loading");
    setPushMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setPushState("idle");
      setPushMessage("Notifications désactivées sur ce navigateur.");
    } catch {
      setPushState("error");
      setPushMessage("La désactivation n’a pas pu aboutir.");
    }
  }

  return (
    <>
      <ServiceWorkerRegistration />
      <a className="skip-link" href="#main-content">Aller au contenu</a>

      <div className="app-shell">
        <aside className="sidebar" aria-label="Navigation principale">
          <a className="brand" href="#overview" aria-label="Luigi, vue générale">
            <span className="brand__mark" aria-hidden="true"><TrainFront /></span>
            <span className="brand__name">Luigi</span>
          </a>

          <nav className="sidebar__nav">
            {navigation.map((item, index) => {
              const Icon = item.icon;
              return (
                <a className={index === 0 ? "nav-link nav-link--active" : "nav-link"} href={item.href} key={item.label}>
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </a>
              );
            })}
          </nav>

          <div className="sidebar__footer">
            <div className={`agent-state ${vps.connected ? "agent-state--online" : "agent-state--idle"}`}>
              <span className="agent-state__signal" aria-hidden="true" />
              <span>
                <strong>{vps.connected ? "Agent connecté" : vps.configured ? "Agent silencieux" : "Agent à installer"}</strong>
                <small>{vps.hostname ?? "Ubuntu 24.04"}</small>
              </span>
            </div>
            <Link className="nav-link" href="/settings/integrations">
              <Settings aria-hidden="true" />
              <span>Paramètres</span>
            </Link>
            <form action={signOut}>
              <button className="nav-link nav-link--button" type="submit">
                <LogOut aria-hidden="true" />
                <span>Se déconnecter</span>
              </button>
            </form>
          </div>
        </aside>

        <main className="main-content" id="main-content">
          <header className="topbar">
            <div>
              <p className="eyebrow">Mercredi 2 septembre</p>
              <h1>Bonjour {userName.split(" ")[0]}.</h1>
            </div>
            <div className="topbar__actions">
              <button className="icon-button" type="button" onClick={toggleTheme} aria-label={theme === "light" ? "Activer le thème sombre" : "Activer le thème clair"}>
                {theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
              </button>
              <details className="notifications-menu">
                <summary className="icon-button" aria-label="Ouvrir les notifications">
                  <Bell aria-hidden="true" />
                  {unreadNotificationCount > 0 && <span className="notification-count" aria-label={`${unreadNotificationCount} notifications non lues`}>{unreadNotificationCount}</span>}
                </summary>
                <div className="notifications-panel">
                  <div className="notifications-panel__heading">
                    <span><strong>Notifications</strong><small>{unreadNotificationCount} non lue{unreadNotificationCount > 1 ? "s" : ""}</small></span>
                    {unreadNotificationCount > 0 && (
                      <form action={markAllNotificationsRead}>
                        <button type="submit"><CheckCheck aria-hidden="true" /> Tout marquer lu</button>
                      </form>
                    )}
                  </div>
                  {notifications.map((notification) => (
                    <div className={`notification-item notification-item--${notification.status}`} key={notification.id}>
                      <form action={openNotification.bind(null, notification.id)}>
                        <button className="notification-link" type="submit">
                          <span className={`notification-mark notification-mark--${notification.severity}`} aria-hidden="true" />
                          <span>
                            <strong>{notification.title}</strong>
                            <small>{notification.body}</small>
                            <time>{notification.createdLabel}{notification.occurrenceCount > 1 ? ` · ${notification.occurrenceCount} occurrences` : ""}</time>
                          </span>
                        </button>
                      </form>
                      <form action={archiveNotification.bind(null, notification.id)}>
                        <button className="notification-archive" type="submit" aria-label={`Archiver ${notification.title}`} title="Archiver">
                          <Archive aria-hidden="true" />
                        </button>
                      </form>
                    </div>
                  ))}
                  {notifications.length === 0 && <p className="notifications-panel__empty">Aucune nouvelle notification.</p>}
                </div>
              </details>
              <button className="button button--primary" type="button" onClick={openApplicationDialog}>
                <Plus aria-hidden="true" />
                Ajouter une application
              </button>
            </div>
          </header>

          <section className="status-intro" id="overview" aria-labelledby="overview-title">
            <div>
              <StatusDot status={overviewStatus} />
              <h2 id="overview-title">{overviewTitle}</h2>
              <p>{overviewDescription}</p>
            </div>
            <button className="button button--quiet" type="button" onClick={refreshData} disabled={isRefreshing}>
              <RefreshCw className={isRefreshing ? "spin" : ""} aria-hidden="true" />
              {isRefreshing ? "Actualisation…" : `Actualisé ${lastRefresh}`}
            </button>
          </section>

          <LivingRail applicationCount={applications.length} />

          <div className="dashboard-grid">
            <section className="section applications-section" id="applications" aria-labelledby="applications-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Disponibilité</p>
                  <h2 id="applications-title">Applications</h2>
                </div>
                <a className="text-link" href="#applications">Voir les contrôles <ChevronRight aria-hidden="true" /></a>
              </div>

              <div className="application-list">
                {applications.map((application) => (
                  <article className="application-row" id={`application-${application.id}`} key={application.id}>
                    <div className="application-row__identity">
                      <StatusDot status={application.status} compact />
                      <div>
                        <h3>{application.name}</h3>
                        <p>{application.url}</p>
                      </div>
                    </div>
                    <div className="application-row__metric">
                      <span>Disponibilité</span>
                      <strong>{application.uptime30d === null ? "En attente" : `${application.uptime30d.toLocaleString("fr-FR")} %`}</strong>
                    </div>
                    <div className="application-row__metric">
                      <span>Réponse</span>
                      <strong className={application.status === "warning" ? "metric-warning" : ""}>{application.latencyMs === null ? "En attente" : `${application.latencyMs} ms`}</strong>
                    </div>
                    <div className="technology-list" aria-label={`Technologies de ${application.name}`}>
                      {application.technologies.slice(0, 2).map((technology) => (
                        <span key={technology.name}>{technology.name} {technology.version}</span>
                      ))}
                    </div>
                    <div className="application-row__actions">
                      <ScanApplicationButton applicationId={application.id} applicationName={application.name} />
                      <form
                        action={archiveApplication.bind(null, application.id)}
                        onSubmit={(event) => {
                          if (!window.confirm(`Supprimer ${application.name} du monitoring ? Ses contrôles seront arrêtés, mais son historique sera conservé.`)) {
                            event.preventDefault();
                          }
                        }}
                      >
                        <button className="row-action row-action--danger" type="submit" aria-label={`Supprimer ${application.name}`} title="Supprimer du monitoring">
                          <Trash2 aria-hidden="true" />
                        </button>
                      </form>
                    </div>
                  </article>
                ))}
                {applications.length === 0 && (
                  <div className="empty-state application-empty-state">
                    <CloudCog aria-hidden="true" />
                    <strong>Aucune application sur la voie.</strong>
                    <span>Ajoute la première pour préparer ses contrôles et l’analyse de son dépôt.</span>
                    <button className="button button--secondary" type="button" onClick={openApplicationDialog}>
                      <Plus aria-hidden="true" /> Ajouter une application
                    </button>
                  </div>
                )}
              </div>
            </section>

            <section className="section vps-section" id="vps" aria-labelledby="vps-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Ubuntu 24.04</p>
                  <h2 id="vps-title">VPS production</h2>
                </div>
                <div className="section-heading__actions">
                  <StatusDot status={vps.status} />
                  <Link className="text-link" href="/settings/vps">Configurer</Link>
                </div>
              </div>

              {vps.metrics.length > 0 ? <div className="metric-list">
                {vps.metrics.map((metric) => (
                  <div className="metric-row" key={metric.id}>
                    <div className="metric-row__heading">
                      <span>{metric.label}</span>
                      <strong>{metric.displayValue}</strong>
                    </div>
                    <div className="meter" role="meter" aria-label={metric.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={metric.value}>
                      <span className={`meter__value meter__value--${metric.status}`} style={{ transform: `scaleX(${metric.value / 100})` }} />
                    </div>
                    <small>{metric.detail}</small>
                  </div>
                ))}
              </div> : (
                <div className="empty-state vps-empty-state">
                  <Server aria-hidden="true" />
                  <strong>{vps.configured ? "En attente du premier rapport." : "Le VPS n’est pas encore relié."}</strong>
                  <span>{vps.configured ? "Démarre le service sur Ubuntu pour remplacer cette zone par les mesures réelles." : "Crée un jeton puis installe l’agent en quelques commandes."}</span>
                  <Link className="button button--secondary" href="/settings/vps">{vps.configured ? "Voir l’installation" : "Relier le VPS"}</Link>
                </div>
              )}

              {vps.metrics.length > 0 && <>
                <div className={`vps-freshness vps-freshness--${vps.freshnessStatus}`}>
                  <span><strong>Collecte</strong><small>{vps.refreshIntervalLabel}</small></span>
                  <span><strong>Dernière donnée</strong><small>{vps.dataAgeLabel}</small></span>
                  <span><strong>Prochaine attendue</strong><small>{vps.nextReportLabel}</small></span>
                </div>
                <div className="vps-facts">
                  <span>
                    <ShieldCheck aria-hidden="true" />
                    <strong>{vps.securityUpdates === 0 ? "À jour" : `${vps.securityUpdates} à appliquer`}</strong>
                    <small>Correctifs de sécurité · UFW {vps.ufwActive === null ? "inconnu" : vps.ufwActive ? "actif" : "inactif"}</small>
                  </span>
                  <span>
                    <HardDrive aria-hidden="true" />
                    <strong>{vps.backupStatus === "ok" ? "Réussie" : vps.backupStatus === "failed" ? "À vérifier" : "Non configurée"}</strong>
                    <small>Sauvegarde · {vps.lastSeenLabel}</small>
                  </span>
                </div>
                {vps.rebootRequired && <p className="vps-action-note"><RefreshCw aria-hidden="true" /> Redémarrage requis après mise à jour. Une tâche de maintenance a été créée.</p>}
              </>}
            </section>

            <section className="section tasks-section" id="maintenance" aria-labelledby="tasks-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">À faire</p>
                  <h2 id="tasks-title">Maintenance</h2>
                </div>
                <div className="section-heading__actions">
                  <span className="section-count">{visibleTasks.length}</span>
                  <button className="icon-button" type="button" onClick={() => taskDialog.current?.showModal()} aria-label="Ajouter une tâche manuelle">
                    <Plus aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="task-list" aria-live="polite">
                {visibleTasks.length > 0 ? visibleTasks.map((task) => (
                  <article className="task-row" id={`maintenance-task-${task.id}`} key={task.id}>
                    <form action={completeMaintenanceTask.bind(null, task.id)}>
                      <button className="task-check" type="submit" aria-label={`Marquer « ${task.title} » comme terminée`}>
                        <Check aria-hidden="true" />
                      </button>
                    </form>
                    <div className="task-row__content">
                      <div className="task-row__title">
                        <h3>{task.title}</h3>
                        <span className={`severity severity--${task.severity}`}>{severityLabels[task.severity]}</span>
                      </div>
                      <p><strong>{task.applicationName}</strong> · {task.source} · {task.dueLabel}</p>
                    </div>
                    <button className="row-action" type="button" aria-label={`Ouvrir la tâche ${task.title}`}>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </article>
                )) : (
                  <div className="empty-state">
                    <Check aria-hidden="true" />
                    <strong>La voie est libre.</strong>
                    <span>Aucune maintenance ne demande ton attention.</span>
                  </div>
                )}
              </div>

              <details className="maintenance-history">
                <summary><History aria-hidden="true" /> Historique <span>{maintenanceHistory.length}</span></summary>
                <div className="maintenance-history__list">
                  {maintenanceHistory.map((task) => (
                    <article className="history-row" key={task.id}>
                      <div>
                        <strong>{task.title}</strong>
                        <small>{task.applicationName} · {task.status === "dismissed" ? "Classée" : "Terminée"}{task.completedLabel ? ` le ${task.completedLabel}` : ""}</small>
                      </div>
                      <form action={reopenMaintenanceTask.bind(null, task.id)}>
                        <button className="button button--quiet button--compact" type="submit">
                          <RotateCcw aria-hidden="true" /> Rouvrir
                        </button>
                      </form>
                    </article>
                  ))}
                  {maintenanceHistory.length === 0 && <p className="maintenance-history__empty">Les opérations terminées resteront visibles ici.</p>}
                </div>
              </details>
            </section>

            <section className="section activity-section" aria-labelledby="activity-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Aujourd’hui</p>
                  <h2 id="activity-title">Journal</h2>
                </div>
                <Activity aria-hidden="true" />
              </div>
              <ol className="activity-list">
                {activity.map((event) => (
                  <li key={event.id}>
                    <StatusDot status={event.status} compact />
                    <div><strong>{event.title}</strong><span>{event.detail}</span></div>
                    <time>{event.timeLabel}</time>
                  </li>
                ))}
                {activity.length === 0 && (
                  <li className="activity-list__empty">
                    <Activity aria-hidden="true" />
                    <div><strong>Aucun contrôle exécuté</strong><span>Lance une actualisation pour créer la première observation.</span></div>
                  </li>
                )}
              </ol>
            </section>
          </div>

          <div className="settings-grid" id="settings">
            <section className="notification-setup" aria-labelledby="notification-title">
              <div className="notification-setup__icon"><Bell aria-hidden="true" /></div>
              <div>
                <p className="eyebrow">Ce navigateur</p>
                <h2 id="notification-title">{pushState === "enabled" ? "Notifications activées" : "Rester informé sans garder Luigi ouvert"}</h2>
                <p aria-live="polite">{pushMessage || (pushState === "enabled"
                  ? "Ce navigateur recevra les incidents critiques, les silences et les retours à la normale."
                  : pushState === "denied"
                    ? "Les notifications sont bloquées dans les réglages de ce navigateur."
                    : pushState === "not_configured"
                      ? "Les clés VAPID doivent être configurées avant d’activer ce canal."
                      : "Active les notifications Web Push. Luigi enverra d’abord un message de test.")}</p>
              </div>
              <div className="notification-setup__actions">
                {pushState === "enabled" ? <>
                  <button className="button button--secondary" type="button" onClick={() => void sendTestNotification()}>
                    <Bell aria-hidden="true" /> Tester
                  </button>
                  <button className="button button--quiet" type="button" onClick={disableNotifications}>Désactiver</button>
                </> : (
                  <button className="button button--secondary" type="button" onClick={enableNotifications} disabled={pushState === "loading" || pushState === "denied" || pushState === "unsupported"}>
                    {pushState === "loading" ? <><RefreshCw className="spin" aria-hidden="true" /> Connexion…</> : pushState === "denied" ? "Autorisation refusée" : pushState === "unsupported" ? "Non disponible" : "Activer sur ce navigateur"}
                  </button>
                )}
              </div>
            </section>
            <section className="notification-setup" aria-labelledby="github-title">
              <div className="notification-setup__icon"><GitBranch aria-hidden="true" /></div>
              <div>
                <p className="eyebrow">Dépôts et dépendances</p>
                <h2 id="github-title">{githubIntegrationLabel ?? "Connecter GitHub"}</h2>
                <p>{githubIntegrationLabel ? "Les dépôts privés autorisés peuvent être analysés en lecture seule." : "Les dépôts publics fonctionnent sans jeton. Connecte GitHub pour les dépôts privés."}</p>
              </div>
              <Link className="button button--secondary" href="/settings/integrations">
                {githubIntegrationLabel ? "Gérer" : "Configurer"}
              </Link>
            </section>
          </div>
        </main>
      </div>

      <dialog className="app-dialog" ref={appDialog}>
        <form method="dialog" className="dialog-close-form">
          <button className="icon-button" aria-label="Fermer l’ajout d’application">×</button>
        </form>
        <div className="app-dialog__heading">
          <span className="dialog-step">Étape 1 sur 3</span>
          <h2>Ajouter une application</h2>
          <p>Relie son URL à un dépôt GitHub. Luigi proposera ensuite les technologies à surveiller.</p>
        </div>
        <form className="app-form" action={applicationAction} ref={appForm}>
          {githubIntegrationLabel && (
            <div className="repository-picker">
              <label>
                <span>Dépôt détecté</span>
                <select
                  defaultValue=""
                  disabled={repositoryLoadState !== "success" || githubRepositories.length === 0}
                  onChange={(event) => selectGitHubRepository(event.target.value)}
                >
                  <option value="">
                    {repositoryLoadState === "loading"
                      ? "Chargement des dépôts…"
                      : repositoryLoadState === "error"
                        ? "Dépôts indisponibles"
                        : githubRepositories.length === 0 && repositoryLoadState === "success"
                          ? "Aucun dépôt accessible"
                          : "Sélectionner un dépôt…"}
                  </option>
                  {githubRepositories.map((repository) => (
                    <option key={repository.fullName} value={repository.fullName}>
                      {repository.fullName}{repository.private ? " · privé" : ""}{repository.archived ? " · archivé" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="repository-picker__status" aria-live="polite">
                {repositoryLoadState === "loading" && <><RefreshCw className="spin" aria-hidden="true" /> Lecture des dépôts autorisés…</>}
                {repositoryLoadState === "success" && githubRepositories.length > 0 && (
                  <><Check aria-hidden="true" /> {githubRepositories.length} dépôt{githubRepositories.length > 1 ? "s" : ""} accessible{githubRepositories.length > 1 ? "s" : ""}. La sélection préremplit les champs ci-dessous.</>
                )}
                {repositoryLoadState === "success" && githubRepositories.length === 0 && (
                  <>Aucun dépôt n’est autorisé pour ce jeton. Tu peux utiliser la saisie manuelle.</>
                )}
                {repositoryLoadState === "error" && (
                  <>
                    <span>{repositoryLoadMessage}</span>
                    <button className="text-button" type="button" onClick={() => void loadGitHubRepositories()}>Réessayer</button>
                  </>
                )}
              </div>
            </div>
          )}
          <label>
            <span>Nom de l’application</span>
            <input ref={applicationNameInput} name="name" required placeholder="Ex. Site vitrine Thermidor" />
          </label>
          <div className="form-grid">
            <label>
              <span>Environnement</span>
              <select name="environment" defaultValue="production">
                <option value="production">Production</option>
                <option value="staging">Préproduction</option>
                <option value="development">Développement</option>
              </select>
            </label>
            <label>
              <span>Branche suivie</span>
              <input ref={applicationBranchInput} name="branch" defaultValue="main" required />
            </label>
          </div>
          <label>
            <span>URL publique</span>
            <input name="url" type="url" required placeholder="https://example.com" />
          </label>
          <label>
            <span>Dépôt GitHub</span>
            <span className="input-with-icon"><GitBranch aria-hidden="true" /><input ref={applicationRepositoryInput} name="repository" required placeholder="organisation/depot" /></span>
          </label>
          {applicationState.message && (
            <p className={applicationState.status === "error" ? "form-error" : "form-success"} role={applicationState.status === "error" ? "alert" : "status"}>
              {applicationState.status === "success" && <Check aria-hidden="true" />}
              {applicationState.message}
            </p>
          )}
          <div className="app-form__actions">
            <button className="button button--quiet" type="button" onClick={() => appDialog.current?.close()}>Garder pour plus tard</button>
            <button className="button button--primary" type="submit" disabled={applicationPending}>
              {applicationPending ? "Enregistrement…" : "Enregistrer l’application"}
              {!applicationPending && <ChevronRight aria-hidden="true" />}
            </button>
          </div>
        </form>
      </dialog>

      <dialog className="app-dialog" ref={taskDialog}>
        <form method="dialog" className="dialog-close-form">
          <button className="icon-button" aria-label="Fermer l’ajout de tâche">×</button>
        </form>
        <div className="app-dialog__heading">
          <span className="dialog-step">Tâche manuelle</span>
          <h2>Ajouter une maintenance</h2>
          <p>Ajoute une action ponctuelle à côté des tâches générées automatiquement par Luigi.</p>
        </div>
        <form className="app-form" action={taskAction} ref={taskForm}>
          <label>
            <span>Action à réaliser</span>
            <input name="title" required minLength={3} maxLength={140} placeholder="Ex. Tester la restauration de la sauvegarde" />
          </label>
          <label>
            <span>Élément concerné</span>
            <select name="applicationId" defaultValue="infrastructure">
              <option value="infrastructure">VPS · Infrastructure générale</option>
              {applications.map((application) => (
                <option key={application.id} value={application.id}>{application.name}</option>
              ))}
            </select>
            <small className="field-hint">Chaque maintenance applicative restera liée à cette application dans l’historique.</small>
          </label>
          <div className="form-grid">
            <label>
              <span>Catégorie</span>
              <select name="category" defaultValue="lifecycle">
                <option value="security">Sécurité</option>
                <option value="dependency">Dépendance</option>
                <option value="capacity">Capacité</option>
                <option value="backup">Sauvegarde</option>
                <option value="lifecycle">Cycle de vie</option>
              </select>
            </label>
            <label>
              <span>Priorité</span>
              <select name="severity" defaultValue="medium">
                <option value="critical">Critique</option>
                <option value="high">Élevée</option>
                <option value="medium">Moyenne</option>
                <option value="low">Faible</option>
              </select>
            </label>
          </div>
          <label>
            <span>Échéance facultative</span>
            <input name="dueDate" type="date" />
          </label>
          {taskState.message && (
            <p className={taskState.status === "error" ? "form-error" : "form-success"} role={taskState.status === "error" ? "alert" : "status"}>
              {taskState.status === "success" && <Check aria-hidden="true" />}{taskState.message}
            </p>
          )}
          <div className="app-form__actions">
            <button className="button button--quiet" type="button" onClick={() => taskDialog.current?.close()}>Annuler</button>
            <button className="button button--primary" type="submit" disabled={taskPending}>
              {taskPending ? "Ajout…" : "Ajouter la tâche"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
