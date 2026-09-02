import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { getSession, hasConfiguredAdmin } from "@/lib/dal";
import { signIn } from "@/app/(auth)/actions";

export default async function LoginPage() {
  if (!(await hasConfiguredAdmin())) redirect("/setup");
  if (await getSession()) redirect("/");

  return (
    <AuthShell
      eyebrow="Accès administrateur"
      title="Content de te revoir."
      description="Retrouve l’état de tes applications, de ton VPS et les actions qui demandent ton attention."
    >
      <AuthForm mode="login" action={signIn} />
    </AuthShell>
  );
}
