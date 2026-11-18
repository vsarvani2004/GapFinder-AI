"use client";

import { useRef } from "react";

type MaterialUploadProps = {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  multiple?: boolean;
  label?: string;
  className?: string;
};

/** Shared PDF/TXT picker used anywhere a study material can be added or restored. */
export function MaterialUpload({
  onFiles,
  disabled = false,
  multiple = true,
  label = "Choose PDF or TXT files →",
  className = "button primary upload-button",
}: MaterialUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.txt,application/pdf,text/plain"
        multiple={multiple}
        hidden
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) onFiles(files);
        }}
      />
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {disabled ? "Processing material…" : label}
      </button>
    </>
  );
}
