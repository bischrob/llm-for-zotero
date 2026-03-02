import { assert } from "chai";
import {
  extractStandalonePaperSourceLabel,
  formatSourceLabelWithPage,
  matchAssistantCitationCandidates,
} from "../src/modules/contextPanel/assistantCitationLinks";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

describe("assistantCitationLinks", function () {
  it("extracts a standalone paper source label from a citation line", function () {
    const extracted = extractStandalonePaperSourceLabel(
      " (Smith et al., 2024) ",
    );

    assert.deepInclude(extracted, {
      sourceLabel: "(Smith et al., 2024)",
      citationLabel: "Smith et al., 2024",
    });
  });

  it("rejects non-standalone citation lines", function () {
    assert.isNull(
      extractStandalonePaperSourceLabel(
        "According to (Smith et al., 2024), the effect was strong.",
      ),
    );
  });

  it("matches citation lines to the corresponding paper context", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Alice Smith",
        year: "2024",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Brian Lee",
        year: "2025",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(Lee et al., 2025)",
      papers,
    );

    assert.lengthOf(matches, 1);
    assert.equal(matches[0].contextItemId, 22);
    assert.equal(matches[0].paperContext.title, "Paper B");
  });

  it("preserves ambiguous matches when two papers share the same citation label", function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Paper A",
        firstCreator: "Alice Smith",
        year: "2024",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Paper B",
        firstCreator: "Aaron Smith",
        year: "2024",
      },
    ];

    const matches = matchAssistantCitationCandidates(
      "(Smith et al., 2024)",
      papers,
    );

    assert.lengthOf(matches, 2);
    assert.sameMembers(
      matches.map((entry) => entry.contextItemId),
      [11, 22],
    );
  });
});

describe("formatSourceLabelWithPage", function () {
  it("appends page number to a standard citation label", function () {
    assert.equal(
      formatSourceLabelWithPage("(Smith et al., 2024)", "5"),
      "(Smith et al., 2024, page 5)",
    );
  });

  it("handles single-digit page numbers", function () {
    assert.equal(
      formatSourceLabelWithPage("(Lee et al., 2025)", "1"),
      "(Lee et al., 2025, page 1)",
    );
  });

  it("handles multi-digit page numbers", function () {
    assert.equal(
      formatSourceLabelWithPage("(Wang et al., 2023)", "142"),
      "(Wang et al., 2023, page 142)",
    );
  });

  it("returns original label when pageLabel is empty", function () {
    assert.equal(
      formatSourceLabelWithPage("(Smith et al., 2024)", ""),
      "(Smith et al., 2024)",
    );
  });

  it("returns original label when format is not parenthesized", function () {
    assert.equal(
      formatSourceLabelWithPage("Smith et al., 2024", "5"),
      "Smith et al., 2024",
    );
  });

  it("handles fallback Paper labels", function () {
    assert.equal(
      formatSourceLabelWithPage("(Paper 42)", "3"),
      "(Paper 42, page 3)",
    );
  });

  it("handles citation without year", function () {
    assert.equal(
      formatSourceLabelWithPage("(Smith et al.)", "7"),
      "(Smith et al., page 7)",
    );
  });

  it("handles Paper-only fallback label", function () {
    assert.equal(
      formatSourceLabelWithPage("(Paper)", "10"),
      "(Paper, page 10)",
    );
  });
});
