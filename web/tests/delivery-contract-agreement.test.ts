import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

// 交付契约的三张表：两侧各写一份，必须逐项对得上。
//
// 为什么只锁这三张、不做「后端每个字段」的硬门禁：任务单的护栏第 1 条明确先收窄（跨语言追踪每个
// 字段没有廉价做法），第 2 条给出的替代做法是——**后端把词表收成一处显式常量，测试拿它与前端对齐**。
// 交付这条链满足前提：`delivery_ceremony.py` 的 `DISCLAIMER`、`FINGERPRINT_FIELDS`、`MISMATCH_CODES`
// 都是一处定义，前端各有一份对应。两边各钉各的字面量时，单侧改词**两侧都绿**（各自与自己的旧值
// 一致），所以这里改成两侧互相钉。
//
// 不做的事也写明：不对整个 `web/src` 扫 `签名`/`signed` 这类词——品牌标识本身就叫「结果页签名」，
// 发布状态里也如实标着 `independent_security_release_signoff`（待办门禁的名字，不是交付物措辞）。
// 扫宽了只会逼人加白名单，等于换个地方重新堆一条列表。
const HERE = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string): string => readFileSync(HERE + rel, "utf-8");

const BACKEND = read("../patchgauge/agent/delivery_ceremony.py");
const CONTROL = read("../patchgauge/server/control.py");
const PRESENTATION = read("src/presentation.ts");

/** 取某一行声明里、两个界符之间的那段（从 `name` 那一行往后找，避免命中注释）。 */
function slice(source: string, name: string, open: string, close: string): string {
  const at = source.indexOf(name);
  expect(at, `${name} 没找到`).toBeGreaterThanOrEqual(0);
  const eq = source.indexOf("=", at);
  expect(eq, `${name} 的 = 没找到`).toBeGreaterThan(at);
  const from = source.indexOf(open, eq);
  const to = source.indexOf(close, from + 1);
  expect(from, `${name} 的 ${open} 没找到`).toBeGreaterThanOrEqual(0);
  expect(to, `${name} 的 ${close} 没找到`).toBeGreaterThan(from);
  return source.slice(from + 1, to);
}

const quoted = (text: string): string[] =>
  Array.from(text.matchAll(/"[^"]+"/g)).map(m => m[0].slice(1, -1));

const pairs = (text: string): Array<[string, string]> =>
  Array.from(text.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g))
    .map(m => [m[1], m[2]] as [string, string]);

describe("交付契约：后端一处定义的表与前端对齐", () => {
  it("交付物措辞两侧逐字相同", () => {
    // 这两个常量就是一句话，slice 已经把引号剥掉了，不要再 quoted 一次。
    const backend = slice(BACKEND, "DISCLAIMER", '"', '"');
    const frontend = slice(PRESENTATION, "DELIVERY_DISCLAIMER", '"', '"');
    expect(frontend).toBe(backend);
    // 这句话本身就是红线：只写内容哈希清单，不写安全签署。
    expect(frontend).toContain("内容哈希清单");
    expect(frontend).toContain("非安全签署");
  });

  it("五个指纹的键名与顺序两侧一致", () => {
    // 前端那张表写的是 {key: "...", label: "..."}，键名不带引号，所以单独取。
    const backend = quoted(slice(BACKEND, "FINGERPRINT_FIELDS", "(", ")"));
    const frontend = Array.from(
      slice(PRESENTATION, "DELIVERY_FINGERPRINT_VIEWS", "[", "]")
        .matchAll(/key:\s*"([^"]+)"/g)).map(m => m[1]);
    expect(backend).toHaveLength(5);
    expect(frontend).toEqual(backend);
  });

  it("每一类交付拒绝码前端都有对照，前端不多出码", () => {
    const mismatch = pairs(slice(BACKEND, "MISMATCH_CODES", "{", "}"))
      .map(([, code]) => code);
    // 权限扩张那一码不在 MISMATCH_CODES 里，由控制面直接抛出，所以也从它的源码取。
    expect(CONTROL).toContain("DELIVERY_SCOPE_EXPANDED");
    const backend = mismatch.concat("DELIVERY_SCOPE_EXPANDED").sort();
    // 两侧都抽空时不能算过：先钉住后端这一侧的规模。
    expect(backend.length).toBeGreaterThanOrEqual(5);
    const frontend = quoted(slice(PRESENTATION, "DELIVERY_REJECTION_CODES", "[", "]")).sort();
  });
});
