import type { INodeProperties } from "n8n-workflow";
import { DEFAULT_RECOVERY, type RecoveryPolicy } from "../account/types.js";
import { validateRecovery } from "../account/reset-policy.js";
export function recoveryProperty(router = false): INodeProperties {
  return {
    displayName: "Account Recovery",
    name: "accountRecovery",
    type: "collection",
    default: {},
    placeholder: "Add Recovery Option",
    options: [
      {
        displayName: "Automatic Reset",
        name: "automaticReset",
        type: "options",
        default: "off",
        options: [
          { name: "Off", value: "off" },
          { name: "When Included Allowance Is Low", value: "low" },
        ],
        description:
          "May use one finite earned reset at an active model-call boundary. No purchases or background polling.",
      },
      {
        displayName: "Remaining Allowance Threshold (%)",
        name: "threshold",
        type: "number",
        default: 1,
        typeOptions: { minValue: 0, maxValue: 1 },
        displayOptions: { show: { automaticReset: ["low"] } },
        description: "Compares the exact reported remaining percentage",
      },
      ...(router
        ? [
            {
              displayName: "Recovery Order",
              name: "order",
              type: "options",
              default: "next-first",
              options: [
                { name: "Try Next Account First", value: "next-first" },
                { name: "Use Reset Before Switching", value: "reset-first" },
              ],
            } as INodeProperties,
          ]
        : []),
      {
        displayName: "Maximum Resets per Account in 24 Hours",
        name: "maxPer24Hours",
        type: "number",
        default: 1,
        typeOptions: { minValue: 1, maxValue: 3 },
        description:
          "Counts this adapter’s issued or uncertain actions across profiles/workflows. One reset per execution is fixed.",
      },
    ],
  };
}
export const promptCacheProperty: INodeProperties = {
  displayName: "Prompt Cache",
  name: "promptCache",
  type: "collection",
  default: {},
  placeholder: "Add Prompt Cache Option",
  options: [
    {
      displayName: "Affinity",
      name: "affinity",
      type: "options",
      default: "execution",
      options: [
        { name: "This Execution", value: "execution" },
        { name: "Conversation", value: "conversation" },
        { name: "No Custom Affinity", value: "none" },
      ],
      description:
        "Keep request affinity stable for related prompts. Cache reuse is determined by the provider.",
    },
    {
      displayName: "Conversation Key",
      name: "conversationKey",
      type: "string",
      default: "",
      required: true,
      displayOptions: { show: { affinity: ["conversation"] } },
      description:
        "A bounded nonsecret conversation identifier; account identity stays isolated automatically",
    },
  ],
};
export function recoveryPolicy(value: unknown): RecoveryPolicy {
  const v = value as {
    automaticReset?: string;
    threshold?: number;
    maxPer24Hours?: number;
    order?: RecoveryPolicy["order"];
  };
  const policy = {
    ...DEFAULT_RECOVERY,
    automatic: v.automaticReset === "low",
    threshold: v.threshold ?? 1,
    maxPer24Hours: v.maxPer24Hours ?? 1,
    order: v.order ?? "next-first",
  };
  validateRecovery(policy);
  return policy;
}
