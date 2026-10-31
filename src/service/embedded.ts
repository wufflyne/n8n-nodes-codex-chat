import { createHash } from "node:crypto";
import { assert } from "../core/errors.js";
import {
  clearExecutionUsage,
  executionUsage,
  recordInvocation,
} from "../core/execution-usage.js";
import { validateSettings } from "../core/catalog.js";
import { validateCompletion } from "../kernel/completion.js";
import { normalizeUsage } from "../core/usage.js";
import type { Binding, ProviderTool } from "../core/types.js";
import { accountIdentityKey, type ExecutionContext } from "../core/affinity.js";
import type { CodexService, NativeGeneration } from "./contracts.js";
import type { runtimeFromEnvironment } from "../runtime.js";
import { validateNativeRequest, validateNativeShape } from "../kernel/request.js";
import { validateOutputContract } from "../kernel/output-contract.js";

export class EmbeddedService implements CodexService {
  constructor(readonly resources: ReturnType<typeof runtimeFromEnvironment>) {}
  async status(binding: Binding) {
    return this.resources.account.readLocalStatus(binding);
  }
  async models(binding: Binding, signal?: AbortSignal, force = false) {
    return this.resources.catalog.list(
      await this.resources.sessions.session(binding, signal),
      signal,
      force,
    );
  }
  async resolve(binding: Binding, slug: string, signal?: AbortSignal) {
    const session = await this.resources.sessions.session(binding, signal);
    return {
      identity: {
        affinity: session.affinity,
        generation: session.generation,
        profileId: binding.profileId,
        routingIdentity: session.identity
          ? accountIdentityKey(session.identity)
          : undefined,
      },
      model: await this.resources.catalog.model(session, slug, signal),
    };
  }
  async usage(binding: Binding, context: ExecutionContext) {
    const p = await this.resources.store.read(binding);
    return executionUsage(
      context,
      createHash("sha256")
        .update(`${p.id}:${p.subject}:${p.accountId}`)
        .digest("hex"),
    );
  }
  limits(...args: Parameters<CodexService["limits"]>) {
    return this.resources.account.readAccount(...args);
  }
  reset(...args: Parameters<CodexService["reset"]>) {
    return this.resources.resets.consumeReset(args[0], args[1]);
  }
  reconcile(...args: Parameters<CodexService["reconcile"]>) {
    return this.resources.resets.resolvePendingReset(args[0], args[1]);
  }
  image(...args: Parameters<CodexService["image"]>) {
    return this.resources.images.generate(...args);
  }
  async *generate(
    binding: Binding,
    input: NativeGeneration,
    signal?: AbortSignal,
    onAdmission?: () => void | Promise<void>,
  ) {
    validateNativeShape(input.request, input.settings, input.lite);
    const r = this.resources,
      session = await r.sessions.session(binding, signal),
      model = await r.catalog.model(session, input.request.model, signal);
    assert(
      input.lite === model.useResponsesLite &&
        input.request.store === false &&
        input.request.stream === true,
      "The native request route is invalid.",
    );
    validateSettings(model, input.settings);
    validateNativeRequest(input.request, input.settings, model);
    const additional = input.request.input.find((i) => i.type === "additional_tools");
    const tools = input.request.tools ?? (additional?.tools as Array<{ tools: ProviderTool[] }> | undefined)?.[0]?.tools ?? [];
    const outputContract = validateOutputContract(input.outputContract, tools, input.request.text?.format);
    assert(
      input.request.prompt_cache_key === input.affinity,
      "Native affinity metadata does not match the request.",
    );
    assert(
      Buffer.byteLength(JSON.stringify(input.request)) <= 32 * 1024 * 1024,
      "The request exceeds 32 MiB.",
    );
    const recorder = recordInvocation(
      input.context,
      session.affinity,
      model.slug,
      input.lite ? "responses-lite" : "responses",
    );
    let text = "",
      textBytes = 0;
    try {
      for await (const event of r.transport.stream(
        input.request,
        session,
        input.settings,
        [signal],
        input.lite,
        {
          affinity: input.affinity,
          onAdmission,
          recorder,
          streamLimits: {
            eventBytes: 4 * 1024 * 1024,
            streamBytes: 16 * 1024 * 1024,
          },
          onRejection: async () => {
            const snapshot = await r.account.readAccount(binding, {
              afterRejection: true,
              signal,
              model: model.slug,
            });
            return snapshot.routing.decision === "quota_exhausted"
              ? "quota"
              : "retry";
          },
        },
      )) {
        if (event.kind === "text") {
          text += event.text;
          textBytes += Buffer.byteLength(event.text);
          assert(
            textBytes <= 4 * 1024 * 1024,
            "Native gateway output exceeded its bounded text limit.",
          );
        } else {
          const additional = input.request.input.find(
            (i) => i.type === "additional_tools",
          );
          const tools =
            input.request.tools ??
            (
              additional?.tools as Array<{ tools: ProviderTool[] }> | undefined
            )?.[0]?.tools ??
            [];
          assert(
            event.response.output.length <= 256 &&
              Buffer.byteLength(JSON.stringify(event.response)) <=
                4 * 1024 * 1024,
            "Native gateway output exceeded its terminal bound.",
          );
          validateCompletion(event.response, tools, text, outputContract);
          recorder.complete(normalizeUsage(event.response.usage));
        }
        yield event;
      }
    } finally {
      recorder.failed();
      recorder.close();
    }
  }
  async finish(context: ExecutionContext) {
    clearExecutionUsage(context);
  }
}
