import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
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
  const { t } = useTranslation();
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
            <h2 id="project-settings-title">{t(($) => $.settings.title)}</h2>
            <p title={project.root}>{project.root}</p>
          </div>
          <button
            type="button"
            className="settings-close"
            aria-label={t(($) => $.settings.close)}
            disabled={saving}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h3>{t(($) => $.settings.content)}</h3>
            <div className="settings-grid">
              <label className="settings-control settings-control-wide">
                <span>{t(($) => $.settings.contentDir)}</span>
                <input type="text" value={draft.source.contentDir} readOnly />
                <small>{t(($) => $.settings.contentDirHint)}</small>
              </label>
              <label className="settings-control settings-control-wide">
                <span>{t(($) => $.settings.extensions)}</span>
                <input
                  type="text"
                  value={draft.extensionsText}
                  placeholder={t(($) => $.settings.extensionsPlaceholder)}
                  disabled={saving}
                  onChange={(event) =>
                    setDraftValue("extensionsText", event.target.value)
                  }
                />
                <small>{t(($) => $.settings.extensionsHint)}</small>
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t(($) => $.settings.preview.title)}</h3>
            <div className="settings-grid">
              <label className="settings-control settings-control-wide">
                <span>{t(($) => $.settings.preview.command)}</span>
                <input
                  type="text"
                  value={draft.previewCommand}
                  placeholder={t(($) => $.settings.preview.commandPlaceholder)}
                  disabled={saving}
                  onChange={(event) =>
                    setDraftValue("previewCommand", event.target.value)
                  }
                />
                <small>{t(($) => $.settings.preview.commandHint)}</small>
              </label>
              <label className="settings-control settings-control-wide">
                <span>{t(($) => $.settings.preview.args)}</span>
                <textarea
                  rows={3}
                  value={draft.previewArgsText}
                  placeholder={t(($) => $.settings.preview.argsPlaceholder)}
                  disabled={saving}
                  onChange={(event) =>
                    setDraftValue("previewArgsText", event.target.value)
                  }
                />
                <small>{t(($) => $.settings.preview.argsHint)}</small>
              </label>
              <label className="settings-control">
                <span>{t(($) => $.settings.preview.host)}</span>
                <input type="text" value="127.0.0.1" readOnly />
                <small>{t(($) => $.settings.preview.hostHint)}</small>
              </label>
              <label className="settings-control">
                <span>{t(($) => $.settings.preview.port)}</span>
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
                <span>{t(($) => $.settings.preview.routeTemplate)}</span>
                <input
                  type="text"
                  value={draft.routeTemplate}
                  placeholder={t(($) => $.settings.preview.routeTemplatePlaceholder)}
                  disabled={saving}
                  onChange={(event) =>
                    setDraftValue("routeTemplate", event.target.value)
                  }
                />
                <small>
                  {t(($) => $.settings.preview.routeTemplateHint, {
                    slugToken: "{slug}",
                  })}
                </small>
              </label>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h3>{t(($) => $.settings.fields.title)}</h3>
                <p>{t(($) => $.settings.fields.hint)}</p>
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
                {t(($) => $.settings.fields.add)}
              </button>
            </div>

            <div className="settings-fields">
              {draft.fields.map((field, index) => (
                <div className="settings-field" key={index}>
                  <label className="settings-control">
                    <span>{t(($) => $.settings.fields.name)}</span>
                    <input
                      type="text"
                      value={field.name}
                      placeholder={t(($) => $.settings.fields.namePlaceholder)}
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
                    <span>{t(($) => $.settings.fields.type)}</span>
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
                        <option value={field.type}>
                          {t(($) => $.settings.fields.customType, { type: field.type })}
                        </option>
                      )}
                      <option value="string">{t(($) => $.settings.fields.string)}</option>
                      <option value="date">{t(($) => $.settings.fields.date)}</option>
                      <option value="boolean">{t(($) => $.settings.fields.boolean)}</option>
                      <option value="tags">{t(($) => $.settings.fields.tags)}</option>
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
                    {t(($) => $.common.required)}
                  </label>
                  <button
                    type="button"
                    className="settings-remove-field"
                    title={t(($) => $.settings.fields.remove, {
                      field: field.name || index + 1,
                    })}
                    aria-label={t(($) => $.settings.fields.remove, {
                      field: field.name || index + 1,
                    })}
                    disabled={saving}
                    onClick={() =>
                      setDraftValue(
                        "fields",
                        draft.fields.filter((_, fieldIndex) => fieldIndex !== index),
                      )
                    }
                  >
                    {t(($) => $.settings.fields.delete)}
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
                      {t(($) => $.settings.fields.defaultValue)}
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
                <p className="settings-empty-fields">{t(($) => $.settings.fields.empty)}</p>
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
              {t(($) => $.common.cancel)}
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? t(($) => $.common.saving) : t(($) => $.settings.save)}
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
          aria-label={defaultValueLabel(field)}
          value={field.default === true ? "true" : "false"}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === "true")}
        >
          <option value="false">
            {i18n.t(($) => $.settings.fields.booleanFalse)}
          </option>
          <option value="true">
            {i18n.t(($) => $.settings.fields.booleanTrue)}
          </option>
        </select>
      );
    case "tags":
      return (
        <input
          type="text"
          aria-label={defaultValueLabel(field)}
          value={
            Array.isArray(field.default)
              ? field.default.map(String).join(", ")
              : ""
          }
          placeholder={i18n.t(($) => $.settings.fields.tagsPlaceholder)}
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
          aria-label={defaultValueLabel(field)}
          value={typeof field.default === "string" ? field.default : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "string":
      return (
        <input
          type="text"
          aria-label={defaultValueLabel(field)}
          value={typeof field.default === "string" ? field.default : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    default:
      return (
        <input
          type="text"
          aria-label={defaultValueLabel(field)}
          value={JSON.stringify(field.default) ?? ""}
          title={i18n.t(($) => $.settings.fields.customDefaultHint)}
          readOnly
        />
      );
  }
}

function defaultValueLabel(field: FieldSpec): string {
  return i18n.t(($) => $.settings.fields.defaultValueLabel, {
    field: field.name || i18n.t(($) => $.common.field),
  });
}
