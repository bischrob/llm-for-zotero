import { assert } from "chai";
import { strToU8 } from "fflate";
import {
  extractPdfPageCount,
  isMineruOversizeError,
  computeChunkRanges,
  buildSplitArgs,
  mergeSplitChunkResults,
} from "../src/utils/pdfSplitter";
import type { SplitChunkResult } from "../src/utils/pdfSplitter";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePdfBytes(pageCount: number): Uint8Array {
  // Minimal but structurally valid enough for extractPdfPageCount
  const body =
    `%PDF-1.4\n` +
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [] >>\nendobj\n`;
  return strToU8(body);
}

// ── extractPdfPageCount ───────────────────────────────────────────────────────

describe("extractPdfPageCount", function () {
  it("extracts a single /Count value", function () {
    const bytes = makePdfBytes(42);
    assert.equal(extractPdfPageCount(bytes), 42);
  });

  it("returns the maximum /Count when multiple are present (nested page trees)", function () {
    const body =
      `%PDF-1.4\n` +
      `1 0 obj\n<< /Count 10 >>\nendobj\n` +
      `2 0 obj\n<< /Count 350 >>\nendobj\n` +
      `3 0 obj\n<< /Count 5 >>\nendobj\n`;
    const bytes = strToU8(body);
    assert.equal(extractPdfPageCount(bytes), 350);
  });

  it("returns null for a non-PDF byte sequence", function () {
    const bytes = strToU8("this is not a pdf");
    assert.isNull(extractPdfPageCount(bytes));
  });

  it("returns null for an empty byte array", function () {
    assert.isNull(extractPdfPageCount(new Uint8Array(0)));
  });

  it("handles /Count with varying whitespace", function () {
    const body = `%PDF-1.7\n<< /Type /Pages /Count   77  >>\n`;
    const bytes = strToU8(body);
    assert.equal(extractPdfPageCount(bytes), 77);
  });
});

// ── isMineruOversizeError ─────────────────────────────────────────────────────

describe("isMineruOversizeError", function () {
  it("detects HTTP 413", function () {
    assert.isTrue(isMineruOversizeError(413, ""));
  });

  it("detects 'file too large' message", function () {
    assert.isTrue(isMineruOversizeError(400, "file too large"));
  });

  it("detects 'exceed page limit' message", function () {
    assert.isTrue(isMineruOversizeError(400, "You exceed page limit"));
  });

  it("detects 'page exceeds' message", function () {
    assert.isTrue(
      isMineruOversizeError(422, "page count exceeds the allowed limit"),
    );
  });

  it("does not flag ordinary 400 errors", function () {
    assert.isFalse(isMineruOversizeError(400, "invalid file format"));
  });

  it("does not flag rate limit errors", function () {
    assert.isFalse(isMineruOversizeError(429, "rate limit exceeded"));
  });

  it("does not flag non-error statuses", function () {
    assert.isFalse(isMineruOversizeError(200, ""));
  });
});

// ── computeChunkRanges ────────────────────────────────────────────────────────

describe("computeChunkRanges", function () {
  it("produces a single chunk when totalPages ≤ pagesPerChunk", function () {
    const ranges = computeChunkRanges(50, 100);
    assert.deepEqual(ranges, [{ startPage: 1, endPage: 50 }]);
  });

  it("divides evenly", function () {
    const ranges = computeChunkRanges(200, 100);
    assert.deepEqual(ranges, [
      { startPage: 1, endPage: 100 },
      { startPage: 101, endPage: 200 },
    ]);
  });

  it("handles a remainder", function () {
    const ranges = computeChunkRanges(250, 100);
    assert.deepEqual(ranges, [
      { startPage: 1, endPage: 100 },
      { startPage: 101, endPage: 200 },
      { startPage: 201, endPage: 250 },
    ]);
  });

  it("handles a 1-page PDF", function () {
    const ranges = computeChunkRanges(1, 100);
    assert.deepEqual(ranges, [{ startPage: 1, endPage: 1 }]);
  });
});

// ── buildSplitArgs ────────────────────────────────────────────────────────────

describe("buildSplitArgs", function () {
  const input = "/tmp/book.pdf";
  const output = "/tmp/chunk.pdf";

  it("builds pdftk args correctly", function () {
    const args = buildSplitArgs("pdftk", input, 1, 50, output);
    assert.deepEqual(args, [`A=${input}`, "cat", "A1-50", "output", output]);
  });

  it("builds gs args correctly", function () {
    const args = buildSplitArgs("gs", input, 51, 100, output);
    assert.deepEqual(args, [
      "-dBATCH",
      "-dNOPAUSE",
      "-q",
      "-sDEVICE=pdfwrite",
      "-dFirstPage=51",
      "-dLastPage=100",
      `-sOutputFile=${output}`,
      input,
    ]);
  });

  it("builds qpdf args correctly", function () {
    const args = buildSplitArgs("qpdf", input, 1, 50, output);
    assert.deepEqual(args, ["--empty", "--pages", input, "1-50", "--", output]);
  });
});

// ── mergeSplitChunkResults ────────────────────────────────────────────────────

describe("mergeSplitChunkResults", function () {
  it("returns null for an empty array", function () {
    assert.isNull(mergeSplitChunkResults([]));
  });

  it("returns a single chunk unchanged (aside from part header)", function () {
    const chunk: SplitChunkResult = {
      startPage: 1,
      endPage: 50,
      mdContent: "# Title\nBody text.",
      files: [],
    };
    const result = mergeSplitChunkResults([chunk]);
    assert.isNotNull(result);
    assert.include(result!.mdContent, "# Title");
  });

  it("concatenates two chunks with a separator comment", function () {
    const chunks: SplitChunkResult[] = [
      {
        startPage: 1,
        endPage: 100,
        mdContent: "Part one.",
        files: [],
      },
      {
        startPage: 101,
        endPage: 200,
        mdContent: "Part two.",
        files: [],
      },
    ];
    const result = mergeSplitChunkResults(chunks);
    assert.isNotNull(result);
    assert.include(result!.mdContent, "Part one.");
    assert.include(result!.mdContent, "Part two.");
    assert.include(result!.mdContent, "<!-- PDF pages 101");
  });

  it("namespaces asset paths to avoid filename collisions", function () {
    const makeFile = (path: string) => ({
      relativePath: path,
      data: new Uint8Array([1, 2, 3]),
    });

    const chunks: SplitChunkResult[] = [
      {
        startPage: 1,
        endPage: 50,
        mdContent: "![fig](images/fig1.png)",
        files: [makeFile("images/fig1.png")],
      },
      {
        startPage: 51,
        endPage: 100,
        mdContent: "![fig](images/fig1.png)",
        files: [makeFile("images/fig1.png")],
      },
    ];

    const result = mergeSplitChunkResults(chunks);
    assert.isNotNull(result);

    const filePaths = result!.files.map((f) => f.relativePath);
    assert.include(filePaths, "chunk_0/images/fig1.png");
    assert.include(filePaths, "chunk_1/images/fig1.png");

    assert.include(result!.mdContent, "(chunk_0/images/fig1.png)");
    assert.include(result!.mdContent, "(chunk_1/images/fig1.png)");
  });

  it("does not modify external http URLs in markdown", function () {
    const chunks: SplitChunkResult[] = [
      {
        startPage: 1,
        endPage: 50,
        mdContent:
          "![remote](https://example.com/fig.png) and ![local](images/fig.png)",
        files: [{ relativePath: "images/fig.png", data: new Uint8Array() }],
      },
    ];
    const result = mergeSplitChunkResults(chunks);
    assert.isNotNull(result);
    assert.include(result!.mdContent, "https://example.com/fig.png");
    assert.notInclude(result!.mdContent, "chunk_0/https://");
  });

  it("offsets page_idx in content_list.json", function () {
    const contentList = JSON.stringify([
      { page_idx: 0, text: "first page" },
      { page_idx: 5, text: "sixth page" },
    ]);

    const chunks: SplitChunkResult[] = [
      {
        startPage: 1,
        endPage: 50,
        mdContent: "chunk 1",
        files: [],
      },
      {
        startPage: 51,
        endPage: 100,
        mdContent: "chunk 2",
        files: [
          {
            relativePath: "abc_content_list.json",
            data: new TextEncoder().encode(contentList),
          },
        ],
      },
    ];

    const result = mergeSplitChunkResults(chunks);
    assert.isNotNull(result);

    const clFile = result!.files.find((f) =>
      f.relativePath.endsWith("content_list.json"),
    );
    assert.isDefined(clFile, "content_list.json file should be present");
    const parsed = JSON.parse(new TextDecoder().decode(clFile!.data)) as Array<{
      page_idx: number;
    }>;
    // startPage 51 → offset = 50 (0-indexed)
    assert.equal(parsed[0].page_idx, 50);
    assert.equal(parsed[1].page_idx, 55);
  });
});
