import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "./components/AppShell";
import { subscribeToAdminStream } from "./lib/adminApi";
import { navigate, useRoute } from "./lib/router";
import { ConfigPanelPage } from "./pages/ConfigPanelPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RuntimeDashboardPage } from "./pages/RuntimeDashboardPage";
import { SetupWizardPage } from "./pages/SetupWizardPage";

function useAdminStreamInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    return subscribeToAdminStream((event) => {
      switch (event.event) {
        case "run.event":
        case "approval.updated":
          void queryClient.invalidateQueries({ queryKey: ["admin", "runs"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "runtime"] });
          break;
        case "readiness.updated":
        case "bridge.updated":
          void queryClient.invalidateQueries({ queryKey: ["admin", "readiness"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "runtime"] });
          break;
        case "config.updated":
          void queryClient.invalidateQueries({ queryKey: ["admin", "config"] });
          break;
        default:
          void queryClient.invalidateQueries({ queryKey: ["admin"] });
          break;
      }
    });
  }, [queryClient]);
}

export default function App() {
  const route = useRoute();
  useAdminStreamInvalidation();

  if (route.name === "setup") {
    return (
      <AppShell
        activePath="/setup"
        eyebrow="First-run"
        title="Setup Wizard"
        description="Bootstrap bridge, Telegram, and model config from a local browser without editing files by hand."
        actions={
          <button className="secondary-button" type="button" onClick={() => navigate("/runtime")}>
            Open runtime
          </button>
        }
      >
        <SetupWizardPage />
      </AppShell>
    );
  }

  if (route.name === "config") {
    return (
      <AppShell
        activePath="/config"
        eyebrow="Configuration"
        title="Config Panel"
        description="Edit runtime, model, and secret material through the local admin surface."
      >
        <ConfigPanelPage />
      </AppShell>
    );
  }

  if (route.name === "run-detail") {
    return (
      <AppShell
        activePath="/runtime"
        eyebrow="Run inspection"
        title={`Run Detail ${route.runId.slice(0, 8)}`}
        description="Timeline and raw payload views for a single daemon run."
        actions={
          <button className="secondary-button" type="button" onClick={() => navigate("/runtime")}>
            Back to runs
          </button>
        }
      >
        <RunDetailPage runId={route.runId} />
      </AppShell>
    );
  }

  return (
    <AppShell
      activePath="/runtime"
      eyebrow="Operations"
      title="Runtime Dashboard"
      description="Track readiness, bridge health, current desktop work, and recent runs from one screen."
      actions={
        <button className="secondary-button" type="button" onClick={() => navigate("/setup")}>
          Reopen setup
        </button>
      }
    >
      <RuntimeDashboardPage />
    </AppShell>
  );
}
