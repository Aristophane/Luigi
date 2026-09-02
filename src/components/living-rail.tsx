import { GitBranch, Server, ShieldCheck } from "lucide-react";

export function LivingRail({ applicationCount }: { applicationCount: number }) {
  const stations = [
    { id: "github", label: "GitHub", detail: `${applicationCount} dépôt${applicationCount > 1 ? "s" : ""}`, x: 92 },
    { id: "checks", label: "Contrôles", detail: `${applicationCount} préparé${applicationCount > 1 ? "s" : ""}`, x: 330 },
    { id: "apps", label: "Applications", detail: applicationCount === 0 ? "À configurer" : `${applicationCount} suivie${applicationCount > 1 ? "s" : ""}`, x: 572 },
    { id: "vps", label: "VPS", detail: "Ubuntu 24.04", x: 808 },
  ];
  return (
    <section className="living-rail" aria-labelledby="living-rail-title">
      <div className="living-rail__heading">
        <div>
          <p className="eyebrow">Circulation système</p>
          <h2 id="living-rail-title">{applicationCount === 0 ? "La voie est prête" : "Les sources sont reliées"}</h2>
        </div>
        <span className="freshness">
          <span className="freshness__pulse" aria-hidden="true" />
          {applicationCount === 0 ? "En attente du premier contrôle" : "Collecte prête à démarrer"}
        </span>
      </div>

      <div className="rail-map">
        <svg
          viewBox="0 0 900 188"
          role="img"
          aria-labelledby="rail-title rail-description"
          preserveAspectRatio="xMidYMid meet"
        >
          <title id="rail-title">Flux de supervision Luigi</title>
          <desc id="rail-description">
            Une ligne relie GitHub, les contrôles, les applications et le VPS. Un marqueur se déplace
            lorsque les collectes arrivent normalement.
          </desc>
          <path className="rail-map__sleepers" d="M92 82 H808" pathLength="36" />
          <path className="rail-map__line" d="M92 82 H808" />
          <path className="rail-map__branch" d="M572 82 C620 82 620 136 680 136" />
          <circle className="rail-map__branch-station" cx="680" cy="136" r="7" />
          <text className="rail-map__branch-label" x="698" y="141">
            Sauvegardes
          </text>

          {stations.map((station) => (
            <g key={station.id}>
              <circle className="rail-map__station-halo" cx={station.x} cy="82" r="16" />
              <circle className="rail-map__station" cx={station.x} cy="82" r="7" />
              <text className="rail-map__station-label" x={station.x} y="122" textAnchor="middle">
                {station.label}
              </text>
              <text className="rail-map__station-detail" x={station.x} y="142" textAnchor="middle">
                {station.detail}
              </text>
            </g>
          ))}

          <g className="rail-machine rail-machine--static" transform="translate(192 82)">
            <circle r="15" />
            <path d="M-6 -5h9l6 5-6 5h-9z" />
          </g>
          <g className="rail-machine rail-machine--moving">
            <circle r="15" />
            <path d="M-6 -5h9l6 5-6 5h-9z" />
            <animateMotion dur="11s" repeatCount="indefinite" path="M92 82 H808" />
          </g>
        </svg>
      </div>

      <div className="rail-mobile" role="img" aria-label="GitHub, contrôles, applications et VPS communiquent normalement">
        <div className="rail-mobile__track" aria-hidden="true">
          <span className="rail-mobile__machine" />
        </div>
        {stations.map((station) => (
          <span className="rail-mobile__station" key={station.id}>
            <span className="rail-mobile__dot" aria-hidden="true" />
            <strong>{station.label}</strong>
            <small>{station.detail}</small>
          </span>
        ))}
      </div>

      <div className="rail-legend" aria-label="Sources supervisées">
        <span><GitBranch aria-hidden="true" /> Analyse GitHub reçue</span>
        <span><ShieldCheck aria-hidden="true" /> Protection active</span>
        <span><Server aria-hidden="true" /> Agent VPS connecté</span>
      </div>
    </section>
  );
}
