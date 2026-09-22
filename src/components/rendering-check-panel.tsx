"use client";

import { LocalDateTime } from "@/components/local-date-time";

import { useActionState } from "react";
import { Check, ChevronRight, ImageOff, ScanEye } from "lucide-react";
import { updateRenderingCheck, type RenderingCheckState } from "@/app/actions";
import type { MonitoredApplication } from "@/lib/domain";

const initialState: RenderingCheckState = { status: "idle", message: "" };

export function RenderingCheckPanel({ application }: { application: MonitoredApplication }) {
  const [state, action, pending] = useActionState(updateRenderingCheck, initialState);
  const settings = application.renderingCheck;
  if (!settings) return null;

  const configured = Boolean(settings.renderingUrl) || Boolean(settings.expectedText) || settings.assetProbe;
  const tone = configured ? application.lastCheckStatus : "idle";
  const stateLabel = !configured
    ? "Non configuré"
    : application.lastCheckStatus === "healthy"
      ? "Rendu vérifié"
      : application.lastCheckStatus === "warning"
        ? "À surveiller"
        : application.lastCheckStatus === "critical"
          ? "Dernier contrôle en échec"
          : "En attente";

  return (
    <details className={`dependency-watch rendering-watch rendering-watch--${tone}`}>
      <summary>
        <span className="dependency-watch__title">
          {tone === "critical" ? <ImageOff aria-hidden="true" /> : <ScanEye aria-hidden="true" />}
          <strong>Contrôle du rendu</strong>
        </span>
        <span className="dependency-watch__state">{stateLabel}</span>
        <span className="dependency-watch__date">Contrôlé · <LocalDateTime value={application.lastCheckedAt} format="precise" fallback="En attente" /></span>
        <ChevronRight className="dependency-watch__chevron" aria-hidden="true" />
      </summary>
      <div className="dependency-watch__body">
        {configured && application.lastCheckDetail && (
          <p className="rendering-watch__last">Dernier résultat : {application.lastCheckDetail}</p>
        )}
        <form className="app-form rendering-form" action={action}>
          <input type="hidden" name="applicationId" value={application.id} />
          <p className="rendering-form__intro">
            Une page peut répondre HTTP 200 alors que ses images ne se chargent plus. Un échec de ces vérifications
            compte comme un échec du contrôle et ouvre un incident au même seuil.
          </p>
          <label>
            <span>Page à contrôler</span>
            <input
              name="renderingUrl"
              defaultValue={settings.renderingUrl ?? ""}
              maxLength={500}
              placeholder="Page d’accueil"
              autoComplete="off"
              spellCheck={false}
            />
            <small className="field-hint">
              Chemin ou URL complète, par exemple /produits/jade. Choisis une page riche en images, comme une fiche produit.
              La disponibilité reste mesurée sur la page d’accueil.
            </small>
          </label>
          <label>
            <span>Texte attendu dans la page</span>
            <input
              name="expectedText"
              defaultValue={settings.expectedText ?? ""}
              maxLength={200}
              placeholder="Ex. srcset="
              autoComplete="off"
              spellCheck={false}
            />
            <small className="field-hint">Sensible à la casse. Laisse vide pour ne pas vérifier le contenu.</small>
          </label>
          <label className="checkbox-field">
            <input name="assetProbe" type="checkbox" defaultChecked={settings.assetProbe} />
            <span>
              Vérifier qu’une image de la page se charge
              <small className="field-hint">
                Luigi choisit en priorité l’image principale redimensionnée à la volée (optimiseur Next.js, serveur
                d’assets Vendure, CDN d’images) plutôt qu’un logo statique.
              </small>
            </span>
          </label>
          <label>
            <span>Image à vérifier <small className="field-hint">· facultatif</small></span>
            <input
              name="assetUrl"
              defaultValue={settings.assetUrl ?? ""}
              maxLength={500}
              placeholder="Détection automatique"
              autoComplete="off"
              spellCheck={false}
            />
            <small className="field-hint">{"Chemin ou URL complète, par exemple /_next/image?url=%2Fhero.jpg&w=640&q=75."}</small>
          </label>
          {state.message && (
            <p
              className={state.status === "success" ? "form-success" : state.status === "warning" ? "form-warning" : "form-error"}
              role={state.status === "error" ? "alert" : "status"}
            >
              {state.status === "success" && <Check aria-hidden="true" />}
              {state.message}
            </p>
          )}
          <div className="app-form__actions">
            <button className="button button--secondary" type="submit" disabled={pending}>
              {pending ? "Contrôle en cours…" : "Enregistrer et tester"}
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}
