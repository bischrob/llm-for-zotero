type ParsedLocalPath =
  | { kind: "unc"; host: string; share: string; segments: string[] }
  | { kind: "windows-drive"; drive: string; segments: string[] }
  | { kind: "posix"; segments: string[] }
  | { kind: "relative"; segments: string[]; separator: "/" | "\\" };

function splitPathSegments(value: string | undefined): string[] {
  return (value || "").split(/[\\/]+/).filter(Boolean);
}

function parseLocalPath(path: string | undefined): ParsedLocalPath {
  const raw = (path || "").trim();
  if (!raw) {
    return { kind: "relative", segments: [], separator: "/" };
  }

  const uncMatch = raw.match(
    /^(?:\\\\|\/\/)([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/,
  );
  if (uncMatch) {
    return {
      kind: "unc",
      host: uncMatch[1],
      share: uncMatch[2],
      segments: splitPathSegments(uncMatch[3]),
    };
  }

  const driveMatch = raw.match(/^([A-Za-z]:)(?:[\\/]+(.*))?$/);
  if (driveMatch) {
    return {
      kind: "windows-drive",
      drive: driveMatch[1],
      segments: splitPathSegments(driveMatch[2]),
    };
  }

  if (raw.startsWith("/")) {
    return {
      kind: "posix",
      segments: splitPathSegments(raw),
    };
  }

  return {
    kind: "relative",
    segments: splitPathSegments(raw),
    separator: raw.includes("\\") ? "\\" : "/",
  };
}

function formatLocalPath(path: ParsedLocalPath): string {
  if (path.kind === "unc") {
    const root = `\\\\${path.host}\\${path.share}`;
    return path.segments.length ? `${root}\\${path.segments.join("\\")}` : root;
  }
  if (path.kind === "windows-drive") {
    const root = `${path.drive}\\`;
    return path.segments.length ? `${root}${path.segments.join("\\")}` : root;
  }
  if (path.kind === "posix") {
    return path.segments.length ? `/${path.segments.join("/")}` : "/";
  }
  return path.segments.join(path.separator);
}

function encodeFileUrlSegments(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function decodeFileUrlSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

export function isUncPath(path: string | undefined): boolean {
  return parseLocalPath(path).kind === "unc";
}

export function isWindowsDriveAbsolutePath(path: string | undefined): boolean {
  return parseLocalPath(path).kind === "windows-drive";
}

export function joinLocalPath(...parts: string[]): string {
  const filtered = parts.filter((part) => Boolean(part));
  if (!filtered.length) return "";

  const base = parseLocalPath(filtered[0]);
  const segments = [...base.segments];
  for (const part of filtered.slice(1)) {
    segments.push(...splitPathSegments(part));
  }

  if (base.kind === "unc") {
    return formatLocalPath({
      kind: "unc",
      host: base.host,
      share: base.share,
      segments,
    });
  }
  if (base.kind === "windows-drive") {
    return formatLocalPath({
      kind: "windows-drive",
      drive: base.drive,
      segments,
    });
  }
  if (base.kind === "posix") {
    return formatLocalPath({
      kind: "posix",
      segments,
    });
  }
  return formatLocalPath({
    kind: "relative",
    segments,
    separator: base.separator,
  });
}

export function getLocalParentPath(path: string): string {
  const parsed = parseLocalPath(path);
  if (parsed.kind === "unc") {
    return formatLocalPath({
      kind: "unc",
      host: parsed.host,
      share: parsed.share,
      segments: parsed.segments.slice(0, -1),
    });
  }
  if (parsed.kind === "windows-drive") {
    return formatLocalPath({
      kind: "windows-drive",
      drive: parsed.drive,
      segments: parsed.segments.slice(0, -1),
    });
  }
  if (parsed.kind === "posix") {
    return formatLocalPath({
      kind: "posix",
      segments: parsed.segments.slice(0, -1),
    });
  }
  return formatLocalPath({
    kind: "relative",
    segments: parsed.segments.slice(0, -1),
    separator: parsed.separator,
  });
}

export function fileUrlToPath(url: string | undefined): string | undefined {
  const raw = (url || "").trim();
  if (!raw) return undefined;
  if (!/^file:\/\//i.test(raw)) return undefined;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "file:") return undefined;

    if (parsed.host) {
      const segments = decodeFileUrlSegments(parsed.pathname);
      const [share, ...rest] = segments;
      if (!share) return undefined;
      return formatLocalPath({
        kind: "unc",
        host: parsed.host,
        share,
        segments: rest,
      });
    }

    const pathname = parsed.pathname || "";
    if (/^\/\/[^/]+\/[^/]+/.test(pathname)) {
      const [host, share, ...rest] = decodeFileUrlSegments(pathname);
      if (host && share) {
        return formatLocalPath({
          kind: "unc",
          host,
          share,
          segments: rest,
        });
      }
    }

    const decodedPath = decodeURIComponent(pathname);
    if (!decodedPath) return undefined;
    if (/^\/[A-Za-z]:(?:\/|$)/.test(decodedPath)) {
      return decodedPath.slice(1).replace(/\//g, "\\");
    }
    return decodedPath;
  } catch (_err) {
    return undefined;
  }
}

export function toFileUrl(path: string | undefined): string | undefined {
  const raw = (path || "").trim();
  if (!raw) return undefined;
  if (/^file:\/\//i.test(raw)) return raw;

  const parsed = parseLocalPath(raw);
  if (parsed.kind === "unc") {
    const pathSegments = [parsed.share, ...parsed.segments];
    const pathname = encodeFileUrlSegments(pathSegments);
    return `file://${parsed.host}/${pathname}`;
  }
  if (parsed.kind === "windows-drive") {
    const encodedTail = encodeFileUrlSegments(parsed.segments);
    return encodedTail
      ? `file:///${parsed.drive}/${encodedTail}`
      : `file:///${parsed.drive}/`;
  }
  if (parsed.kind === "posix") {
    const encodedTail = encodeFileUrlSegments(parsed.segments);
    return encodedTail ? `file:///${encodedTail}` : "file:///";
  }
  return undefined;
}

export const pathToFileUrl = toFileUrl;
