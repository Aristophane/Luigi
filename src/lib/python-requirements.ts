// Deliberately limited to final PEP 440 releases. Other valid PEP 440 forms are
// reported as unsupported, rather than compared with npm's different rules.
// https://packaging.python.org/en/latest/specifications/version-specifiers/
export function pythonRelease(value: string): number[] | undefined {
  const match = value.trim().match(/^v?(\d+(?:\.\d+)*)$/i);
  if (!match) return undefined;
  const parts = match[1].split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

export function comparePythonVersions(left: string, right: string): number | undefined {
  const a = pythonRelease(left);
  const b = pythonRelease(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const comparison = (a[index] ?? 0) - (b[index] ?? 0);
    if (comparison) return Math.sign(comparison);
  }
  return 0;
}

type PythonSpecifier = { operator: string; version: string; parts: number[]; wildcard: boolean };

function pythonSpecifiers(range: string): PythonSpecifier[] | undefined {
  let value = range.trim();
  if (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1).trim();
  if (!value) return [];
  // PEP 508 permits a trailing comma, but never an empty intermediate clause.
  const clauses = value.replace(/,\s*$/, "").split(",");
  const specifiers: PythonSpecifier[] = [];
  for (const clause of clauses) {
    const match = clause.trim().match(/^(~=|==|!=|<=|>=|<|>)\s*(v?\d+(?:\.\d+)*)(\.\*)?$/i);
    if (!match) return undefined;
    const parts = pythonRelease(match[2]);
    if (!parts || (match[3] && !["==", "!="].includes(match[1])) || (match[1] === "~=" && parts.length < 2)) return undefined;
    specifiers.push({ operator: match[1], version: match[2], parts, wildcard: Boolean(match[3]) });
  }
  return specifiers;
}

export function supportsPythonSpecifier(range: string) {
  return pythonSpecifiers(range) !== undefined;
}

export function pinnedPythonVersion(range: string) {
  const specifiers = pythonSpecifiers(range);
  if (specifiers?.length !== 1 || specifiers[0].operator !== "==" || specifiers[0].wildcard) return undefined;
  return specifiers[0].parts.join(".");
}

export function pythonVersionSatisfies(version: string, range: string): boolean | undefined {
  const candidate = pythonRelease(version);
  const specifiers = pythonSpecifiers(range);
  if (!candidate || !specifiers) return undefined;
  return specifiers.every((specifier) => {
    const comparison = comparePythonVersions(version, specifier.version)!;
    const samePrefix = specifier.parts.every((part, index) => (candidate[index] ?? 0) === part);
    switch (specifier.operator) {
      case "==": return specifier.wildcard ? samePrefix : comparison === 0;
      case "!=": return specifier.wildcard ? !samePrefix : comparison !== 0;
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
      case "~=": return comparison >= 0 && specifier.parts.slice(0, -1).every((part, index) => (candidate[index] ?? 0) === part);
      default: return false;
    }
  });
}

export type ParsedPythonRequirement = {
  name: string;
  requestedRange: string;
  currentVersion?: string;
  unsupportedReason?: string;
};

export function parsePythonRequirements(content: string) {
  const dependencies: ParsedPythonRequirement[] = [];
  const limitations: string[] = [];
  const lines = content.replace(/^\uFEFF/, "").replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const customIndex = lines.some((line) => /^\s*(?:--(?:(?:extra-)?index-url|find-links|no-index)(?:\s|=|$)|-[if](?:\s|=))/.test(line));
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/);
    if (!match) {
      limitations.push("Une directive pip, une inclusion ou une référence sans nom n’est pas analysée.");
      continue;
    }
    const name = match[1].toLowerCase().replace(/[-_.]+/g, "-");
    const requestedRange = match[2].trim();
    const supported = supportsPythonSpecifier(requestedRange);
    const unsupportedReason = customIndex ? "Index pip personnalisé : comparaison avec PyPI public non applicable."
      : supported ? undefined : "Contrainte Python non suivie : marqueur, URL ou forme PEP 440 non prise en charge.";
    if (unsupportedReason) limitations.push(`${name} : ${unsupportedReason}`);
    dependencies.push({ name, requestedRange, currentVersion: supported ? pinnedPythonVersion(requestedRange) : undefined, unsupportedReason });
  }
  return { dependencies, limitations: [...new Set(limitations)] };
}
