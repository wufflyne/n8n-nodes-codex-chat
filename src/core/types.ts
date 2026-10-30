export const PROVIDER = "codex-subscription-experimental" as const;
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const ISSUER = "https://auth.openai.com";
export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const CLIENT_VERSION = "0.166.0";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: string[];
}

export interface Identity {
  issuer: string;
  subject: string;
  accountId: string;
  clientId: string;
}
export interface DisplayMetadata {
  email?: {
    value: string;
    source: "verified_access_claim";
    verifiedAt: number;
  };
  plan?: { value: string; source: "verified_access_claim"; verifiedAt: number };
}
export interface Profile extends Identity {
  display?: DisplayMetadata;
  version: 1;
  provider: typeof PROVIDER;
  id: string;
  label: string;
  bindingHash: string;
  generation: number;
  state: "ready" | "reconnect" | "refresh_uncertain";
  tokens: TokenSet;
  verifiedAt: number;
}
export interface Binding {
  profileId: string;
  bindingSecret: string;
}
export interface Session {
  accessToken: string;
  accountId: string;
  affinity: string;
  generation: number;
  identity?: Identity;
  /** Verified account equality for native RPC; excludes tokens and account identifiers. */
  routingIdentity?: string;
  profileId?: string;
}
export interface ModelInfo {
  slug: string;
  name: string;
  reasoningEfforts: string[];
  supportsSummary: boolean;
  supportsVerbosity: boolean;
  serviceTiers: Array<{ id: string; name: string }>;
  supportsImages: boolean;
  contextWindow?: number;
  useResponsesLite: boolean;
  description?: string;
  defaultReasoningEffort?: string;
  defaultVerbosity?: string;
  inputModalities?: string[];
  originalImageDetail?: boolean;
  evidence: "account-catalog";
}
export interface ModelSettings {
  reasoningEffort?: string;
  reasoningSummary?: string;
  verbosity?: string;
  serviceTier?: string;
  parallelToolCalls?: boolean;
  timeoutMs: number;
  idleTimeoutMs: number;
  maxRetries: number;
}

export type JsonObject = Record<string, unknown>;
export type ResponseItem = JsonObject & { type?: string; id?: string };
export interface CompletedResponse {
  id: string;
  status: "completed";
  output: ResponseItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  service_tier?: string;
}
export interface ProviderTool {
  type: "function";
  name: string;
  description?: string;
  parameters: JsonObject;
  strict?: boolean;
}
export interface ResponseRequest {
  model: string;
  stream: true;
  store: false;
  input: ResponseItem[];
  instructions?: string;
  include: string[];
  tools?: ProviderTool[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string; context?: "all_turns" };
  text?: {
    verbosity?: string;
    format?: {
      type: "json_schema";
      name: string;
      strict: boolean;
      schema: JsonObject;
    };
  };
  prompt_cache_key?: string;
  service_tier?: string;
}
