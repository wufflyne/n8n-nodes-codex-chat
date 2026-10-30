import { EmbeddedService } from "../../service/embedded.js";
import { CodexChatModel, type CodexModelOptions } from "../../model.js";
import { ModelCatalog } from "../../core/catalog.js";
import { ResponsesTransport, type TransportContext } from "../../core/transport.js";
import type { ModelSettings, ResponseRequest, Session, Binding } from "../../core/types.js";
import type { CodexService } from "../../service/contracts.js";
import type { AccountReader } from "../../account/usage.js";
import type { ResetController } from "../../account/reset.js";

/** Native-only adapter materializes safe account metadata; OAuth never crosses RPC. */
export function serviceModel(
  service: CodexService,
  binding: Binding,
  options: Omit<CodexModelOptions, "session" | "catalog" | "transport" | "account"> & {
    policy: NonNullable<CodexModelOptions["account"]>["policy"];
  },
) {
  const { policy, ...config } = options;
  if (service instanceof EmbeddedService) {
    const r = service.resources;
    return new CodexChatModel({
      ...config,
      session: (signal) => r.sessions.session(binding, signal),
      catalog: r.catalog,
      transport: r.transport,
      account: { binding, reader: r.account, reset: r.resets, policy },
    });
  }

  class Catalog extends ModelCatalog {
    override async model(_session: Session, slug: string, signal?: AbortSignal) {
      return (await service.resolve(binding, slug, signal)).model;
    }
  }
  class Transport extends ResponsesTransport {
    override async *stream(
      request: ResponseRequest,
      _session: Session,
      settings: ModelSettings,
      signals: Array<AbortSignal | undefined>,
      lite: boolean,
      context: TransportContext = {},
    ) {
      const active = signals.filter((s): s is AbortSignal => Boolean(s));
      let admitted = false;
      for await (const event of service.generate(
        binding,
        { request, settings, lite, context: config.context, affinity: context.affinity },
        active.length ? AbortSignal.any(active) : undefined,
        async () => {
          admitted = true;
          await context.onAdmission?.();
        },
      )) {
        if (!admitted) {
          admitted = true;
          await context.onAdmission?.();
        }
        yield event;
      }
    }
  }
  return new CodexChatModel({
    ...config,
    session: async (signal) => {
      const { identity } = await service.resolve(binding, config.model, signal);
      return {
        ...identity,
        accountId: "remote-metadata-only",
        accessToken: "remote-metadata-only",
      };
    },
    catalog: new Catalog(),
    transport: new Transport(),
    account: {
      binding,
      reader: { readAccount: service.limits.bind(service) } as AccountReader,
      reset: {
        consumeReset: (b: Binding, p: Parameters<CodexService["reset"]>[1]) =>
          service.reset(b, p, config.context),
      } as ResetController,
      policy,
    },
  });
}
