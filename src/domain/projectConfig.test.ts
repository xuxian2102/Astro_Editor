import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../lib/tauriApi";
import {
  buildProjectConfig,
  createProjectSettingsDraft,
} from "./projectConfig";

function config(): ProjectConfig {
  return {
    version: 1,
    contentDir: "src/content/blog",
    extensions: [".md"],
    frontmatter: {
      fields: [
        { name: "title", type: "string", required: true },
        { name: "draft", type: "boolean", required: false, default: false },
      ],
    },
    preview: {
      command: "node_modules/.bin/astro",
      args: ["dev"],
      host: "127.0.0.1",
      port: 4321,
      routeTemplate: "/blog/{slug}",
    },
    assets: { mode: "colocated" },
  };
}

function expectConfig(
  result: ReturnType<typeof buildProjectConfig>,
): ProjectConfig {
  expect(result.error).toBeNull();
  if (result.config === null) throw new Error(result.error);
  return result.config;
}

describe("project settings config", () => {
  it("规范化扩展名、逐行参数、端口和空路由模板", () => {
    const draft = createProjectSettingsDraft(config());
    draft.extensionsText = "md, markdown";
    draft.previewCommand = "  node_modules/.bin/astro  ";
    draft.previewArgsText = "dev\n\n--verbose mode\n";
    draft.previewPortText = " 4567 ";
    draft.routeTemplate = "   ";

    const built = expectConfig(buildProjectConfig(draft, "article.md"));
    expect(built.extensions).toEqual([".md", ".markdown"]);
    expect(built.preview).toEqual({
      command: "node_modules/.bin/astro",
      args: ["dev", "--verbose mode"],
      host: "127.0.0.1",
      port: 4567,
      routeTemplate: null,
    });
  });

  it("编辑草稿不会修改当前 ProjectInfo 里的配置", () => {
    const source = config();
    const draft = createProjectSettingsDraft(source);
    draft.fields[0].name = "changed";
    draft.source.preview.args.push("--extra");

    expect(source.frontmatter.fields[0].name).toBe("title");
    expect(source.preview.args).toEqual(["dev"]);
  });

  it("不允许移除当前打开文章使用的扩展名", () => {
    const draft = createProjectSettingsDraft(config());
    draft.extensionsText = ".markdown";

    const result = buildProjectConfig(draft, "nested/current.md");
    expect(result.config).toBeNull();
    expect(result.error).toContain("当前文章");
  });

  it("拒绝重复扩展名、非法端口和外部路由", () => {
    const duplicate = createProjectSettingsDraft(config());
    duplicate.extensionsText = ".md, .MD";
    expect(buildProjectConfig(duplicate, null).error).toContain("重复");

    const badPort = createProjectSettingsDraft(config());
    badPort.previewPortText = "65536";
    expect(buildProjectConfig(badPort, null).error).toContain("1–65535");

    const externalRoute = createProjectSettingsDraft(config());
    externalRoute.routeTemplate = "https://example.com/blog/{slug}";
    expect(buildProjectConfig(externalRoute, null).error).toContain("站内路径");
  });

  it("规范化字段名并校验重复字段和默认值类型", () => {
    const draft = createProjectSettingsDraft(config());
    draft.fields[0].name = " title ";
    expect(
      expectConfig(buildProjectConfig(draft, null)).frontmatter.fields[0].name,
    ).toBe("title");

    const duplicate = createProjectSettingsDraft(config());
    duplicate.fields[1].name = "title";
    expect(buildProjectConfig(duplicate, null).error).toContain("字段名重复");

    const badDefault = createProjectSettingsDraft(config());
    badDefault.fields[1].default = "false";
    expect(buildProjectConfig(badDefault, null).error).toContain("默认值");
  });
});
