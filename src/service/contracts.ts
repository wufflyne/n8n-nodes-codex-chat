import type { AccountReader } from "../account/usage.js";
import type { ResetController } from "../account/reset.js";
import type { ImageService } from "../image/service.js";
import type { LocalAccountStatus } from "../auth/status.js";
import type {
  Binding,
  ModelInfo,
  ModelSettings,
  ResponseRequest,
} from "../core/types.js";
import type { ExecutionContext } from "../core/affinity.js";
import type { TransportEvent } from "../core/transport.js";
import type { executionUsage } from "../core/execution-usage.js";

export const PROTOCOL_VERSION = 1 as const;
export const RELEASE = "0.0.5";
export interface ModelIdentity {
  affinity: string;
  generation: number;
  profileId: string;
  routingIdentity?: string;
}
export interface NativeGeneration {
  request: ResponseRequest;
  settings: ModelSettings;
  lite: boolean;
  context?: ExecutionContext;
  affinity?: string;
}
export interface CodexService {
  status(binding: Binding): Promise<LocalAccountStatus>;
  models(
    binding: Binding,
    signal?: AbortSignal,
    force?: boolean,
  ): Promise<ModelInfo[]>;
  resolve(
    binding: Binding,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ identity: ModelIdentity; model: ModelInfo }>;
  usage(
    binding: Binding,
    context: ExecutionContext,
  ): Promise<ReturnType<typeof executionUsage>>;
  limits(
    binding: Binding,
    options: Parameters<AccountReader["readAccount"]>[1],
  ): ReturnType<AccountReader["readAccount"]>;
  reset(
    binding: Binding,
    options: Parameters<ResetController["consumeReset"]>[1],
    context?: ExecutionContext,
  ): ReturnType<ResetController["consumeReset"]>;
  reconcile(
    binding: Binding,
    options: Parameters<ResetController["resolvePendingReset"]>[1],
    context?: ExecutionContext,
  ): ReturnType<ResetController["resolvePendingReset"]>;
  image(
    binding: Binding,
    prompt: string,
    transparent: boolean,
    options: Parameters<ImageService["generate"]>[3],
  ): ReturnType<ImageService["generate"]>;
  generate(
    binding: Binding,
    input: NativeGeneration,
    signal?: AbortSignal,
    onAdmission?: () => void | Promise<void>,
  ): AsyncGenerator<TransportEvent>;
  finish(context: ExecutionContext): Promise<void>;
}
export interface RpcEnvelope {
  protocolVersion: 1;
  operationId: string;
  operationIssuedAt: number;
  execution?: ExecutionContext;
  binding?: Binding;
  method:
    | "status"
    | "models"
    | "resolve"
    | "usage"
    | "limits"
    | "reset"
    | "reconcile"
    | "image"
    | "generate"
    | "cancel"
    | "finish";
  params: Record<string, unknown>;
}
