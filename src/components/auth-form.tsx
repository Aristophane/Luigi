"use client";

import { useActionState } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import type { AuthActionState } from "@/app/(auth)/actions";

type AuthFormProps = {
  mode: "setup" | "login";
  action: (state: AuthActionState, formData: FormData) => Promise<AuthActionState>;
};

const initialState: AuthActionState = { error: "" };

export function AuthForm({ mode, action }: AuthFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const isSetup = mode === "setup";

  return (
    <form className="auth-form" action={formAction}>
      {isSetup && (
        <label>
          <span>Ton nom</span>
          <input name="name" autoComplete="name" required minLength={2} maxLength={80} autoFocus />
        </label>
      )}
      <label>
        <span>Adresse email</span>
        <input name="email" type="email" autoComplete="email" required autoFocus={!isSetup} />
      </label>
      <label>
        <span>Mot de passe</span>
        <input name="password" type="password" autoComplete={isSetup ? "new-password" : "current-password"} required minLength={12} maxLength={128} />
        {isSetup && <small>12 caractères minimum. Il protège l’accès à toute ton infrastructure.</small>}
      </label>
      {isSetup && (
        <label>
          <span>Confirmer le mot de passe</span>
          <input name="confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
        </label>
      )}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <button className="button button--primary auth-submit" type="submit" disabled={pending}>
        {pending ? "Connexion sécurisée…" : isSetup ? "Créer mon espace" : "Ouvrir Luigi"}
        {!pending && <ArrowRight aria-hidden="true" />}
      </button>
      {isSetup && (
        <p className="auth-form__assurance"><ShieldCheck aria-hidden="true" />Un seul compte peut être créé dans cette version.</p>
      )}
    </form>
  );
}
