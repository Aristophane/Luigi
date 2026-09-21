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

/**
 * Liste les images référencées par une page, celles de l'optimiseur Next.js en premier :
 * ce sont elles qui cessent de répondre quand le processus Node sature.
 */
export function extractImageCandidates(html: string, pageUrl: string) {
  const references: string[] = [];
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = readAttribute(tag, "src");
    if (src) references.push(src);
    references.push(...srcsetUrls(readAttribute(tag, "srcset")));
  }
  for (const [tag] of html.matchAll(/<source\b[^>]*>/gi)) {
    references.push(...srcsetUrls(readAttribute(tag, "srcset")));
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/^preload$/i.test(readAttribute(tag, "rel") ?? "") || !/^image$/i.test(readAttribute(tag, "as") ?? "")) continue;
    const href = readAttribute(tag, "href");
    if (href) references.push(href);
    references.push(...srcsetUrls(readAttribute(tag, "imagesrcset")));
  }

  const candidates = new Set<string>();
  for (const reference of references) {
    if (/^(data|blob):/i.test(reference)) continue;
    const resolved = resolveAssetUrl(reference, pageUrl);
    if (resolved) candidates.add(resolved);
    if (candidates.size >= MAX_IMAGE_CANDIDATES) break;
  }
  const ordered = [...candidates];
  return [
    ...ordered.filter(isNextImageOptimizerUrl),
    ...ordered.filter((candidate) => !isNextImageOptimizerUrl(candidate)),
  ];
}

/** Chemin lisible d'une ressource, sans query string : elle peut porter une signature. */
export function describeResource(value: string) {
  try {
    return truncateLabel(new URL(value).pathname, 60);
  } catch {
    return "ressource inconnue";
  }
}

export function truncateLabel(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
