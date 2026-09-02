"use server";

import { count } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { account, user, workspaceMembers, workspaces } from "@/db/schema";
import { auth } from "@/lib/auth";

export type AuthActionState = {
  error: string;
};

const credentialsSchema = z.object({
  email: z.string().trim().email("L’adresse email n’est pas valide."),
  password: z.string().min(12, "Le mot de passe doit contenir au moins 12 caractères.").max(128),
});

const setupSchema = credentialsSchema.extend({
  name: z.string().trim().min(2, "Indique ton nom.").max(80),
  confirmation: z.string(),
}).refine((data) => data.password === data.confirmation, {
  message: "Les mots de passe ne correspondent pas.",
  path: ["confirmation"],
});

function formValues(formData: FormData) {
  return Object.fromEntries(formData.entries());
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.toLowerCase().includes("password")) {
    return "Le mot de passe ne respecte pas les règles de sécurité.";
  }
  return "Impossible de poursuivre. Vérifie les informations puis réessaie.";
}

export async function setupAdmin(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = setupSchema.safeParse(formValues(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Formulaire incomplet." };

  const [{ total: configuredAccounts }] = await db.select({ total: count() }).from(account);
  if (configuredAccounts > 0) return { error: "Luigi possède déjà un administrateur." };

  const [{ total: incompleteUsers }] = await db.select({ total: count() }).from(user);
  if (incompleteUsers > 0) {
    // Répare uniquement une initialisation interrompue avant la création des identifiants.
    await db.delete(user);
  }

  try {
    const result = await auth.api.signUpEmail({
      headers: await headers(),
      body: {
        name: parsed.data.name,
        email: parsed.data.email.toLowerCase(),
        password: parsed.data.password,
      },
    });

    await db.transaction(async (transaction) => {
      const [workspace] = await transaction
        .insert(workspaces)
        .values({ name: "Infrastructure" })
        .returning({ id: workspaces.id });
      await transaction.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: result.user.id,
        role: "owner",
      });
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }

  redirect("/");
}

export async function signIn(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = credentialsSchema.safeParse(formValues(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Formulaire incomplet." };

  try {
    await auth.api.signInEmail({
      headers: await headers(),
      body: {
        email: parsed.data.email.toLowerCase(),
        password: parsed.data.password,
      },
    });
  } catch {
    return { error: "Email ou mot de passe incorrect." };
  }

  redirect("/");
}

export async function signOut() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/login");
}
