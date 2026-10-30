import { nativeService } from "../service/native.js";
import type { ISupplyDataFunctions } from "n8n-workflow";
import { assert } from "../core/errors.js";
import type { ExecutionContext } from "../core/affinity.js";
import { clearExecutionUsage } from "../core/execution-usage.js";
const cleanups = new Set<string>();
type Context = Pick<
  ISupplyDataFunctions,
  | "getInstanceId"
  | "getWorkflow"
  | "getExecutionId"
  | "getNode"
  | "onExecutionFinish"
  | "onExecutionCancellation"
>;
export function nativeContext(ctx: Context): ExecutionContext {
  assert(
    typeof ctx.getInstanceId === "function" &&
      typeof ctx.getWorkflow === "function" &&
      typeof ctx.getExecutionId === "function",
    "Public n8n execution identity is unavailable. Execution reporting and coordinated account actions require the pinned n8n runtime.",
  );
  assert(
    typeof ctx.onExecutionFinish === "function" &&
      typeof ctx.onExecutionCancellation === "function",
    "Public n8n execution cleanup hooks are required.",
  );
  const instanceId = ctx.getInstanceId(),
    executionId = ctx.getExecutionId(),
    workflowId = ctx.getWorkflow().id ?? "unsaved",
    node = ctx.getNode();
  assert(
    [instanceId, executionId, workflowId, node.id, node.name].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 512,
    ),
    "A unique public n8n execution identity is required.",
  );
  const context = Object.freeze({
      instanceId,
      workflowId,
      executionId,
      nodeId: node.id,
      nodeName: node.name,
    }),
    key = JSON.stringify([instanceId, workflowId, executionId]);
  if (!cleanups.has(key)) {
    cleanups.add(key);
    const cleanup = () => {
      clearExecutionUsage(context);
      if (process.env.N8N_CODEX_MODE === "gateway")
        void nativeService()
          .finish(context)
          .catch(() => undefined);
      cleanups.delete(key);
    };
    ctx.onExecutionFinish!(cleanup);
    ctx.onExecutionCancellation(cleanup);
  }
  return context;
}
