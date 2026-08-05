import { describe, expect, it } from "vitest";
import errorCodeManifest from "../../shared/error-codes.json";
import { type AppErrorPayload, errorMessage, isAppError } from "./tauriApi";

function appError(overrides: Partial<AppErrorPayload> = {}): AppErrorPayload {
  return {
    code: "not_found",
    params: { id: "nested/post.md" },
    fallback: "fallback from Rust",
    ...overrides,
  };
}

describe("Tauri error protocol", () => {
  it("translates known codes with typed parameters", () => {
    expect(errorMessage(appError())).toBe("文章不存在：nested/post.md");
    expect(
      errorMessage(
        appError({
          code: "preview_port_in_use",
          params: { port: 4321 },
        }),
      ),
    ).toBe("预览端口 4321 已被占用，请停止占用进程或在项目设置中更换端口");
  });

  it("covers every code and parameter in the shared manifest", () => {
    for (const [code, paramNames] of Object.entries(errorCodeManifest)) {
      const fallback = `untranslated:${code}`;
      const params = Object.fromEntries(
        paramNames.map((name) => [name, `value:${name}`]),
      );
      expect(errorMessage({ code, params, fallback })).not.toBe(fallback);
    }
  });

  it("uses fallback for unknown codes or missing parameters", () => {
    expect(errorMessage(appError({ code: "future_error" }))).toBe(
      "fallback from Rust",
    );
    expect(errorMessage(appError({ params: {} }))).toBe("fallback from Rust");
  });

  it("accepts the previous code and message payload during upgrades", () => {
    const legacy = { code: "io", message: "legacy message" };
    expect(isAppError(legacy)).toBe(true);
    expect(errorMessage(legacy)).toBe("legacy message");
  });

  it("rejects malformed lookalikes", () => {
    expect(isAppError({ code: 1, fallback: "bad" })).toBe(false);
    expect(isAppError({ code: "io", fallback: 1 })).toBe(false);
    expect(isAppError({ code: "io", fallback: "bad" })).toBe(false);
  });
});
