import type { FieldSpec, ProjectConfig } from "../lib/tauriApi";

export interface ProjectSettingsDraft {
  /** 保存时以打开设置那一刻的完整配置为基底，保留本 UI 不认识的结构。 */
  source: ProjectConfig;
  extensionsText: string;
  previewCommand: string;
  previewArgsText: string;
  previewPortText: string;
  routeTemplate: string;
  fields: FieldSpec[];
}

export type ProjectConfigBuildResult =
  | { config: ProjectConfig; error: null }
  | { config: null; error: string };

export function createProjectSettingsDraft(
  config: ProjectConfig,
): ProjectSettingsDraft {
  const source = cloneProjectConfig(config);
  return {
    source,
    extensionsText: source.extensions.join(", "),
    previewCommand: source.preview.command,
    previewArgsText: source.preview.args.join("\n"),
    previewPortText: String(source.preview.port),
    routeTemplate: source.preview.routeTemplate ?? "",
    fields: source.frontmatter.fields.map(cloneField),
  };
}

/** 把表单草稿规范化为后端模型；返回的错误可以直接显示在设置弹窗里。 */
export function buildProjectConfig(
  draft: ProjectSettingsDraft,
  activePostId: string | null,
): ProjectConfigBuildResult {
  const rawExtensions = draft.extensionsText
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawExtensions.length === 0) {
    return invalid("至少保留一个文章扩展名");
  }

  const extensions = rawExtensions.map((extension) =>
    extension.startsWith(".") ? extension : `.${extension}`,
  );
  const extensionKeys = new Set<string>();
  for (const extension of extensions) {
    if (!/^\.[A-Za-z0-9_-]+$/.test(extension)) {
      return invalid(`扩展名格式不正确：${extension}`);
    }
    const key = extension.toLowerCase();
    if (extensionKeys.has(key)) {
      return invalid(`扩展名重复：${extension}`);
    }
    extensionKeys.add(key);
  }
  if (
    activePostId !== null &&
    !extensions.some((extension) => activePostId.endsWith(extension))
  ) {
    return invalid(`当前文章“${activePostId}”的扩展名必须继续保留`);
  }

  const command = draft.previewCommand.trim();
  if (command === "") {
    return invalid("预览命令不能为空");
  }
  if (
    command.startsWith("/") ||
    command.includes("\\") ||
    command.split("/").some((part) => part === "." || part === "..")
  ) {
    return invalid("预览命令必须是项目内的相对路径");
  }

  if (!/^\d+$/.test(draft.previewPortText.trim())) {
    return invalid("预览端口必须是 1–65535 的整数");
  }
  const port = Number(draft.previewPortText.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return invalid("预览端口必须是 1–65535 的整数");
  }

  const routeTemplate = draft.routeTemplate.trim();
  if (
    routeTemplate !== "" &&
    (!routeTemplate.startsWith("/") ||
      routeTemplate.startsWith("//") ||
      routeTemplate.includes("://") ||
      routeTemplate.includes("\\") ||
      hasControlCharacter(routeTemplate))
  ) {
    return invalid("路由模板必须是以单个 / 开头的站内路径");
  }

  const names = new Set<string>();
  const fields: FieldSpec[] = [];
  for (const field of draft.fields) {
    const name = field.name.trim();
    const type = field.type.trim();
    if (name === "" || hasControlCharacter(name)) {
      return invalid("Frontmatter 字段名不能为空或包含控制字符");
    }
    if (names.has(name)) {
      return invalid(`Frontmatter 字段名重复：${name}`);
    }
    names.add(name);
    if (type === "" || hasControlCharacter(type)) {
      return invalid(`Frontmatter 字段“${name}”的类型不能为空`);
    }
    if (!defaultMatchesType(field.default, type)) {
      return invalid(`Frontmatter 字段“${name}”的默认值与 ${type} 类型不匹配`);
    }

    const normalized: FieldSpec = { ...field, name, type };
    if (normalized.default === undefined || normalized.default === null) {
      delete normalized.default;
    } else {
      normalized.default = cloneJsonValue(normalized.default);
    }
    fields.push(normalized);
  }

  const args = draft.previewArgsText
    .split(/\r?\n/)
    .map((argument) => argument.trim())
    .filter(Boolean);
  if (args.some((argument) => argument.includes("\0"))) {
    return invalid("预览参数不能包含 NUL 字符");
  }

  return {
    config: {
      ...draft.source,
      extensions,
      frontmatter: {
        ...draft.source.frontmatter,
        fields,
      },
      preview: {
        ...draft.source.preview,
        command,
        args,
        host: "127.0.0.1",
        port,
        routeTemplate: routeTemplate === "" ? null : routeTemplate,
      },
    },
    error: null,
  };
}

export function defaultValueForFieldType(type: string): unknown {
  switch (type) {
    case "boolean":
      return false;
    case "tags":
      return [];
    default:
      return "";
  }
}

function defaultMatchesType(value: unknown, type: string): boolean {
  if (value === undefined || value === null) return true;
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "tags":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "date":
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function invalid(error: string): ProjectConfigBuildResult {
  return { config: null, error };
}

function cloneProjectConfig(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    extensions: [...config.extensions],
    frontmatter: {
      ...config.frontmatter,
      fields: config.frontmatter.fields.map(cloneField),
    },
    preview: {
      ...config.preview,
      args: [...config.preview.args],
    },
    assets: { ...config.assets },
  };
}

function cloneField(field: FieldSpec): FieldSpec {
  const cloned = { ...field };
  if (field.default !== undefined) {
    cloned.default = cloneJsonValue(field.default);
  }
  return cloned;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
    );
  }
  return value;
}
