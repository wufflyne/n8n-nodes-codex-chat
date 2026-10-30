import type { StateRepository, Stored } from "./repository.js";
import { terminal } from "../errors.js";
import { assertHistoryScope, type HistoryScope } from "./history-scope.js";
import {
  validateContext,
  TOMBSTONE_RETENTION,
  type ModelRequestContext,
} from "../context.js";

export interface OperationRecord {
  digest: string;
  issuedAt: number;
  state: "intent" | "completed" | "rejected" | "unknown";
  response?: unknown;
  responseScope?: HistoryScope;
  stored: boolean;
}
export class OperationStore {
  constructor(private readonly state: StateRepository) {}
  async begin(
    connection: string,
    context: ModelRequestContext,
    body: unknown,
    stored: boolean,
    scope?: HistoryScope,
  ) {
    validateContext(context);
    const owner = this.state.scope("operations", connection),
      id = this.state.scope(context.operationId),
      digest = this.state.digest({ context, body });
    const previous = await this.state.get<OperationRecord>(owner, id);
    if (previous) {
      if (
        previous.value.digest !== digest ||
        previous.value.issuedAt !== context.operationIssuedAt
      )
        terminal(
          "operation_conflict",
          "The logical operation was reused with different input or identity.",
        );
      if (
        previous.value.state === "completed" &&
        previous.value.stored &&
        previous.value.response
      ) {
        assertHistoryScope(previous.value.responseScope, scope);
        return { owner, id, replay: previous.value.response, record: previous };
      }
      if (previous.value.state === "completed")
        terminal(
          "result_not_retained",
          "This operation already completed. Its result is no longer retained and it will not be dispatched again.",
        );
      if (previous.value.state === "rejected")
        terminal(
          "operation_rejected",
          "This operation was rejected before successful admission and will not be dispatched again. Review the original error and current account limits or configuration before starting a new operation. An existing conversation keeps its account.",
        );
      terminal(
        previous.value.state === "intent"
          ? "operation_in_flight"
          : "outcome_unknown",
        "This operation is already recorded and cannot be dispatched again. Recover its outcome first.",
      );
    }
    const value: OperationRecord = {
      digest,
      issuedAt: context.operationIssuedAt,
      state: "intent",
      stored,
    };
    await this.state.transaction(
      [{ owner, id, revision: null }],
      [
        {
          owner,
          id,
          value,
          expires: context.operationIssuedAt + TOMBSTONE_RETENTION,
        },
      ],
    );
    return {
      owner,
      id,
      record: (await this.state.get<OperationRecord>(owner, id))!,
    };
  }
  async finish(
    handle: { owner: string; id: string; record: Stored<OperationRecord> },
    outcome: "completed" | "rejected" | "unknown",
    response?: { body: unknown; scope: HistoryScope },
    extraWrites: Parameters<StateRepository["transaction"]>[1] = [],
    release?: { owner: string; id: string },
  ) {
    await this.state.transaction(
      [
        {
          owner: handle.owner,
          id: handle.id,
          revision: handle.record.revision,
        },
      ],
      [
        {
          owner: handle.owner,
          id: handle.id,
          value: {
            ...handle.record.value,
            state: outcome,
            ...(handle.record.value.stored && response !== undefined
              ? { response: response.body, responseScope: response.scope }
              : {}),
          },
          expires: handle.record.value.issuedAt + TOMBSTONE_RETENTION,
        },
        ...extraWrites,
      ],
      release,
    );
  }
}
