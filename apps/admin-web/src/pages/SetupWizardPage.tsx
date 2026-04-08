import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "../lib/adminApi";
import { stringifyConfig, toDisplayValue } from "../lib/format";
import { Card } from "../components/Card";
import { Field, FormSection } from "../components/forms";
import { KeyValueList } from "../components/KeyValueList";
import { ReadinessList } from "../components/ReadinessList";

export function SetupWizardPage() {
  const queryClient = useQueryClient();
  const readiness = useQuery({ queryKey: ["admin", "readiness"], queryFn: adminApi.getReadiness });
  const config = useQuery({ queryKey: ["admin", "config"], queryFn: adminApi.getConfig });

  const [bridgeBin, setBridgeBin] = useState("");
  const [telegramChatIds, setTelegramChatIds] = useState("");
  const [telegramBaseUrl, setTelegramBaseUrl] = useState("");
  const [telegramToken, setTelegramToken] = useState("");
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [modelsRaw, setModelsRaw] = useState("");

  useEffect(() => {
    const runtime = config.data?.runtime ?? {};
    setBridgeBin(String(runtime.bridgeBin ?? ""));
    setTelegramChatIds(toDisplayValue(runtime.telegramAllowedChatIds ?? ""));
    setTelegramBaseUrl(String(runtime.telegramBaseUrl ?? ""));
    setModelsRaw(stringifyConfig(config.data?.models));
  }, [config.data]);

  const refreshConfig = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin", "config"] });
    await queryClient.invalidateQueries({ queryKey: ["admin", "readiness"] });
  };

  const runtimeMutation = useMutation({
    mutationFn: () =>
      adminApi.updateRuntimeConfig({
        bridgeBin,
        telegramAllowedChatIds: telegramChatIds,
        telegramBaseUrl
      }),
    onSuccess: refreshConfig
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
      await refreshConfig();
    }
  });

  const modelsMutation = useMutation({
    mutationFn: () => adminApi.updateModelsConfig(modelsRaw),
    onSuccess: refreshConfig
  });

  return (
    <div className="page-grid">
      <Card title="Setup status" subtitle="Readiness checks that matter during first-run setup.">
        <ReadinessList report={readiness.data} />
      </Card>

      <Card title="What this wizard writes" subtitle="Secrets stay write-only. Non-sensitive config remains editable.">
        <KeyValueList
          entries={[
            { key: "Telegram token", value: config.data?.secrets?.telegramBotTokenConfigured ? "configured" : "missing" },
            {
              key: "Model API key",
              value: config.data?.secrets?.openaiCompatibleApiKeyConfigured ? "configured" : "missing"
            },
            { key: "Bridge binary", value: toDisplayValue(config.data?.runtime?.bridgeBin) },
            { key: "Admin paths", value: toDisplayValue(config.data?.paths) }
          ]}
        />
      </Card>

      <Card title="Step 1: Runtime essentials" subtitle="Bridge path and Telegram delivery basics.">
        <FormSection
          title="Runtime config"
          description="These values are expected to hot-reload once the backend supports it."
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
          <Field label="Bridge binary path" hint="Absolute path to the native lobster-bridge binary.">
            <input value={bridgeBin} onChange={(event) => setBridgeBin(event.target.value)} />
          </Field>
          <Field label="Telegram allowed chat IDs" hint="Comma-separated list is fine for the skeleton.">
            <input value={telegramChatIds} onChange={(event) => setTelegramChatIds(event.target.value)} />
          </Field>
          <Field label="Telegram base URL" hint="Leave blank for the default Bot API host if desired.">
            <input value={telegramBaseUrl} onChange={(event) => setTelegramBaseUrl(event.target.value)} />
          </Field>
        </FormSection>
      </Card>

      <Card title="Step 2: Secrets" subtitle="Secrets are write-only and never rehydrated into the form.">
        <FormSection
          title="Credentials"
          description="Submitting blank fields keeps existing stored values unchanged."
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

      <Card title="Step 3: Model profiles" subtitle="Edit the raw model configuration payload.">
        <FormSection
          title="models.yaml"
          description="The client leaves this as raw text because the backend schema may evolve."
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
            <textarea rows={16} value={modelsRaw} onChange={(event) => setModelsRaw(event.target.value)} />
          </Field>
        </FormSection>
      </Card>
    </div>
  );
}
