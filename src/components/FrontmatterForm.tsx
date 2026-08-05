import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { FrontmatterDocument } from "../domain/frontmatterDocument";
import type { PostSession } from "../domain/postSession";
import type { FieldSpec } from "../lib/tauriApi";
import TagEditor from "./TagEditor";

interface FrontmatterFormProps {
  fields: FieldSpec[];
  session: PostSession;
  /** 对 fmDoc 施加一次修改并把 session 标记为 fmDirty */
  onEdit: (mutate: (fm: FrontmatterDocument) => void) => void;
  onAddFrontmatter: () => void;
  /** 按字段名分组的标签候选（同一项目可能有多个 type:"tags" 字段，各自的候选不混） */
  tagSuggestions: Record<string, string[]>;
}

export default function FrontmatterForm({
  fields,
  session,
  onEdit,
  onAddFrontmatter,
  tagSuggestions,
}: FrontmatterFormProps) {
  const { t } = useTranslation();
  const formId = useId();
  const fm = session.fmDoc;

  if (!fm) {
    return (
      <div className="fm-form fm-empty">
        <p>{t(($) => $.frontmatter.missing)}</p>
        <button type="button" onClick={onAddFrontmatter}>
          {t(($) => $.frontmatter.add)}
        </button>
      </div>
    );
  }

  return (
    <div className="fm-form">
      {fields.map((field, index) => {
        const controlId = `${formId}-field-${index}`;
        return (
          <div key={field.name} className="fm-field">
            <label htmlFor={controlId} className="fm-label">
              {field.name}
              {field.required && fm.getString(field.name) === "" && (
                <em className="fm-required">{t(($) => $.common.required)}</em>
              )}
            </label>
            {renderControl(field, controlId, fm, onEdit, tagSuggestions)}
          </div>
        );
      })}
      {fields.length === 0 && (
        <p className="fm-hint">{t(($) => $.frontmatter.noConfiguredFields)}</p>
      )}
      <p className="fm-hint">{t(($) => $.frontmatter.preservedFields)}</p>
    </div>
  );
}

function renderControl(
  field: FieldSpec,
  controlId: string,
  fm: FrontmatterDocument,
  onEdit: FrontmatterFormProps["onEdit"],
  tagSuggestions: Record<string, string[]>,
) {
  switch (field.type) {
    case "boolean":
      return (
        <input
          id={controlId}
          type="checkbox"
          checked={fm.getBoolean(field.name)}
          onChange={(e) => onEdit((d) => d.set(field.name, e.target.checked))}
        />
      );
    case "date":
      return (
        <input
          id={controlId}
          type="date"
          value={fm.getString(field.name)}
          onChange={(e) => onEdit((d) => d.set(field.name, e.target.value))}
        />
      );
    case "tags":
      return (
        <TagEditor
          inputId={controlId}
          value={fm.getTags(field.name)}
          onChange={(tags) => onEdit((d) => d.set(field.name, tags))}
          suggestions={tagSuggestions[field.name] ?? []}
        />
      );
    default:
      return (
        <input
          id={controlId}
          type="text"
          value={fm.getString(field.name)}
          onChange={(e) => onEdit((d) => d.set(field.name, e.target.value))}
        />
      );
  }
}
