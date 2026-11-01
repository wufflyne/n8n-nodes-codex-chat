import { NodeConnectionTypes, type ISupplyDataFunctions } from "n8n-workflow";
import { assert } from "../core/errors.js";

/** Use only the supported Chat trigger and MAIN graph, never model-child introspection. */
export function nativeChatOutputPolicy(ctx: ISupplyDataFunctions): boolean {
  assert(
    typeof ctx.getChatTrigger === "function",
    "The pinned native Chat context is unavailable.",
  );
  const trigger = ctx.getChatTrigger();
  if (!trigger) return false;
  assert(
    trigger.disabled !== true &&
      (trigger.parameters.public === undefined || trigger.parameters.public === false),
    "Use one enabled private Chat Trigger for Codex Chat. Turn off Public Chat or put other Chat routes in separate workflows.",
  );
  const recovery =
    "For Chat, connect Chat Trigger directly to one AI Agent with one fixed Codex Chat Model and optional memory. Use an ordinary workflow for tools, output parsers, routing or custom output nodes.";
  const children = ctx
    .getChildNodes(trigger.name, { includeNodeParameters: true })
    .filter((node) => !node.disabled);
  assert(
    children.length === 1 &&
      children[0]!.type === "@n8n/n8n-nodes-langchain.agent" &&
      children[0]!.typeVersion === 3,
    recovery,
  );
  const agent = children[0]!;
  const parameters = agent.parameters ?? {};
  assert(parameters.hasOutputParser !== true && parameters.needsFallback !== true, recovery);
  for (const connectionType of [NodeConnectionTypes.AiTool, NodeConnectionTypes.AiOutputParser])
    assert(ctx.getParentNodes(agent.name, { connectionType, depth: 1 }).length === 0, recovery);
  const models = ctx.getParentNodes(agent.name, {
    connectionType: NodeConnectionTypes.AiLanguageModel,
    depth: 1,
  });
  assert(
    models.length === 1 &&
      models[0]!.name === ctx.getNode().name &&
      models[0]!.type === ctx.getNode().type,
    recovery,
  );
  return true;
}
