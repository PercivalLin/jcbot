import { generateText, type LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelProfile } from "@lobster/shared";
import { promptOpenAICompatibleViaCurl } from "./openaiCompatibleCurl.js";

export class ModelRouter {
  constructor(private readonly profiles: Record<ModelProfile["role"], ModelProfile>) {}

  listProfiles() {
    return this.profiles;
  }

  resolveProfile(role: ModelProfile["role"]) {
    return this.profiles[role];
  }

  async prompt(role: ModelProfile["role"], prompt: string): Promise<string> {
    const profile = this.resolveProfile(role);
    const apiKey = this.resolveApiKey(profile);

    if (!this.hasProviderCredential(profile)) {
      this.trace(
        `[model][${role}] provider=${profile.provider} model=${profile.modelId} result=stub reason=missing_credential`
      );
      return `[stub:${role}] ${prompt}`;
    }

    try {
      const model = this.buildModel(profile);
      const response = await generateText({
        model,
        prompt,
        maxTokens: profile.budget.outputTokens
      });

      this.trace(
        `[model][${role}] provider=${profile.provider} model=${profile.modelId} result=ok path=sdk`
      );
      return response.text;
    } catch (error) {
      this.trace(
        `[model][${role}] provider=${profile.provider} model=${profile.modelId} result=error path=sdk error="${summarizeError(error)}"`
      );
      if (profile.provider === "openai-compatible") {
        try {
          const recovered = await promptOpenAICompatibleViaCurl({
            apiKey,
            profile,
            prompt
          });
          this.trace(
            `[model][${role}] provider=${profile.provider} model=${profile.modelId} result=ok path=curl-fallback`
          );
          return recovered;
        } catch (fallbackError) {
          this.trace(
            `[model][${role}] provider=${profile.provider} model=${profile.modelId} result=error path=curl-fallback error="${summarizeError(fallbackError)}"`
          );
          // fallback to stub below
        }
      }
      this.trace(
        `[model][${role}] provider=${profile.provider} model=${profile.modelId} result=stub reason=all_paths_failed`
      );
      return `[stub:${role}] ${prompt}`;
    }
  }

  private trace(message: string) {
    if (process.env.LOBSTER_MODEL_TRACE === "0") {
      return;
    }
    console.log(message);
  }

  private buildModel(profile: ModelProfile): LanguageModel {
    const apiKey = this.resolveApiKey(profile);
    switch (profile.provider) {
      case "anthropic":
        return anthropic(profile.modelId);
      case "google":
        return google(profile.modelId);
      case "openai":
        return createOpenAI({
          apiKey
        })(profile.modelId);
      case "openai-compatible":
        return createOpenAI({
          apiKey,
          baseURL: profile.baseURL
        })(profile.modelId);
    }
  }

  private resolveApiKey(profile: ModelProfile) {
    const explicitRef = profile.apiKeyRef?.trim();
    if (explicitRef) {
      return process.env[explicitRef];
    }

    switch (profile.provider) {
      case "openai":
        return process.env.OPENAI_API_KEY;
      case "openai-compatible":
        return process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.OPENAI_API_KEY;
      case "anthropic":
        return process.env.ANTHROPIC_API_KEY;
      case "google":
        return process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
    }
  }

  private hasProviderCredential(profile: ModelProfile) {
    const explicitRef = profile.apiKeyRef?.trim();
    if (explicitRef) {
      return Boolean(process.env[explicitRef]);
    }

    if (profile.provider === "openai-compatible") {
      if (isLocalBaseUrl(profile.baseURL)) {
        return true;
      }

      return Boolean(this.resolveApiKey(profile));
    }

    return Boolean(this.resolveApiKey(profile));
  }
}

function isLocalBaseUrl(baseURL?: string) {
  if (!baseURL) {
    return false;
  }

  try {
    const parsed = new URL(baseURL);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    const compact = error.message.replace(/\s+/g, " ").trim();
    if (compact.length <= 160) {
      return compact;
    }
    return `${compact.slice(0, 160)}...`;
  }

  const value = String(error).replace(/\s+/g, " ").trim();
  if (value.length <= 160) {
    return value;
  }
  return `${value.slice(0, 160)}...`;
}
