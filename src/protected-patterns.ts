function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function escapeRegExpChar(character: string): string {
  return /[\\.^$+{}()|\[\]]/.test(character) ? `\\${character}` : character;
}

export function matchesGlob(inputPath: string, pattern: string): boolean {
  if (!pattern) return false;

  const input = normalizePath(inputPath);
  const normalizedPattern = normalizePath(pattern);
  let regex = "^";

  for (let index = 0; index < normalizedPattern.length; index++) {
    const character = normalizedPattern[index];
    if (character === "*") {
      if (normalizedPattern[index + 1] === "*") {
        if (normalizedPattern[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (character === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegExpChar(character ?? "");
    }
  }

  return new RegExp(`${regex}$`).test(input);
}

const PATH_KEYS: Record<string, true> = {
  path: true,
  paths: true,
  filePath: true,
  filePaths: true,
  cwd: true,
  directory: true,
  target: true,
  destination: true,
};

const READ_RANGE = String.raw`\d+(?:-\d*|\+\d+)?`;
const READ_SELECTOR_SUFFIX = new RegExp(
  `:(?:conflicts|raw(?::${READ_RANGE}(?:,${READ_RANGE})*)?|${READ_RANGE}(?:,${READ_RANGE})*(?::raw)?)$`,
  "i",
);

function stripReadSelector(input: string): string {
  if (/^https?:\/\/[^/]+:\d+$/i.test(input)) return input;
  return input.replace(READ_SELECTOR_SUFFIX, "");
}

export function getFilePathsFromParameters(tool: string, parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return [];

  const paths: string[] = [];
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      if (key && PATH_KEYS[key]) {
        paths.push(value);
        const basePath = stripReadSelector(value);
        if (basePath !== value) paths.push(basePath);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [nestedKey, nestedValue] of Object.entries(value)) visit(nestedValue, nestedKey);
  };

  visit(parameters);

  const object = parameters as Record<string, unknown>;
  if (tool === "apply_patch" && typeof object.patchText === "string") {
    for (const match of object.patchText.matchAll(/\*\*\* (?:Add|Delete|Update) File: ([^\n\r]+)/g)) {
      if (match[1]) paths.push(match[1].trim());
    }
  }

  if (tool === "edit" && typeof object.patch === "string") {
    for (const match of object.patch.matchAll(/^\[([^#\]\r\n]+)#[0-9A-F]{4}\]$/gm)) {
      if (match[1]) paths.push(match[1].trim());
    }
  }

  return [...new Set(paths.filter(Boolean))];
}

export function isFilePathProtected(filePaths: readonly string[], patterns: readonly string[]): boolean {
  return filePaths.some((filePath) => patterns.some((pattern) => matchesGlob(filePath, pattern)));
}

export function isToolNameProtected(toolName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => (pattern.includes("*") || pattern.includes("?"))
    ? matchesGlob(toolName, pattern)
    : toolName === pattern);
}
