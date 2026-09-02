"use client";

import { useState, useTransition } from "react";
import { Check, RefreshCw, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { scanApplication } from "@/app/actions";

export function ScanApplicationButton({ applicationId, applicationName }: { applicationId: string; applicationName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ status: "success" | "error"; message: string }>();

  function runScan() {
    startTransition(async () => {
      const nextResult = await scanApplication(applicationId);
      setResult(nextResult);
      if (nextResult.status === "success") router.refresh();
    });
  }

  return (
    <button
      className={`row-action ${result ? `row-action--${result.status}` : ""}`}
      type="button"
      onClick={runScan}
      disabled={pending}
      aria-label={`Analyser le dépôt de ${applicationName}`}
      title={result?.message ?? "Analyser maintenant"}
    >
      {pending ? <RefreshCw className="spin" aria-hidden="true" /> : result?.status === "success" ? <Check aria-hidden="true" /> : result?.status === "error" ? <TriangleAlert aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
    </button>
  );
}
