import type { PropsWithChildren, ReactNode } from "react";

export function Card({
  title,
  subtitle,
  children,
  actions
}: PropsWithChildren<{ title: string; subtitle?: string; actions?: ReactNode }>) {
  return (
    <section className="card">
      <header className="card__header">
        <div>
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div>{actions}</div> : null}
      </header>
      <div className="card__body">{children}</div>
    </section>
  );
}
