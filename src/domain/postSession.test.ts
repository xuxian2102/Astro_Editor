import { describe, expect, it } from "vitest";
import type { DraftDocument, PostDocument } from "../lib/tauriApi";
import {
  afterSave,
  createSaveSnapshot,
  draftMatchesDocument,
  editorSessionKey,
  isDirty,
  sessionFromDocument,
  sessionFromDraft,
} from "./postSession";

const document: PostDocument = {
  id: "hello.md",
  relativePath: "hello.md",
  rawFrontmatter: "title: Before\n",
  body: "before\n",
  revision: "revision-1",
};

describe("PostSession 保存合并", () => {
  it("没有后续编辑时清除 dirty，同时保留 editor epoch", () => {
    const opened = sessionFromDocument(document, 7);
    const edited = {
      ...opened,
      body: "saved\n",
      bodyDirty: true,
      editVersion: 1,
    };
    const snapshot = createSaveSnapshot(edited);
    const keyBeforeSave = editorSessionKey(edited);

    const merged = afterSave(edited, snapshot, "revision-2");

    expect(merged.body).toBe("saved\n");
    expect(merged.revision).toBe("revision-2");
    expect(merged.editorEpoch).toBe(7);
    expect(editorSessionKey(merged)).toBe(keyBeforeSave);
    expect(isDirty(merged)).toBe(false);
  });

  it("保存期间继续输入时保留新正文和 dirty，只推进磁盘 revision", () => {
    const opened = sessionFromDocument(document, 3);
    const saving = {
      ...opened,
      body: "first edit\n",
      bodyDirty: true,
      editVersion: 1,
    };
    const snapshot = createSaveSnapshot(saving);
    const current = {
      ...saving,
      body: "first edit plus typing\n",
      editVersion: 2,
    };

    const merged = afterSave(current, snapshot, "revision-2");

    expect(merged.body).toBe("first edit plus typing\n");
    expect(merged.bodyDirty).toBe(true);
    expect(merged.revision).toBe("revision-2");
  });

  it("保存期间继续编辑 frontmatter 时不共享旧 YAML 对象，也不误清 dirty", () => {
    const opened = sessionFromDocument(document, 1);
    if (!opened.fmDoc) throw new Error("fixture must contain frontmatter");
    const firstFm = opened.fmDoc.clone();
    firstFm.set("title", "First");
    const saving = {
      ...opened,
      fmDoc: firstFm,
      fmDirty: true,
      editVersion: 1,
    };
    const snapshot = createSaveSnapshot(saving);

    const currentFm = saving.fmDoc.clone();
    currentFm.set("title", "Second");
    const current = { ...saving, fmDoc: currentFm, editVersion: 2 };
    const merged = afterSave(current, snapshot, "revision-2");

    expect(snapshot.rawFrontmatter).toContain("First");
    expect(snapshot.rawFrontmatter).not.toContain("Second");
    expect(merged.fmDoc?.getString("title")).toBe("Second");
    expect(merged.fmDirty).toBe(true);
    expect(merged.rawFrontmatter).toBe(snapshot.rawFrontmatter);
  });
});

describe("PostSession 草稿恢复", () => {
  const draft: DraftDocument = {
    postId: document.id,
    rawFrontmatter: "title: Recovered\n",
    body: "recovered body\n",
    baseRevision: document.revision,
    savedAtMs: 123,
  };

  it("按最新磁盘 revision 恢复，并把差异保持为 dirty", () => {
    const restored = sessionFromDraft(document, draft, 9, 4);

    expect(restored.body).toBe("recovered body\n");
    expect(restored.fmDoc?.getString("title")).toBe("Recovered");
    expect(restored.revision).toBe(document.revision);
    expect(restored.editorEpoch).toBe(9);
    expect(restored.projectGeneration).toBe(4);
    expect(isDirty(restored)).toBe(true);
  });

  it("识别与磁盘完全相同的过期草稿", () => {
    expect(
      draftMatchesDocument(
        {
          ...draft,
          rawFrontmatter: document.rawFrontmatter,
          body: document.body,
        },
        document,
      ),
    ).toBe(true);
    expect(draftMatchesDocument(draft, document)).toBe(false);
  });

  it("能恢复并保存删除 frontmatter 的草稿", () => {
    const withoutFrontmatter = sessionFromDraft(
      document,
      { ...draft, rawFrontmatter: null, body: document.body },
      1,
      1,
    );

    expect(withoutFrontmatter.fmDoc).toBeNull();
    expect(withoutFrontmatter.fmDirty).toBe(true);
    expect(createSaveSnapshot(withoutFrontmatter).rawFrontmatter).toBeNull();
  });
});
