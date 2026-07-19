import { useEffect, useRef, useState } from "preact/hooks";
import type { Dictionary } from "../i18n.ts";

export interface AddModalProps {
  dict: Dictionary;
  onClose: () => void;
  onSubmit: (url: string, tags: string[]) => Promise<void>;
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function AddModal({ dict, onClose, onSubmit }: AddModalProps) {
  const [url, setUrl] = useState("");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlInputRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!url.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(url.trim(), parseTags(tags));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-modal-title">
        <div class="modal-header">
          <h2 class="modal-title" id="add-modal-title">{dict.modalTitle}</h2>
          <button
            type="button"
            class="icon-button"
            aria-label={dict.modalCancelAria}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div class="modal-field">
            <label class="modal-label" for="add-modal-url">{dict.urlLabel}</label>
            <input
              ref={urlInputRef}
              id="add-modal-url"
              class="modal-input"
              type="url"
              required
              placeholder={dict.urlPlaceholder}
              value={url}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="modal-field">
            <label class="modal-label" for="add-modal-tags">{dict.tagsLabel}</label>
            <input
              id="add-modal-tags"
              class="modal-input"
              type="text"
              placeholder={dict.tagsPlaceholder}
              value={tags}
              onInput={(e) => setTags((e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="modal-actions">
            <button type="button" class="modal-cancel" onClick={onClose}>
              {dict.modalCancelAria}
            </button>
            <button type="submit" class="modal-submit" disabled={submitting}>
              {dict.modalSubmit}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
