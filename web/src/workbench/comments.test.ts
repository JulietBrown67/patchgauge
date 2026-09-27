import {describe, expect, it} from "vitest";
import {
  COMMENT_KIND_LABELS, COMMENT_STATUS_LABELS, COMMENT_TOOLBAR_KINDS,
  anchorCoversLine, anchorPreview, groupThreads, markForLine,
  validateCommentText,
  type CommentKind, type CommentRecord, type CommentStatus,
} from "./comments";

function record(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    comment_id: "cmt-000001", review_id: "r1", author: "王工",
    body: "这条测试真的约束了这一行吗？", kind: "challenge",
    claim_id: "claim-1", evidence_ids: ["claim-1"],
    anchor: {source_snapshot_sha256: "s", target_commit: "c",
      path: "pkg/core.py", side: "base", start_line: 9, end_line: 9,
      blob_sha256: "b", context_sha256: "x"},
    parent_comment_id: null, supersedes_comment_id: null,
    status: "open", created_at: "2026-09-13T10:00:00Z",
    updated_at: "2026-09-13T10:00:00Z", revision: 1,
    ...overrides,
  };
}

describe("comment labels", () => {
  it("maps every kind and status to Chinese labels", () => {
    const kinds = Object.keys(COMMENT_KIND_LABELS) as CommentKind[];
    expect(kinds.sort()).toEqual(["challenge", "change_request",
      "evidence_request", "note", "question"]);
    for (const kind of kinds) {
      expect(COMMENT_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
    const statuses = Object.keys(COMMENT_STATUS_LABELS) as CommentStatus[];
    expect(statuses.sort()).toEqual(["open", "outdated", "resolved",
      "withdrawn"]);
  });

  it("keeps the toolbar to the four entry points from the plan", () => {
    expect(COMMENT_TOOLBAR_KINDS).toEqual(["note", "challenge",
      "evidence_request", "change_request"]);
  });
});

describe("anchorCoversLine", () => {
  it("covers every line inside a multiline range", () => {
    const anchor = {path: "pkg/core.py", start_line: 3, end_line: 5};
    expect(anchorCoversLine(anchor, "pkg/core.py", 3)).toBe(true);
    expect(anchorCoversLine(anchor, "pkg/core.py", 4)).toBe(true);
    expect(anchorCoversLine(anchor, "pkg/core.py", 5)).toBe(true);
    expect(anchorCoversLine(anchor, "pkg/core.py", 2)).toBe(false);
    expect(anchorCoversLine(anchor, "pkg/core.py", 6)).toBe(false);
    expect(anchorCoversLine(anchor, "pkg/util.py", 4)).toBe(false);
    expect(anchorCoversLine(undefined, "pkg/core.py", 4)).toBe(false);
  });
});

describe("markForLine", () => {
  const base = record();
  it("uses a solid mark while open or resolved comments survive", () => {
    expect(markForLine([base], "pkg/core.py", 9)).toBe("comment");
    expect(markForLine([{...base, status: "resolved"}], "pkg/core.py", 9))
      .toBe("comment");
  });

  it("falls back to a hollow mark once every comment is dead", () => {
    expect(markForLine([{...base, status: "withdrawn"}],
      "pkg/core.py", 9)).toBe("hollow");
    expect(markForLine([{...base, status: "outdated"}],
      "pkg/core.py", 9)).toBe("hollow");
    expect(markForLine([], "pkg/core.py", 9)).toBe(null);
  });
});

describe("groupThreads", () => {
  it("sorts roots by anchor and nests replies under their root", () => {
    const reply = record({comment_id: "cmt-000010",
      parent_comment_id: "cmt-000002", body: "复跑确认了。",
      kind: "note", anchor: {...record().anchor, start_line: 20,
        end_line: 20}});
    const threads = groupThreads([reply,
      record({comment_id: "cmt-000002", anchor: {...record().anchor,
        start_line: 20, end_line: 21}}),
      record({comment_id: "cmt-000003", anchor: {...record().anchor,
        start_line: 4, end_line: 4}})]);
    expect(threads.map(thread => thread.root.comment_id))
      .toEqual(["cmt-000003", "cmt-000002"]);
    expect(threads[1].replies.map(item => item.comment_id))
      .toEqual(["cmt-000010"]);
    expect(threads[0].replies).toEqual([]);
  });

  it("keeps orphan replies as roots instead of dropping them", () => {
    const orphan = record({comment_id: "cmt-000009",
      parent_comment_id: "cmt-000404"});
    const threads = groupThreads([orphan]);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.comment_id).toBe("cmt-000009");
  });
});

describe("anchorPreview", () => {
  it("renders single lines and ranges differently", () => {
    expect(anchorPreview({path: "pkg/core.py", start_line: 9,
      end_line: 9})).toBe("pkg/core.py:9");
    expect(anchorPreview({path: "pkg/core.py", start_line: 9,
      end_line: 12})).toBe("pkg/core.py:9-12");
    expect(anchorPreview(undefined)).toBe("");
  });
});

describe("validateCommentText", () => {
  it("accepts a normal comment and trims whitespace", () => {
    expect(validateCommentText("  王工 ", "  复跑确认。 "))
      .toEqual({});
  });

  it("rejects empty and oversized authors", () => {
    expect(validateCommentText("   ", "正文").author).toBeTruthy();
    expect(validateCommentText("署".repeat(101), "正文").author)
      .toBeTruthy();
  });

  it("rejects empty, oversized and control-character bodies", () => {
    expect(validateCommentText("王工", "   ").body).toBeTruthy();
    expect(validateCommentText("王工", "字".repeat(2001)).body)
      .toBeTruthy();
    expect(validateCommentText("王工", "带\u0007控制符").body)
      .toBeTruthy();
  });
});
