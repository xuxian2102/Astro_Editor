import { useState, type FormEvent } from "react";
import {
  buildProjectConfig,
  createProjectSettingsDraft,
  defaultValueForFieldType,
  type ProjectSettingsDraft,
} from "../domain/projectConfig";
import type { FieldSpec, ProjectConfig, ProjectInfo } from "../lib/tauriApi";

const FIELD_TYPES = ["string", "date", "boolean", "tags"] as const;

interface ProjectSettingsDialogProps {
  project: ProjectInfo;
  activePostId: string | null;
  saving: boolean;
  serverError: string | null;
  onClose: () => void;
  onSave: (config: ProjectConfig) => void;
}

export default function ProjectSettingsDialog({
  project,
  activePostId,
  saving,
  serverError,
  onClose,
  onSave,
}: ProjectSettingsDialogProps) {
  const [draft, setDraft] = useState<ProjectSettingsDraft>(() =>
    createProjectSettingsDraft(project.config),
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const setDraftValue = <Key extends keyof ProjectSettingsDraft>(
    key: Key,
    value: ProjectSettingsDraft[Key],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidationError(null);
  };

  const updateField = (
    index: number,
    update: (field: FieldSpec) => FieldSpec,
  ) => {
    setDraft((current) => ({
      ...current,
      fields: current.fields.map((field, fieldIndex) =>
        fieldIndex === index ? update(field) : field,
      ),
    }));
    setValidationError(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = buildProjectConfig(draft, activePostId);
    if (result.config === null) {
      setValidationError(result.error);
      return;
    }
    setValidationError(null);
    onSave(result.config);
  };

  return (
    <div className="modal-overlay settings-overlay">
      <form
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        onSubmit={submit}
      >
        <header className="settings-header">
          <div>
            <h2 id="project-settings-title">项目设置</h2>
            <p title={project.root}>{project.root}</p>
          </div>
          <button
            type="button"
            className="settings-close"
            aria-label="关闭项目设置"
            disabled={saving}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h3>内容</h3>
            <div className="settings-grid">
              <label className="settings-control settings-control-wide">
                <span>内容目录</span>
                <input type="text" value={draft.source.contentDir} readOnly />
                <small>目录迁移会同时影响文章和图片，第一版只读。</small>
              </label>
              <label className="settings-control settings-control-wide">
                <span>文章扩展名</span>
                <input
                  type="text"
                  value={draft.extensionsText}
                  placeholder=".md, .markdown"
                  disabled={saving}
                  onChange={(event) =>
                    setDraftValue("extensionsText", event.target.value)
                  }
                />
                <small>用逗号或空格分隔；当前打开文章的扩展名必须保留。</small>
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h3>Astro 预览</h3>
            <div className="settings-grid">
              <label className="settings-control settings-control-wide">
                <span>命令</span>
                <input
                  type="text"
                  value={draft.previewCommand}
                  placeholder="node_modules/.bin/astro"
                  disabled={saving}
                  onChange={(event) =>
                    setDraftValue("previewCommand", event.target.value)
                  }
                />
                <small>必须是项目内可执行文件的相对路径。</small>
              </label>
              <label className="settings-control settings-control-wide">
                <span>参数（每行一个）</span>
                <textarea
                  rows={3}
                  value={draft.previewArgsText}
                  placeholder={"dev\n--verbose"}
                  disabled={saving}
                  onChange={(event) =>
                    setDraftValue("previewArgsText", event.target.value)
                  }
                />
                <small>host 和 port 会由编辑器安全地追加，不需要写在这里。</small>
              </label>
              <label className="settings-control">
                <span>监听地址</span>
                <input type="text" value="127.0.0.1" readOnly />
                <small>固定为本机，避免开发服务器暴露到局域网。</small>
              </label>
              <label className="settings-control">
                <span>端口</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  inputMode="numeric"
                  value={draft.previewPortText}
                  disabled={saving}
                  onChange={(event) =>
                    setDraftValue("previewPortText", event.target.value)
                  }
                />
              </label>
              <label className="settings-control settings-control-wide">
                <span>文章路由模板</span>
                <input
                  type="text"
                  value={draft.routeTemplate}
                  placeholder="/blog/{slug}"
                  disabled={saving}
                  onChange={(event) =>
                    setDraftValue("routeTemplate", event.target.value)
                  }
                />
                <small>
                  使用 {"{slug}"} 代入文章 slug；留空时预览按钮只打开首页。
                </small>
              </label>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h3>Frontmatter 字段</h3>
                <p>决定右侧属性面板和新建文章的初始字段，不会删除文章里的其他字段。</p>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  setDraftValue("fields", [
                    ...draft.fields,
                    { name: "", type: "string", required: false },
                  ])
                }
              >
                添加字段
              </button>
            </div>

            <div className="settings-fields">
              {draft.fields.map((field, index) => (
                <div className="settings-field" key={index}>
                  <label className="settings-control">
                    <span>字段名</span>
                    <input
                      type="text"
                      value={field.name}
                      placeholder="title"
                      disabled={saving}
                      onChange={(event) =>
                        updateField(index, (current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="settings-control">
                    <span>类型</span>
                    <select
                      value={field.type}
                      disabled={saving}
                      onChange={(event) => {
                        const type = event.target.value;
                        updateField(index, (current) => ({
                          ...current,
                          type,
                          ...(hasDefault(current)
                            ? { default: defaultValueForFieldType(type) }
                            : {}),
                        }));
                      }}
                    >
                      {!isKnownFieldType(field.type) && (
                        <option value={field.type}>{field.type}（自定义）</option>
                      )}
                      <option value="string">文本</option>
                      <option value="date">日期</option>
                      <option value="boolean">开关</option>
                      <option value="tags">标签列表</option>
                    </select>
                  </label>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={field.required}
                      disabled={saving}
                      onChange={(event) =>
                        updateField(index, (current) => ({
                          ...current,
                          required: event.target.checked,
                        }))
                      }
                    />
                    必填
                  </label>
                  <button
                    type="button"
                    className="settings-remove-field"
                    title={`移除字段 ${field.name || index + 1}`}
                    aria-label={`移除字段 ${field.name || index + 1}`}
                    disabled={saving}
                    onClick={() =>
                      setDraftValue(
                        "fields",
                        draft.fields.filter((_, fieldIndex) => fieldIndex !== index),
                      )
                    }
                  >
                    删除
                  </button>

                  <div className="settings-default">
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={hasDefault(field)}
                        disabled={saving}
                        onChange={(event) =>
                          updateField(index, (current) => {
                            const next = { ...current };
                            if (event.target.checked) {
                              next.default = defaultValueForFieldType(current.type);
                            } else {
                              delete next.default;
                            }
                            return next;
                          })
                        }
                      />
                      默认值
                    </label>
                    {hasDefault(field) &&
                      renderDefaultControl(field, saving, (value) =>
                        updateField(index, (current) => ({
                          ...current,
                          default: value,
                        })),
                      )}
                  </div>
                </div>
              ))}
              {draft.fields.length === 0 && (
                <p className="settings-empty-fields">尚未配置字段。</p>
              )}
            </div>
          </section>
        </div>

        <footer className="settings-footer">
          {(validationError || serverError) && (
            <p className="settings-error" role="alert">
              {validationError ?? serverError}
            </p>
          )}
          <div className="settings-actions">
            <button type="button" disabled={saving} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "保存中…" : "保存设置"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function hasDefault(field: FieldSpec): boolean {
  return field.default !== undefined && field.default !== null;
}

function isKnownFieldType(type: string): boolean {
  return FIELD_TYPES.some((candidate) => candidate === type);
}

function renderDefaultControl(
  field: FieldSpec,
  disabled: boolean,
  onChange: (value: unknown) => void,
) {
  switch (field.type) {
    case "boolean":
      return (
        <select
          aria-label={`${field.name || "字段"}的默认值`}
          value={field.default === true ? "true" : "false"}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === "true")}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      );
    case "tags":
      return (
        <input
          type="text"
          aria-label={`${field.name || "字段"}的默认值`}
          value={
            Array.isArray(field.default)
              ? field.default.map(String).join(", ")
              : ""
          }
          placeholder="astro, tutorial"
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.value
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            )
          }
        />
      );
    case "date":
      return (
        <input
          type="date"
          aria-label={`${field.name || "字段"}的默认值`}
          value={typeof field.default === "string" ? field.default : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "string":
      return (
        <input
          type="text"
          aria-label={`${field.name || "字段"}的默认值`}
          value={typeof field.default === "string" ? field.default : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    default:
      return (
        <input
          type="text"
          aria-label={`${field.name || "字段"}的默认值`}
          value={JSON.stringify(field.default) ?? ""}
          title="自定义类型的默认值请直接在 .blog-editor.json 中维护"
          readOnly
        />
      );
  }
}
