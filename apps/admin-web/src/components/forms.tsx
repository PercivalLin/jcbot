import type { FormEventHandler, PropsWithChildren, ReactNode } from "react";

export function FormSection({
  title,
  description,
  actions,
  onSubmit,
  children
}: PropsWithChildren<{
  title: string;
  description?: string;
  actions?: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}>) {
  return (
    <form className="form-section" onSubmit={onSubmit}>
      <div className="form-section__header">
        <div>
          <h4>{title}</h4>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div>{actions}</div> : null}
      </div>
      <div className="form-grid">{children}</div>
    </form>
  );
}

export function Field({
  label,
  hint,
  children
}: PropsWithChildren<{ label: string; hint?: string }>) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}
