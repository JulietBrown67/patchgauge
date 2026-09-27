/* 这个仓库没有装 @testing-library/react，也没有 jsdom/happy-dom 环境
   （见 web/package.json 与 vite.config.ts：vitest 跑在默认的 node 环境）。
   按约定不为测试改动构建配置，所以这里只测 RepoCombobox.tsx 里导出的纯函数；
   真正的渲染与交互留给 web/e2e 覆盖。 */

import { describe, expect, it } from "vitest";
import {
  REPO_COMBOBOX_EMPTY, REPO_COMBOBOX_PLACEHOLDER, TYPEAHEAD_WINDOW_MS,
  comboKeyIntent, isTypeaheadChar, nextHighlight, repoListDomId, repoOptionDomId,
  triggerView, typeaheadMatch, typeaheadPrefix,
  type RepoOption,
} from "./RepoCombobox";

const OPTIONS: RepoOption[] = [
  {repo_id: "r1", display_name: "水木验码", technical_name: "shuimu-yanma"},
  {repo_id: "r2", display_name: "退避重试演示", technical_name: "demo-backoff"},
  {repo_id: "r3", display_name: "demo-alpha"},
  {repo_id: "r4", display_name: "Demo-beta", technical_name: "demo-beta-slug"},
];

describe("高亮下标推进", () => {
  it("上下方向环绕，Home/End 跳首尾", () => {
    expect(nextHighlight(0, 4, "down")).toBe(1);
    expect(nextHighlight(3, 4, "down")).toBe(0);
    expect(nextHighlight(0, 4, "up")).toBe(3);
    expect(nextHighlight(2, 4, "up")).toBe(1);
    expect(nextHighlight(2, 4, "home")).toBe(0);
    expect(nextHighlight(2, 4, "end")).toBe(3);
  });

  it("没有高亮时向下去首项、向上去末项", () => {
    expect(nextHighlight(-1, 4, "down")).toBe(0);
    expect(nextHighlight(-1, 4, "up")).toBe(3);
  });

  it("越界的 current 当作没有高亮，空列表恒为 -1", () => {
    expect(nextHighlight(99, 4, "down")).toBe(0);
    expect(nextHighlight(0, 0, "down")).toBe(-1);
    expect(nextHighlight(0, 0, "home")).toBe(-1);
    expect(nextHighlight(2, 1, "up")).toBe(0);
  });
});

describe("键盘意图", () => {
  it("收起时方向键/Enter/Space 只负责展开并高亮当前项", () => {
    expect(comboKeyIntent("ArrowDown", false)).toEqual({kind: "open", move: null});
    expect(comboKeyIntent("ArrowUp", false)).toEqual({kind: "open", move: null});
    expect(comboKeyIntent("Enter", false)).toEqual({kind: "open", move: null});
    expect(comboKeyIntent(" ", false)).toEqual({kind: "open", move: null});
    expect(comboKeyIntent("Home", false)).toEqual({kind: "open", move: "home"});
    expect(comboKeyIntent("End", false)).toEqual({kind: "open", move: "end"});
  });

  it("展开时方向键移动高亮、Home/End 跳首尾", () => {
    expect(comboKeyIntent("ArrowDown", true)).toEqual({kind: "move", move: "down"});
    expect(comboKeyIntent("ArrowUp", true)).toEqual({kind: "move", move: "up"});
    expect(comboKeyIntent("Home", true)).toEqual({kind: "move", move: "home"});
    expect(comboKeyIntent("End", true)).toEqual({kind: "move", move: "end"});
  });

  it("Enter/Space 选中，Escape 收起还焦点，Tab 只收起", () => {
    expect(comboKeyIntent("Enter", true)).toEqual({kind: "commit"});
    expect(comboKeyIntent(" ", true)).toEqual({kind: "commit"});
    expect(comboKeyIntent("Escape", true)).toEqual({kind: "dismiss"});
    expect(comboKeyIntent("Tab", true)).toEqual({kind: "close"});
  });

  it("收起状态下 Escape / Tab 不做任何事，不抢走宿主页面的 Escape", () => {
    expect(comboKeyIntent("Escape", false)).toEqual({kind: "none"});
    expect(comboKeyIntent("Tab", false)).toEqual({kind: "none"});
  });

  it("可打印字符走连打；空格在展开时是选中而不是连打", () => {
    expect(comboKeyIntent("d", true)).toEqual({kind: "typeahead", char: "d"});
    expect(comboKeyIntent("水", false)).toEqual({kind: "typeahead", char: "水"});
    expect(comboKeyIntent(" ", true)).toEqual({kind: "commit"});
    expect(isTypeaheadChar("d")).toBe(true);
    expect(isTypeaheadChar("水")).toBe(true);
    expect(isTypeaheadChar(" ")).toBe(false);
    expect(isTypeaheadChar("ArrowDown")).toBe(false);
  });

  it("带 ctrl/cmd/alt 的按键一律放行给浏览器", () => {
    expect(comboKeyIntent("ArrowDown", true, true)).toEqual({kind: "none"});
    expect(comboKeyIntent("d", true, true)).toEqual({kind: "none"});
    expect(comboKeyIntent("Enter", false, true)).toEqual({kind: "none"});
  });
});

