import type { FieldSpec } from "../lib/tauriApi";
import type { PostSession } from "../domain/postSession";
import type { FrontmatterDocument } from "../domain/frontmatterDocument";
import TagEditor from "./TagEditor";

interface FrontmatterFormProps {
  fields: FieldSpec[];
  session: PostSession;
  /** 对 fmDoc 施加一次修改并把 session 标记为 fmDirty */
  onEdit: (mutate: (fm: FrontmatterDocument) => void) => void;
  onAddFrontmatter: () => void;
}

export default function FrontmatterForm({
  fields,
  session,
  onEdit,
  onAddFrontmatter,
}: FrontmatterFormProps) {
  const fm = session.fmDoc;

  if (!fm) {
    return (
      <div className="fm-form fm-empty">
        <p>此文件没有 frontmatter。</p>
        <button type="button" onClick={onAddFrontmatter}>
          添加 frontmatter
        </button>
      </div>
    );
  }

  return (
    <div className="fm-form">
      {fields.map((field) => (
        <label key={field.name} className="fm-field">
          <span className="fm-label">
            {field.name}
            {field.required && fm.getString(field.name) === "" && (
              <em className="fm-required">必填</em>
            )}
          </span>
          {renderControl(field, fm, onEdit)}
        </label>
      ))}
      {fields.length === 0 && (
        <p className="fm-hint">配置里没有声明 frontmatter 字段。</p>
      )}
      <p className="fm-hint">未在此列出的字段会原样保留。</p>
    </div>
  );
}

function renderControl(
  field: FieldSpec,
  fm: FrontmatterDocument,
  onEdit: FrontmatterFormProps["onEdit"],
) {
  switch (field.type) {
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={fm.getBoolean(field.name)}
          onChange={(e) => onEdit((d) => d.set(field.name, e.target.checked))}
        />
      );
    case "date":
      return (
        <input
          type="date"
          value={fm.getString(field.name)}
          onChange={(e) => onEdit((d) => d.set(field.name, e.target.value))}
        />
      );
    case "tags":
      return (
        <TagEditor
          value={fm.getTags(field.name)}
          onChange={(tags) => onEdit((d) => d.set(field.name, tags))}
        />
      );
    default:
      return (
        <input
          type="text"
          value={fm.getString(field.name)}
          onChange={(e) => onEdit((d) => d.set(field.name, e.target.value))}
        />
      );
  }
}
