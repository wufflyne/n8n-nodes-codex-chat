import type { Binding, Session } from "../core/types.js";
import { ModelCatalog } from "../core/catalog.js";
import { ResponsesTransport } from "../core/transport.js";
import { AccountReader } from "../account/usage.js";
import { ResetController } from "../account/reset.js";
import type { CodexService } from "./contracts.js";
import type { EmbeddedService } from "./embedded.js";
import type { NativeManager } from "./native-manager.js";

/** Explicit composition: never qualifies for the legacy raw EmbeddedService shortcut. */
export class ManagedService implements CodexService {
  constructor(
    private readonly inner: EmbeddedService,
    private readonly manager: NativeManager,
  ) {}
  status(...args: Parameters<CodexService["status"]>) {
    return this.manager.run(() => this.inner.status(...args));
  }
  models(...args: Parameters<CodexService["models"]>) {
    return this.manager.run(() => this.inner.models(...args));
  }
  resolve(...args: Parameters<CodexService["resolve"]>) {
    return this.manager.run(() => this.inner.resolve(...args));
  }
  usage(...args: Parameters<CodexService["usage"]>) {
    return this.manager.run(() => this.inner.usage(...args));
  }
  limits(...args: Parameters<CodexService["limits"]>) {
    return this.manager.run(() => this.inner.limits(...args));
  }
  reset(...args: Parameters<CodexService["reset"]>) {
    return this.manager.run(() => this.inner.reset(...args));
  }
  reconcile(...args: Parameters<CodexService["reconcile"]>) {
    return this.manager.run(() => this.inner.reconcile(...args));
  }
  image(...args: Parameters<CodexService["image"]>) {
    return this.manager.run(() => this.inner.image(...args));
  }
  async *generate(...args: Parameters<CodexService["generate"]>) {
    yield* this.manager.stream(() => this.inner.generate(...args));
  }
  // Pure process-local erasure remains safe after the store lease has closed.
  finish(...args: Parameters<CodexService["finish"]>) {
    return this.inner.finish(...args);
  }

  /** Keep the native model's single recorder and exact transport/admission/replay semantics. */
  modelResources(binding: Binding): {
    session: (signal?: AbortSignal) => Promise<Session>;
    catalog: ModelCatalog;
    transport: ResponsesTransport;
    reader: AccountReader;
    reset: ResetController;
  } {
    const manager = this.manager,
      r = manager.resources;
    class Catalog extends ModelCatalog {
      override model(session: Session, slug: string, signal?: AbortSignal) {
        return manager.run(() => r.catalog.model(session, slug, signal));
      }
      override list(session: Session, signal?: AbortSignal, force = false) {
        return manager.run(() => r.catalog.list(session, signal, force));
      }
    }
    class Transport extends ResponsesTransport {
      override async *stream(...args: Parameters<ResponsesTransport["stream"]>) {
        yield* manager.stream(() => r.transport.stream(...args));
      }
    }
    class Reader extends AccountReader {
      override readAccount(...args: Parameters<AccountReader["readAccount"]>) {
        return manager.run(() => r.account.readAccount(...args));
      }
    }
    class Reset extends ResetController {
      override consumeReset(...args: Parameters<ResetController["consumeReset"]>) {
        return manager.run(() => r.resets.consumeReset(...args));
      }
    }
    return {
      session: (signal?: AbortSignal) => manager.run(() => r.sessions.session(binding, signal)),
      catalog: new Catalog(),
      transport: new Transport(),
      reader: new Reader(r.sessions),
      reset: new Reset(r.account, r.resets.store),
    };
  }
}
