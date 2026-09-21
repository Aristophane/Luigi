const MAX_IMAGE_CANDIDATES = 20;

const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function decodeHtmlAttribute(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#")) {
      const point = code[1] === "x" || code[1] === "X"
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return namedEntities[code.toLowerCase()] ?? entity;
  });
}

function readAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`, "i"));
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw === undefined ? undefined : decodeHtmlAttribute(raw.trim());
}

function srcsetUrls(value: string | undefined) {
  const urls: string[] = [];
  if (!value) return urls;
  let position = 0;
  while (position < value.length) {
    while (position < value.length && /[\s,]/.test(value[position])) position += 1;
    const start = position;
    while (position < value.length && !/\s/.test(value[position])) position += 1;
    let url = value.slice(start, position);
    const trailingCommas = url.match(/,+$/)?.[0];
    if (trailingCommas) {
      url = url.slice(0, -trailingCommas.length);
    } else {
      while (position < value.length && value[position] !== ",") position += 1;
    }
    if (url) urls.push(url);
  }
  return urls;
}

export function isNextImageOptimizerUrl(value: string) {
  try {
    return new URL(value).pathname.endsWith("/_next/image");
  } catch {
    return false;
  }
}

export function resolveAssetUrl(value: string, pageUrl: string) {
  try {
    const url = new URL(value, pageUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Paramètres de redimensionnement usuels : Next.js, Vendure, imgix, Cloudinary, Shopify… */
const TRANSFORM_PARAMETERS = ["w", "h", "width", "height", "format", "fm", "q", "quality", "preset", "mode", "fit", "resize"];

function isTransformedImageUrl(value: string) {
  try {
    const url = new URL(value);
    return TRANSFORM_PARAMETERS.some((parameter) => url.searchParams.has(parameter));
  } catch {
    return false;
  }
}

/**
 * Liste les images référencées par une page, de la plus révélatrice à la moins révélatrice.
 * Une image redimensionnée à la volée (optimiseur Next.js, serveur d'assets Vendure, CDN d'images)
 * sollicite un processus Node qui peut saturer, contrairement à un logo statique ; l'image principale,
 * chargée sans attendre le défilement, passe devant les vignettes.
 */
export function extractImageCandidates(html: string, pageUrl: string) {
  const references: Array<{ value: string; eager: boolean }> = [];
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const eager = !/^lazy$/i.test(readAttribute(tag, "loading") ?? "");
    const src = readAttribute(tag, "src");
    if (src) references.push({ value: src, eager });
    references.push(...srcsetUrls(readAttribute(tag, "srcset")).map((value) => ({ value, eager })));
  }
  for (const [tag] of html.matchAll(/<source\b[^>]*>/gi)) {
    references.push(...srcsetUrls(readAttribute(tag, "srcset")).map((value) => ({ value, eager: false })));
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/^preload$/i.test(readAttribute(tag, "rel") ?? "") || !/^image$/i.test(readAttribute(tag, "as") ?? "")) continue;
    const href = readAttribute(tag, "href");
    if (href) references.push({ value: href, eager: true });
    references.push(...srcsetUrls(readAttribute(tag, "imagesrcset")).map((value) => ({ value, eager: true })));
  }

  const candidates = new Map<string, { order: number; eager: boolean }>();
  for (const reference of references) {
    if (/^(data|blob):/i.test(reference.value)) continue;
    const resolved = resolveAssetUrl(reference.value, pageUrl);
    if (!resolved) continue;
    const known = candidates.get(resolved);
    if (known) {
      known.eager ||= reference.eager;
    } else if (candidates.size < MAX_IMAGE_CANDIDATES) {
      candidates.set(resolved, { order: candidates.size, eager: reference.eager });
    }
  }
  const score = (url: string, eager: boolean) =>
    (isNextImageOptimizerUrl(url) ? 4 : 0) + (isTransformedImageUrl(url) ? 2 : 0) + (eager ? 1 : 0);
  return [...candidates.entries()]
    .sort(([leftUrl, left], [rightUrl, right]) =>
      score(rightUrl, right.eager) - score(leftUrl, left.eager) || left.order - right.order)
    .map(([url]) => url);
}

function readablePath(url: URL) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

/**
 * Libellé lisible d'une ressource. La query string n'est jamais reprise telle quelle, car elle peut porter
 * une signature : seuls les paramètres de redimensionnement connus sont conservés. L'hôte est indiqué
 * quand il diffère de la page, par exemple un serveur d'assets séparé.
 * Pour l'optimiseur Next.js, le chemin seul ne dit pas quelle image a été testée : on affiche sa source.
 */
export function describeResource(value: string, pageUrl?: string) {
  try {
    const url = new URL(value);
    const source = isNextImageOptimizerUrl(value) ? url.searchParams.get("url") : null;
    if (source) return `${truncateLabel(readablePath(new URL(source, url)), 60)} via /_next/image`;
    const host = pageUrl && new URL(pageUrl).host !== url.host ? url.host : "";
    const transforms = TRANSFORM_PARAMETERS
      .filter((parameter) => url.searchParams.has(parameter))
      .map((parameter) => `${parameter}=${truncateLabel(url.searchParams.get(parameter) ?? "", 12)}`)
      .join("&");
    return `${host}${truncateLabel(readablePath(url), 60)}${transforms ? `?${transforms}` : ""}`;
  } catch {
    return "ressource inconnue";
  }
}

export function truncateLabel(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
