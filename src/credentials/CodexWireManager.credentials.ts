import type { ICredentialType, INodeProperties } from "n8n-workflow";
import {
  credentialAuthenticate,
  credentialPreAuthentication,
} from "../service/credential-persistence.js";

export class CodexWireManager implements ICredentialType {
  name = "codexWireManager";
  displayName = "Codex Wire Manager";
  documentationUrl = "https://github.com/wufflyne/n8n-nodes-codex-chat#readme";
  supportedNodes = [
    "n8n-nodes-codex-chat.codexWireService",
    "n8n-nodes-codex-chat.codexAccountTools",
  ];
  restrictToSupportedNodes = true as const;
  hideDomainRestrictionFields = true;
  properties: INodeProperties[] = [
    {
      displayName:
        "Use one Manager for this n8n instance and connect multiple Codex accounts under it. Choose a passphrase, save this credential, select it in Codex Wire Service, then activate that workflow. Share it only with people who should manage those accounts. Keep the original credential and passphrase unchanged: a new Manager cannot replace them. By wufflyne.com.",
      name: "notice",
      type: "notice",
      default: "",
    },
    {
      displayName: "Manager Passphrase",
      name: "managerPassphrase",
      type: "string",
      typeOptions: { password: true },
      noDataExpression: true,
      required: true,
      default: "",
      description:
        "Choose at least 12 characters. n8n encrypts this input. It unlocks the service's authenticated private key wrap; never place it in a workflow parameter.",
    },
    {
      displayName: "Owner Key",
      name: "ownerKey",
      type: "hidden",
      typeOptions: { password: true, expirable: true },
      noDataExpression: true,
      default: "",
    },
    {
      displayName: "Advanced Session Import",
      name: "sessionImport",
      type: "string",
      typeOptions: { password: true, rows: 5 },
      noDataExpression: true,
      default: "",
      description:
        "Optional. Paste an independent supported session JSON here, save, then run Codex Account → Import Session. It stays in encrypted credential storage; clear it in this modal after import.",
    },
  ];
  preAuthentication = () => credentialPreAuthentication(this.name);
  authenticate = (
    credentials: Parameters<typeof credentialAuthenticate>[1],
    options: Parameters<typeof credentialAuthenticate>[2],
  ) => credentialAuthenticate(this.name, credentials, options);
}
