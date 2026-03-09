import { assert } from "chai";
import { createEditArticleMetadataTool } from "../src/agent/tools/write/editArticleMetadata";
import type { AgentToolContext } from "../src/agent/types";

describe("editArticleMetadata tool", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "fix the metadata",
      activeItemId: 42,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("creates an Apply/Cancel confirmation and applies edited JSON metadata", async function () {
    const calls: Array<Record<string, unknown>> = [];
    const fakeGateway = {
      resolveMetadataItem: () => ({ id: 42 }),
      getEditableArticleMetadata: () => ({
        itemId: 42,
        itemType: "journalArticle",
        title: "Original Paper",
        fields: {
          title: "Original Paper",
          shortTitle: "",
          abstractNote: "",
          publicationTitle: "",
          journalAbbreviation: "",
          proceedingsTitle: "",
          date: "",
          volume: "",
          issue: "",
          pages: "",
          DOI: "",
          url: "",
          language: "",
          extra: "",
          ISSN: "",
          ISBN: "",
          publisher: "",
          place: "",
        },
        creators: [],
      }),
      updateArticleMetadata: async (params: Record<string, unknown>) => {
        calls.push(params);
        return {
          status: "updated",
          itemId: 42,
          title: "Updated Paper",
          changedFields: ["title", "DOI"],
        };
      },
    };

    const tool = createEditArticleMetadataTool(fakeGateway as never);
    const validated = tool.validate({
      metadata: {
        title: "Original Paper",
        DOI: "10.1000/original",
      },
    });

    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const pending = tool.createPendingWriteAction?.(validated.value, baseContext);
    assert.exists(pending);
    assert.equal(pending?.toolName, "edit_article_metadata");
    assert.equal(pending?.confirmLabel, "Apply");
    assert.equal(pending?.cancelLabel, "Cancel");
    assert.equal(pending?.editorMode, "json");
    assert.include(pending?.editableContent || "", "\"DOI\": \"10.1000/original\"");

    const confirmed = tool.applyConfirmation?.(validated.value, {
      content: JSON.stringify(
        {
          title: "Updated Paper",
          DOI: "10.1000/updated",
        },
        null,
        2,
      ),
    }, baseContext);

    assert.isTrue(Boolean(confirmed?.ok));
    if (!confirmed?.ok) return;

    const result = await tool.execute(confirmed.value, baseContext);
    assert.deepEqual(result, {
      status: "updated",
      itemId: 42,
      title: "Updated Paper",
      changedFields: ["title", "DOI"],
    });
    assert.lengthOf(calls, 1);
    assert.deepEqual(calls[0]?.metadata, {
      title: "Updated Paper",
      DOI: "10.1000/updated",
    });
  });

  it("rejects invalid edited JSON", function () {
    const fakeGateway = {
      resolveMetadataItem: () => ({ id: 42 }),
      getEditableArticleMetadata: () => null,
      updateArticleMetadata: async () => ({ status: "updated" }),
    };
    const tool = createEditArticleMetadataTool(fakeGateway as never);
    const validated = tool.validate({
      metadata: {
        title: "Original Paper",
      },
    });

    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const confirmed = tool.applyConfirmation?.(
      validated.value,
      { content: "{not valid json}" },
      baseContext,
    );

    assert.isFalse(Boolean(confirmed?.ok));
    assert.include(confirmed && !confirmed.ok ? confirmed.error : "", "valid JSON");
  });

  it("accepts top-level metadata fields without a metadata wrapper", function () {
    const fakeGateway = {
      resolveMetadataItem: () => ({ id: 42 }),
      getEditableArticleMetadata: () => null,
      updateArticleMetadata: async () => ({ status: "updated" }),
    };
    const tool = createEditArticleMetadataTool(fakeGateway as never);
    const validated = tool.validate({
      title: "Updated title",
      DOI: "10.1000/top-level",
    });

    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    assert.deepEqual(validated.value.metadata, {
      title: "Updated title",
      DOI: "10.1000/top-level",
    });
  });

  it("accepts metadata from a changes object", function () {
    const fakeGateway = {
      resolveMetadataItem: () => ({ id: 42 }),
      getEditableArticleMetadata: () => null,
      updateArticleMetadata: async () => ({ status: "updated" }),
    };
    const tool = createEditArticleMetadataTool(fakeGateway as never);
    const validated = tool.validate({
      changes: {
        publicationTitle: "Neuron",
        date: "2020",
      },
    });

    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    assert.deepEqual(validated.value.metadata, {
      publicationTitle: "Neuron",
      date: "2020",
    });
  });
});
