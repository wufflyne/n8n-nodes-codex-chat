import { record } from "../core/errors.js";
import { executionKey } from "../core/affinity.js";
import { credentialBinding } from "../runtime.js";
import type { CodexService, RpcEnvelope, NativeGeneration } from "../service/contracts.js";
import type { KeyRecord } from "./auth.js";
import { invalid, WireError } from "./errors.js";
import { validateResetOptions, validateReconcileOptions } from "../account/reset-policy.js";
import { validateNativeShape } from "../kernel/request.js";

export function validateRpc(value: unknown, key: KeyRecord): RpcEnvelope {
  const e = record(value);
  if (
    Object.keys(e).some(
      (k) =>
        ![
          "protocolVersion",
          "operationId",
          "operationIssuedAt",
          "execution",
          "binding",
          "method",
          "params",
        ].includes(k),
    ) ||
    e.protocolVersion !== 1 ||
    typeof e.operationId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(e.operationId)
  )
    invalid("rpc");
  if (
    !Number.isSafeInteger(e.operationIssuedAt) ||
    Number(e.operationIssuedAt) > Date.now() + 60000 ||
    Number(e.operationIssuedAt) < Date.now() - 86400000
  )
    throw new WireError(
      422,
      "operation_expired",
      "This native operation is outside its immutable 24-hour retry window.",
    );
  const methods = [
    "status",
    "models",
    "resolve",
    "usage",
    "limits",
    "reset",
    "reconcile",
    "image",
    "generate",
    "cancel",
    "finish",
  ];
  if (!methods.includes(String(e.method))) invalid("method");
  if (!key.scopes.includes(`native:${e.method}`) && !key.scopes.includes("native:*"))
    throw new WireError(
      403,
      "rpc_scope",
      "The installation key does not permit this native operation.",
    );
  if (["reset", "reconcile"].includes(String(e.method)) && !key.scopes.includes("native:reset"))
    throw new WireError(
      403,
      "reset_scope",
      "This installation key cannot authorize earned-reset actions.",
    );
  if (e.binding) {
    const b = credentialBinding(e.binding);
    if (key.profiles && !key.profiles.includes(b.profileId))
      throw new WireError(
        403,
        "profile_scope",
        "This installation key does not permit this profile.",
      );
  } else if (!["finish", "cancel"].includes(String(e.method))) invalid("binding");
  if (e.execution) {
    const x = record(e.execution);
    if (
      Object.keys(x).some(
        (k) => !["instanceId", "workflowId", "executionId", "nodeId", "nodeName"].includes(k),
      ) ||
      ["instanceId", "workflowId", "executionId", "nodeId", "nodeName"].some(
        (k) =>
          typeof x[k] !== "string" || !(x[k] as string).length || (x[k] as string).length > 512,
      ) ||
      x.instanceId !== key.installationId
    )
      throw new WireError(
        403,
        "execution_scope",
        "Native execution identity does not match this installation key.",
      );
  } else if (
    ["usage", "reset", "reconcile", "image", "generate", "finish", "cancel"].includes(
      String(e.method),
    )
  )
    invalid("execution");
  record(e.params);
  if (e.method === "generate") {
    const params = record(e.params);
    if (Object.keys(params).some((key) => !["request", "settings", "lite", "context", "affinity", "outputContract"].includes(key))) invalid("params");
    validateNativeShape(params.request, params.settings, params.lite);
  }
  if (e.method === "reset" || e.method === "reconcile") {
    const options = e.method === "reset" ? validateResetOptions(e.params) : validateReconcileOptions(e.params);
    if (options.executionKey !== executionKey(e.execution as NonNullable<RpcEnvelope["execution"]>))
      throw new WireError(403, "execution_scope", "Reset execution identity is inconsistent.");
  }
  return e as unknown as RpcEnvelope;
}
export async function dispatchRpc(
  service: CodexService,
  e: RpcEnvelope,
  signal: AbortSignal,
  onAdmission?: () => void | Promise<void>,
): Promise<unknown> {
  const b = e.binding!,
    p = e.params;
  const exact = (allowed: string[]) => {
    for (const key of Object.keys(p)) if (!allowed.includes(key)) invalid(`params.${key}`);
  };
  switch (e.method) {
    case "status":
      exact([]);
      return service.status(b);
    case "models":
      exact(["force"]);
      if (p.force !== undefined && typeof p.force !== "boolean") invalid("params.force");
      return service.models(b, signal, p.force === true);
    case "resolve":
      exact(["model"]);
      if (typeof p.model !== "string") invalid("params.model");
      return service.resolve(b, p.model, signal);
    case "usage":
      exact([]);
      return service.usage(b, e.execution!);
    case "limits":
      exact(["force", "afterRejection", "includeResetDetails", "model", "access"]);
      for (const key of ["force", "afterRejection", "includeResetDetails"])
        if (p[key] !== undefined && typeof p[key] !== "boolean") invalid(`params.${key}`);
      if (p.access !== undefined && !["current-only", "managed"].includes(String(p.access)))
        invalid("params.access");
      return service.limits(b, { ...p, signal });
    case "reset":
      exact(["origin", "executionKey", "policy", "selectedCreditId", "acknowledgement"]);
      if (p.executionKey !== executionKey(e.execution!))
        throw new WireError(403, "execution_scope", "Reset execution identity is inconsistent.");
      return service.reset(
        b,
        { ...p, signal } as Parameters<CodexService["reset"]>[1],
        e.execution,
      );
    case "reconcile":
      exact(["executionKey"]);
      if (p.executionKey !== executionKey(e.execution!))
        throw new WireError(
          403,
          "execution_scope",
          "Reconciliation execution identity is inconsistent.",
        );
      return service.reconcile(b, { executionKey: String(p.executionKey), signal }, e.execution);
    case "image": {
      exact(["prompt", "transparent", "timeoutMs", "access"]);
      if (p.access !== undefined && !["current-only", "managed"].includes(String(p.access)))
        invalid("params.access");
      const image = await service.image(b, p.prompt as string, p.transparent as boolean, {
        timeoutMs: p.timeoutMs as number | undefined,
        signal,
        context: e.execution,
        access: p.access as NonNullable<Parameters<CodexService["image"]>[3]>["access"],
      });
      return { ...image, bytes: image.bytes.toString("base64") };
    }
    case "generate":
      exact(["request", "settings", "lite", "context", "affinity", "outputContract"]);
      return service.generate(
        b,
        { ...p, context: e.execution } as unknown as NativeGeneration,
        signal,
        onAdmission,
      );
    case "finish":
      exact([]);
      await service.finish(e.execution!);
      return { finished: true };
    default:
      invalid("method");
  }
}
