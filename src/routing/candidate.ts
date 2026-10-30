import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { ModelInfo, ModelSettings, Session } from "../core/types.js";
import type { BaseMessage } from "@langchain/core/messages";
import type { CodexCallOptions, CodexChatModel, CodexModelOptions } from "../model.js";
import type {
  AccountSnapshot,
  RecoveryPolicy,
  ResetResult,
} from "../account/types.js";
export const CODEX_CANDIDATE = Symbol("codex-wire-private-candidate");
export interface CodexCandidate {
  readonly key: string;
  readonly model: string;
  readonly settings: ModelSettings;
  readonly autoReset: boolean;
  readonly callbacks?: Callbacks;
  resolve(
    signal?: AbortSignal,
  ): Promise<{ session: Session; model: ModelInfo }>;
  read(signal?: AbortSignal, force?: boolean): Promise<AccountSnapshot>;
  readAfterRejection(signal?: AbortSignal): Promise<AccountSnapshot>;
  validateInput(
    messages: BaseMessage[],
    options: CodexCallOptions,
    selected: { session: Session; model: ModelInfo },
    overrides: Pick<CodexModelOptions, "replay" | "context" | "affinityPolicy">,
  ): void;
  recover(policy: RecoveryPolicy, signal?: AbortSignal): Promise<ResetResult>;
  clone(overrides: Partial<CodexModelOptions>): CodexChatModel;
}