describe("连打前缀合并", () => {
  it("500ms 内的连续按键并成一个前缀", () => {
    expect(typeaheadPrefix("", 0, "d", 1000)).toBe("d");
    expect(typeaheadPrefix("d", 1000, "e", 1200)).toBe("de");
    expect(typeaheadPrefix("de", 1200, "m", 1700)).toBe("dem");
  });

  it("超过 500ms 就重新开始", () => {
    expect(typeaheadPrefix("de", 1000, "m", 1000 + TYPEAHEAD_WINDOW_MS + 1)).toBe("m");
    expect(typeaheadPrefix("de", 1000, "m", 9000)).toBe("m");
  });

  it("窗口边界上（正好 500ms）仍然合并", () => {
    expect(typeaheadPrefix("d", 1000, "e", 1500)).toBe("de");
  });
});

describe("连打匹配", () => {
  it("按 display_name 前缀匹配，大小写不敏感", () => {
    expect(typeaheadMatch(OPTIONS, "demo")).toBe(2);
    expect(typeaheadMatch(OPTIONS, "DEMO")).toBe(2);
    expect(typeaheadMatch(OPTIONS, "水")).toBe(0);
    expect(typeaheadMatch(OPTIONS, "退避")).toBe(1);
  });

  it("从 startIndex 开始环形查找，同前缀的项能轮着走", () => {
    expect(typeaheadMatch(OPTIONS, "d", 3)).toBe(3);
    expect(typeaheadMatch(OPTIONS, "d", 0)).toBe(2);
    // 从最后一项之后绕回开头
    expect(typeaheadMatch(OPTIONS, "水", 2)).toBe(0);
  });

  it("只看 display_name，不拿 technical_name 顶替", () => {
    // r1 的 technical_name 是 shuimu-yanma，但 "shuimu" 不该命中它
    expect(typeaheadMatch(OPTIONS, "shuimu")).toBe(-1);
    // r2 的 technical_name 是 demo-backoff，"demo" 命中的是 display_name 为 demo-alpha 的 r3
    expect(typeaheadMatch(OPTIONS, "demo")).toBe(2);
  });

  it("匹配不到返回 -1，空前缀/空列表也返回 -1", () => {
    expect(typeaheadMatch(OPTIONS, "zzz")).toBe(-1);
    expect(typeaheadMatch(OPTIONS, "")).toBe(-1);
    expect(typeaheadMatch([], "d")).toBe(-1);
    expect(typeaheadMatch(OPTIONS, "d", 99)).toBe(2); // 越界的 startIndex 归零
  });
});

describe("触发器显示什么", () => {
  it("命中时给出两行；没有 technical_name 就不给第二行", () => {
    expect(triggerView("r1", OPTIONS))
      .toEqual({label: "水木验码", technical: "shuimu-yanma", empty: false, placeholder: false});
    const noTech = triggerView("r3", OPTIONS);
    expect(noTech.label).toBe("demo-alpha");
    expect(noTech.technical).toBeUndefined();
  });

  it("列表为空时显示「暂无已授权仓库」并要求 disabled", () => {
    expect(triggerView("r1", [])).toEqual({
      label: REPO_COMBOBOX_EMPTY, empty: true, placeholder: true,
    });
    expect(REPO_COMBOBOX_EMPTY).toBe("暂无已授权仓库");
  });

  it("value 不在 options 里时显示 value 本身，不静默塌成第一项", () => {
    const stray = triggerView("r-missing", OPTIONS);
    expect(stray.label).toBe("r-missing");
    expect(stray.label).not.toBe(OPTIONS[0].display_name);
    expect(stray.empty).toBe(false);
    expect(stray.technical).toBeUndefined();
  });

  it("还没选（value 为空串）时给占位文案而不是空白", () => {
    const blank = triggerView("", OPTIONS);
    expect(blank.label).toBe(REPO_COMBOBOX_PLACEHOLDER);
    expect(blank.label).not.toBe("");
    expect(blank.placeholder).toBe(true);
  });
});

describe("DOM id 约定", () => {
  it("aria-controls / aria-activedescendant 的目标 id 是稳定可推算的", () => {
    expect(repoListDomId("repo")).toBe("repo-listbox");
    expect(repoOptionDomId("repo", 0)).toBe("repo-option-0");
    expect(repoOptionDomId("repo", 3)).toBe("repo-option-3");
  });
});
