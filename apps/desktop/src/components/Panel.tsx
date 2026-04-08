import type { PropsWithChildren, ReactNode } from "react";

export function Panel(props: PropsWithChildren<{ title: string; actions?: ReactNode }>) {
  return (
    <section
      style={{
        border: "1px solid #d9d3c7",
        borderRadius: 20,
        padding: 20,
        background: "rgba(255,255,255,0.78)",
        boxShadow: "0 12px 24px rgba(53,36,20,0.08)",
        backdropFilter: "blur(12px)"
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>{props.title}</h2>
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

