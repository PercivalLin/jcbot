import type { PropsWithChildren, ReactNode } from "react";
import { navigate } from "../lib/router";

type AppShellProps = PropsWithChildren<{
  title: string;
  eyebrow: string;
  description: string;
  actions?: ReactNode;
  activePath: string;
}>;

const navItems = [
  { label: "Setup Wizard", path: "/setup" },
  { label: "Runtime Dashboard", path: "/runtime" },
  { label: "Config Panel", path: "/config" }
];

export function AppShell({ title, eyebrow, description, actions, activePath, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="sidebar__eyebrow">Lobster Admin</div>
          <h1 className="sidebar__title">Local control plane</h1>
          <p className="sidebar__body">
            Setup, readiness, run inspection, and configuration for the AX-first macOS operator.
          </p>
        </div>
        <nav className="sidebar__nav">
          {navItems.map((item) => (
            <button
              key={item.path}
              type="button"
              className={item.path === activePath ? "sidebar__link is-active" : "sidebar__link"}
              onClick={() => navigate(item.path)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar__footer">
          <span className="status-dot" />
          <span>localhost admin only</span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="page-header">
          <div>
            <div className="page-header__eyebrow">{eyebrow}</div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          {actions ? <div className="page-header__actions">{actions}</div> : null}
        </header>
        {children}
      </main>
    </div>
  );
}
