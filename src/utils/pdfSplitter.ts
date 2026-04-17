/**
 * Utilities for splitting large PDF files into page-range chunks so each
 * chunk can be submitted to MinerU separately, and for merging the resulting
 * Markdown + asset files back into a single coherent document.
 *
 * Splitting requires an external tool (pdftk, ghostscript, or qpdf) because
 * producing a valid PDF subset purely from TypeScript is impractical in the
 * Zotero extension environment.  When no tool is available the function
 * returns null and the caller falls back to the normal single-file path.
 */

import type { MinerUExtractedFile, MinerUResult } from "./mineruClient";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PdfSplitTool = "pdftk" | "gs" | "qpdf";

export type PdfChunkRange = {
  /** 1-indexed start page */
  startPage: number;
  /** 1-indexed end page (inclusive) */
  endPage: number;
  /** Absolute path to the temp file for this chunk */
  tempPath: string;
};

export type SplitChunkResult = {
  startPage: number;
  endPage: number;
  mdContent: string;
  files: MinerUExtractedFile[];
};

// ── PDF Page Count ────────────────────────────────────────────────────────────

/**
 * Extract the total page count from raw PDF bytes.
 *
 * Reads the /Count field from the Pages dictionary in the PDF catalog.
 * Works for the vast majority of standard PDFs (linear and non-linear).
 * Returns null when the structure cannot be parsed.
 */
export function extractPdfPageCount(bytes: Uint8Array): number | null {
  // Decode as Latin-1 to get a string we can regex-search (PDF spec uses
  // byte strings; Latin-1 maps each byte 1:1 so offsets stay correct).
  let text: string;
  try {
    text = new TextDecoder("latin1", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }

  // Find all /Count N occurrences (page tree nodes).
  // The root Pages object has the largest /Count value.
  const matches = [...text.matchAll(/\/Count\s+(\d+)/g)];
  if (!matches.length) return null;

  const counts = matches
    .map((m) => parseInt(m[1], 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!counts.length) return null;

  return Math.max(...counts);
}

// ── Oversize Detection ────────────────────────────────────────────────────────

/**
 * Return true when an HTTP status code or MinerU API message string indicates
 * the rejection was due to file / page size rather than auth or other errors.
 */
export function isMineruOversizeError(
  httpStatus: number | null,
  apiMessage: string,
): boolean {
  if (httpStatus === 413) return true;
  if (!apiMessage) return false;
  return /too.?large|exceed.*page|page.*limit|page.*exceed|file.*size.*exceed|exceed.*limit.*page|oversized|文件过大|页数超/i.test(
    apiMessage,
  );
}

// ── Chunk Computation (pure, no I/O) ─────────────────────────────────────────

/**
 * Divide totalPages into non-overlapping page ranges of at most pagesPerChunk
 * pages each.  Returns an array ordered by startPage; each entry's tempPath is
 * left empty — the caller fills it in after writing the temp file.
 */
export function computeChunkRanges(
  totalPages: number,
  pagesPerChunk: number,
): Array<{ startPage: number; endPage: number }> {
  const chunks: Array<{ startPage: number; endPage: number }> = [];
  for (let start = 1; start <= totalPages; start += pagesPerChunk) {
    chunks.push({
      startPage: start,
      endPage: Math.min(start + pagesPerChunk - 1, totalPages),
    });
  }
  return chunks;
}

// ── Markdown + Asset Merge (pure, no I/O) ────────────────────────────────────

/**
 * Namespace asset paths from one chunk by prepending a per-chunk prefix
 * (e.g. `chunk_2/`) to both the relativePath on the file object and any
 * `![...](path)` / `[...](path)` Markdown image references.
 *
 * This avoids filename collisions when two chunks both contain `images/fig1.png`.
 */
function namespaceChunkAssets(
  mdContent: string,
  files: MinerUExtractedFile[],
  chunkIndex: number,
): { mdContent: string; files: MinerUExtractedFile[] } {
  if (files.length === 0) return { mdContent, files };

  const prefix = `chunk_${chunkIndex}/`;

  // Rename files
  const renamedFiles: MinerUExtractedFile[] = files.map((f) => ({
    ...f,
    relativePath: prefix + f.relativePath,
  }));

  // Replace Markdown image/link references.
  // Handles: ![alt](path) and [text](path) where path doesn't start with
  // http/https/data (i.e. relative paths only).
  const updatedMd = mdContent.replace(
    /(!?\[[^\]]*\])\((?!https?:|data:)([^)]+)\)/g,
    (_match, label, path) => `${label}(${prefix}${path})`,
  );

  return { mdContent: updatedMd, files: renamedFiles };
}

/**
 * Offset all page_idx values in a JSON content_list by pageOffset.
 * Used when merging chunks so that page-indexed citations remain correct.
 */
function offsetContentList(
  contentListJson: string,
  pageOffset: number,
): string {
  if (pageOffset === 0) return contentListJson;
  try {
    const list = JSON.parse(contentListJson) as Array<Record<string, unknown>>;
    const updated = list.map((entry) => {
      if (typeof entry.page_idx === "number") {
        return { ...entry, page_idx: entry.page_idx + pageOffset };
      }
      return entry;
    });
    return JSON.stringify(updated);
  } catch {
    return contentListJson;
  }
}

