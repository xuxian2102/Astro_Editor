import { useState } from "react";
import { useTranslation } from "react-i18next";
import { filterSuggestions } from "../domain/tagSuggestions";

interface TagEditorProps {
  inputId?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
}

export default function TagEditor({
  inputId,
  value,
  onChange,
  suggestions = [],
}: TagEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  const candidates = filterSuggestions(suggestions, value, draft);
  const showDropdown = open && candidates.length > 0;

  const add = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setDraft("");
    setOpen(false);
    setHighlighted(0);
  };

  const commit = () => add(draft);

  return (
    <div className="tag-editor-wrap">
      <div className="tag-editor">
        {value.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
            <button
              type="button"
              className="tag-remove"
              aria-label={t(($) => $.tags.remove, { tag })}
              onClick={() => onChange(value.filter((t) => t !== tag))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={inputId}
          className="tag-input"
          value={draft}
          placeholder={t(($) => $.tags.placeholder)}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
            setHighlighted(0);
          }}
          onKeyDown={(e) => {
            if (showDropdown && e.key === "ArrowDown") {
              e.preventDefault();
              setHighlighted((i) => (i + 1) % candidates.length);
            } else if (showDropdown && e.key === "ArrowUp") {
              e.preventDefault();
              setHighlighted(
                (i) => (i - 1 + candidates.length) % candidates.length,
              );
            } else if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              if (showDropdown) {
                add(candidates[highlighted]);
              } else {
                commit();
              }
            } else if (e.key === "Escape") {
              setOpen(false);
            } else if (
              e.key === "Backspace" &&
              draft === "" &&
              value.length > 0
            ) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => {
            setOpen(false);
          }}
        />
      </div>
      {showDropdown && (
        <ul className="tag-suggestions">
          {candidates.map((tag, i) => (
            <li key={tag}>
              <button
                type="button"
                className={
                  i === highlighted ? "tag-suggestion active" : "tag-suggestion"
                }
                onMouseDown={(e) => {
                  e.preventDefault(); // 防止 input 先 blur
                  add(tag);
                }}
                onMouseEnter={() => setHighlighted(i)}
              >
                {tag}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
