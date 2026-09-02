import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Luigi — Cockpit de supervision",
    short_name: "Luigi",
    description: "Supervision des applications, du VPS et des maintenances.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f4f1",
    theme_color: "#6253a3",
    lang: "fr",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
