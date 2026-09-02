import type { ReactNode } from "react";
import { Activity, ShieldCheck, TrainFront } from "lucide-react";
import Link from "next/link";

type AuthShellProps = {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
};

export function AuthShell({ eyebrow, title, description, children }: AuthShellProps) {
  return (
    <main className="auth-shell">
      <section className="auth-ambient" aria-label="État du système">
        <Link className="brand auth-brand" href="/" aria-label="Luigi">
          <span className="brand__mark" aria-hidden="true"><TrainFront /></span>
          <span className="brand__name">Luigi</span>
        </Link>
        <div className="auth-ambient__message">
          <span className="auth-signal"><Activity aria-hidden="true" /></span>
          <p className="eyebrow">La vigie de ton infrastructure</p>
          <h2>Une présence calme.<br />Des signaux utiles.</h2>
          <p>Luigi regroupe la disponibilité, la sécurité, les mises à jour et la maintenance au même endroit.</p>
        </div>
        <div className="auth-track" aria-hidden="true">
          <span className="auth-track__line" />
          <span className="auth-track__train"><TrainFront /></span>
          <span className="auth-track__station"><ShieldCheck /></span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
          {children}
        </div>
      </section>
    </main>
  );
}
