import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { hasConfiguredAdmin } from "@/lib/dal";
import { setupAdmin } from "@/app/(auth)/actions";

export default async function SetupPage() {
  if (await hasConfiguredAdmin()) redirect("/login");

  return (
    <AuthShell
      eyebrow="Première mise en route"
      title="Préparons le poste de contrôle."
      description="Crée le compte administrateur unique de Luigi. Tu ajouteras ensuite tes applications et ton VPS."
    >
      <AuthForm mode="setup" action={setupAdmin} />
    </AuthShell>
  );
}
