import type { ICredentialType, INodeProperties } from "n8n-workflow";

export class CodexAccount implements ICredentialType {
  name = "codexAccount";
  displayName = "Codex Account";
  documentationUrl = "https://learn.chatgpt.com/docs/auth";
  properties: INodeProperties[] = [
    {
      displayName:
        "Connect an isolated account with the Codex Wire console in gateway mode, or the n8n-codex-account helper in embedded mode. Use Device Login or Manual Import and copy the protected profile binding into these unchanged fields. Tokens stay with the single profile owner. This is the experimental Codex backend, using your subscription allowance.",
      name: "notice",
      type: "notice",
      default: "",
    },
    {
      displayName: "Profile ID",
      name: "profileId",
      type: "string",
      default: "",
      required: true,
      description:
        "The profileId from the helper binding file. Keep separate profiles and memory sessions for each account, workflow, and conversation.",
    },
    {
      displayName: "Binding Secret",
      name: "bindingSecret",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description:
        "The bindingSecret from the helper binding file. This authorizes access to only the selected profile.",
    },
  ];
}