/**
 * Merge the results from multiple successfully-parsed PDF chunks into a single
 * MinerUResult.
 *
 * Rules:
 *   • Markdown sections are separated by a clear page-range header comment.
 *   • Asset paths are namespaced per chunk to prevent collisions.
 *   • content_list.json entries have their page_idx offset by the chunk's
 *     starting page so downstream manifest building produces correct citations.
 *   • If chunkResults is empty, returns null.
 */
export function mergeSplitChunkResults(
  chunkResults: SplitChunkResult[],
): MinerUResult {
  if (!chunkResults.length) return null;

  const mdParts: string[] = [];
  const allFiles: MinerUExtractedFile[] = [];

  chunkResults.forEach((chunk, idx) => {
    // Add a human-readable part separator
    const header =
      idx === 0
        ? ""
        : `\n\n<!-- PDF pages ${chunk.startPage}–${chunk.endPage} -->\n\n`;

    const pageOffset = chunk.startPage - 1; // convert 1-indexed to 0-indexed offset

    // Namespace assets and update markdown references
    const { mdContent: namespacedMd, files: namespacedFiles } =
      namespaceChunkAssets(chunk.mdContent, chunk.files, idx);

    // Offset page_idx in content_list.json (if present)
    const offsetFiles = namespacedFiles.map((f) => {
      if (/content_list\.json$/i.test(f.relativePath)) {
        try {
          const text = new TextDecoder("utf-8").decode(f.data);
          const offsetJson = offsetContentList(text, pageOffset);
          return { ...f, data: new TextEncoder().encode(offsetJson) };
        } catch {
          return f;
        }
      }
      return f;
    });

    mdParts.push(header + namespacedMd);
    allFiles.push(...offsetFiles);
  });

  return {
    mdContent: mdParts.join(""),
    files: allFiles,
  };
}

// ── External Tool Detection ───────────────────────────────────────────────────

type RunCurlLike = (args: string[], timeoutMs?: number) => Promise<number>;

/**
 * Probe whether a given binary path is executable by running it with --version
 * or a similarly harmless flag.  Returns true if the exit code is 0 or 1
 * (some tools return 1 for --version).
 */
async function probeCommand(
  runProcess: RunCurlLike,
  binaryPath: string,
  versionArg: string,
): Promise<boolean> {
  try {
    const code = await runProcess([versionArg], 5000);
    // exit 0 = success, exit 1 = some tools output version to stderr and exit 1
    return code === 0 || code === 1;
  } catch {
    return false;
  }
}

/**
 * Find the first available PDF splitting tool on this system.
 *
 * The search order is: pdftk → gs → qpdf.
 *
 * @param runProcessFactory  A factory that takes a binary path and returns a
 *   run-process function (matching the `runCurl` signature).  Injected for
 *   testability.
 */
export async function findPdfSplitTool(
  runProcessFactory: (binaryPath: string) => RunCurlLike,
): Promise<{ tool: PdfSplitTool; binaryPath: string } | null> {
  const candidates: Array<{ tool: PdfSplitTool; paths: string[] }> = [
    {
      tool: "pdftk",
      paths: [
        "/usr/bin/pdftk",
        "/usr/local/bin/pdftk",
        "pdftk", // PATH lookup (Windows)
        "C:\\Program Files\\PDFtk Server\\bin\\pdftk.exe",
      ],
    },
    {
      tool: "gs",
      paths: [
        "/usr/bin/gs",
        "/usr/local/bin/gs",
        "/opt/homebrew/bin/gs",
        "gswin64c", // Windows Ghostscript
        "gs",
      ],
    },
    {
      tool: "qpdf",
      paths: [
        "/usr/bin/qpdf",
        "/usr/local/bin/qpdf",
        "/opt/homebrew/bin/qpdf",
        "qpdf",
      ],
    },
  ];

  for (const { tool, paths } of candidates) {
    for (const binaryPath of paths) {
      const run = runProcessFactory(binaryPath);
      if (await probeCommand(run, binaryPath, "--version")) {
        return { tool, binaryPath };
      }
    }
  }

  return null;
}

// ── Chunk File Splitting ──────────────────────────────────────────────────────

/**
 * Build the command arguments needed to extract a page range from a PDF.
 *
 * @param tool       Which external tool to use.
 * @param binaryPath Full path to the binary.
 * @param inputPath  Full path to the source PDF.
 * @param startPage  1-indexed first page.
 * @param endPage    1-indexed last page (inclusive).
 * @param outputPath Full path for the output PDF.
 */
export function buildSplitArgs(
  tool: PdfSplitTool,
  inputPath: string,
  startPage: number,
  endPage: number,
  outputPath: string,
): string[] {
  switch (tool) {
    case "pdftk":
      // pdftk A=input.pdf cat A1-50 output out.pdf
      return [
        `A=${inputPath}`,
        "cat",
        `A${startPage}-${endPage}`,
        "output",
        outputPath,
      ];
    case "gs":
      // gs -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite -dFirstPage=1 -dLastPage=50 -sOutputFile=out.pdf input.pdf
      return [
        "-dBATCH",
        "-dNOPAUSE",
        "-q",
        "-sDEVICE=pdfwrite",
        `-dFirstPage=${startPage}`,
        `-dLastPage=${endPage}`,
        `-sOutputFile=${outputPath}`,
        inputPath,
      ];
    case "qpdf":
      // qpdf --empty --pages input.pdf 1-50 -- out.pdf
      return [
        "--empty",
        "--pages",
        inputPath,
        `${startPage}-${endPage}`,
        "--",
        outputPath,
      ];
  }
}
