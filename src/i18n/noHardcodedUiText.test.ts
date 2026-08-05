import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

const CJK_TEXT = /\p{Script=Han}/u;
const sourceFiles = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("UI text catalog", () => {
  it("keeps Chinese UI copy out of implementation files", () => {
    const violations = Object.entries(sourceFiles)
      .filter(([path]) => !isExcluded(path))
      .flatMap(([path, source]) => findHardcodedText(path, source));

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("ignores comments and detects strings, templates, and JSX text", () => {
    const source = [
      "// 中文注释",
      "/** 另一段中文注释 */",
      'const label = "界面文字";',
      "const message = `操作 ${name} 完成`;",
      "const element = <p>按钮文字</p>;",
      "const pattern = /[?#]/;",
    ].join("\n");

    const violations = findHardcodedText("fixture.tsx", source);
    expect(violations).toHaveLength(4);
    expect(violations.join("\n")).not.toContain("注释");
  });
});

function isExcluded(path: string): boolean {
  return (
    path.endsWith("/zh-CN.ts") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

function findHardcodedText(path: string, source: string): string[] {
  const scanner = createScanner(true, LanguageVariant.JSX, source);
  const violations: string[] = [];
  const templateBraceDepths: number[] = [];

  const recordToken = () => {
    const text = scanner.getTokenText();
    if (CJK_TEXT.test(text)) {
      const { line, column } = lineAndColumn(source, scanner.getTokenStart());
      const preview = text.trim().replace(/\s+/g, " ").slice(0, 80);
      violations.push(`${path}:${line}:${column} ${preview}`);
    }
  };

  let token = scanner.scan();
  while (token !== SyntaxKind.EndOfFile) {
    recordToken();
    if (token === SyntaxKind.TemplateHead) {
      templateBraceDepths.push(0);
    } else if (templateBraceDepths.length > 0) {
      const last = templateBraceDepths.length - 1;
      if (token === SyntaxKind.OpenBraceToken) {
        templateBraceDepths[last] += 1;
      } else if (token === SyntaxKind.CloseBraceToken) {
        if (templateBraceDepths[last] > 0) {
          templateBraceDepths[last] -= 1;
        } else {
          token = scanner.reScanTemplateToken(false);
          recordToken();
          if (token === SyntaxKind.TemplateTail) templateBraceDepths.pop();
        }
      }
    }
    if (scanner.getTokenEnd() <= scanner.getTokenStart()) {
      scanner.resetTokenState(scanner.getTokenStart() + 1);
    }
    token = scanner.scan();
  }
  return violations;
}

function lineAndColumn(source: string, position: number) {
  const before = source.slice(0, position);
  const line = before.split("\n").length;
  const lastLineBreak = before.lastIndexOf("\n");
  return { line, column: position - lastLineBreak };
}
