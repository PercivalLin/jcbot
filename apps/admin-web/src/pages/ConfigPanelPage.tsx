import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "../components/Card";
import { Field, FormSection } from "../components/forms";
import { adminApi } from "../lib/adminApi";
import { stringifyConfig, toDisplayValue } from "../lib/format";

export function ConfigPanelPage() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["admin", "config"], queryFn: adminApi.getConfig });

  const [runtimeDraft, setRuntimeDraft] = useState("{}");
  const [modelsDraft, setModelsDraft] = useState("");
  const [telegramToken, setTelegramToken] = useState("");
  const [openAiApiKey, setOpenAiApiKey] = useState("");

  useEffect(() => {
    setRuntimeDraft(JSON.stringify(config.data?.runtime ?? {}, null, 2));
    setModelsDraft(stringifyConfig(config.data?.models));
  }, [config.data]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin", "config"] });
    await queryClient.invalidateQueries({ queryKey: ["admin", "readiness"] });
    await queryClient.invalidateQueries({ queryKey: ["admin", "runtime"] });
  };

  const runtimeMutation = useMutation({
    mutationFn: () => adminApi.updateRuntimeConfig(JSON.parse(runtimeDraft) as Record<string, unknown>),
    onSuccess: refresh
  });

  const modelsMutation = useMutation({
    mutationFn: () => adminApi.updateModelsConfig(modelsDraft),
    onSuccess: refresh
  });

  const secretsMutation = useMutation({
    mutationFn: () =>
      adminApi.updateSecrets({
        telegramBotToken: telegramToken || undefined,
        openaiCompatibleApiKey: openAiApiKey || undefined
      }),
    onSuccess: async () => {
      setTelegramToken("");
      setOpenAiApiKey("");
      await refresh();
    }
  });

  return (
    <div className="page-grid">
      <Card title="Runtime config" subtitle="Editable JSON payload sent to PUT /api/admin/config/runtime.">
        <FormSection
          title="runtime.env projection"
          description="Treat this as an admin-oriented draft editor until the backend finalizes field-level validation."
          onSubmit={(event) => {
            event.preventDefault();
            void runtimeMutation.mutateAsync();
          }}
          actions={
            <button className="primary-button" type="submit" disabled={runtimeMutation.isPending}>
              {runtimeMutation.isPending ? "Saving..." : "Save runtime"}
            </button>
          }
        >
          <Field label="Runtime JSON" hint="Invalid JSON will fail fast on submit.">
            <textarea rows={18} value={runtimeDraft} onChange={(event) => setRuntimeDraft(event.target.value)} />
          </Field>
        </FormSection>
      </Card>

      <Card title="Model config" subtitle="Raw text editor for model profile config.">
        <FormSection
          title="models payload"
          onSubmit={(event) => {
            event.preventDefault();
            void modelsMutation.mutateAsync();
          }}
          actions={
            <button className="primary-button" type="submit" disabled={modelsMutation.isPending}>
              {modelsMutation.isPending ? "Saving..." : "Save models"}
            </button>
          }
        >
          <Field label="Raw content">
            <textarea rows={18} value={modelsDraft} onChange={(event) => setModelsDraft(event.target.value)} />
          </Field>
        </FormSection>
      </Card>

      <Card title="Secret rotation" subtitle="Write-only secret update flow.">
        <FormSection
          title="Stored credentials"
          description={`Telegram configured: ${toDisplayValue(
            config.data?.secrets?.telegramBotTokenConfigured
          )} | Model key configured: ${toDisplayValue(config.data?.secrets?.openaiCompatibleApiKeyConfigured)}`}
          onSubmit={(event) => {
            event.preventDefault();
            void secretsMutation.mutateAsync();
          }}
          actions={
            <button className="primary-button" type="submit" disabled={secretsMutation.isPending}>
              {secretsMutation.isPending ? "Saving..." : "Save secrets"}
            </button>
          }
        >
          <Field label="Telegram bot token">
            <input
              type="password"
              autoComplete="new-password"
              value={telegramToken}
              onChange={(event) => setTelegramToken(event.target.value)}
            />
          </Field>
          <Field label="OpenAI-compatible API key">
            <input
              type="password"
              autoComplete="new-password"
              value={openAiApiKey}
              onChange={(event) => setOpenAiApiKey(event.target.value)}
            />
          </Field>
        </FormSection>
      </Card>
    </div>
  );
}
