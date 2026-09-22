"use client";

import Image from "next/image";
import { useState } from "react";

export function ApplicationIcon({ name, url }: { name: string; url: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  let source: string | null = null;

  try {
    const address = new URL(url);
    if (address.protocol === "https:" || address.protocol === "http:") {
      source = new URL("/favicon.ico", address.origin).href;
    }
  } catch {
    // Keep the application's initial when its address is invalid.
  }

  return (
    <span className="application-icon" aria-hidden="true">
      {source && source !== failedSource ? (
        <Image
          src={source}
          alt=""
          width={20}
          height={20}
          unoptimized
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <span>{Array.from(name.trim())[0]?.toLocaleUpperCase("fr-FR") ?? "?"}</span>
      )}
    </span>
  );
}
