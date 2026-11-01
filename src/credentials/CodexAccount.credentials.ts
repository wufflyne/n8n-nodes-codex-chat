import type { ICredentialType, INodeProperties } from "n8n-workflow";
import {
  credentialAuthenticate,
  credentialPreAuthentication,
} from "../service/credential-persistence.js";

export class CodexAccount implements ICredentialType {
  name = "codexAccount";
  displayName = "Codex Account";
  documentationUrl = "https://learn.chatgpt.com/docs/auth";
  hideDomainRestrictionFields = true;
  preAuthentication = () => credentialPreAuthentication(this.name);
  authenticate = (
    credentials: Parameters<typeof credentialAuthenticate>[1],
    options: Parameters<typeof credentialAuthenticate>[2],
  ) => credentialAuthenticate(this.name, credentials, options);
  properties: INodeProperties[] = [
    {
      displayName:
        "Save this credential, select it in Codex Account, select your Manager and run Start Sign-in. Complete sign-in in the provider's verification page, then run Complete Sign-in. Tokens remain in the encrypted local service store. By wufflyne.com.",
      name: "notice",
      type: "notice",
      default: "",
    },
    {
      displayName: "Advanced Binding Mode",
      name: "bindingMode",
      type: "options",
      default: "managed",
      noDataExpression: true,
      options: [
        { name: "Managed by Codex Wire Service", value: "managed" },
        { name: "Existing Legacy Binding", value: "legacy" },
      ],
      description:
        "Normal setup uses managed delivery. Legacy mode edits an already established v0.1.0 profile binding; it does not adopt or reassign a store.",
    },
    {
      displayName: "Profile ID",
      name: "profileId",
      type: "hidden",
      typeOptions: { password: true },
      default: "",
      displayOptions: { show: { bindingMode: ["managed"] } },
    },
    {
      displayName: "Binding Secret",
      name: "bindingSecret",
      type: "hidden",
      typeOptions: { password: true },
      default: "",
      displayOptions: { show: { bindingMode: ["managed"] } },
    },
    {
      displayName: "Profile ID",
      name: "profileId",
      type: "string",
      typeOptions: { password: true },
      displayOptions: { show: { bindingMode: ["legacy"] } },
      default: "",
      description:
        "Delivered to this exact credential by an authorized Manager operation. Existing legacy profile IDs remain supported.",
    },
    {
      displayName: "Binding Secret",
      name: "bindingSecret",
      type: "string",
      typeOptions: { password: true },
      displayOptions: { show: { bindingMode: ["legacy"] } },
      default: "",
      description:
        "Delivered encrypted by the host. It grants access only to the selected account.",
    },
    {
      displayName: "Manager",
      name: "ownerManagerId",
      type: "hidden",
      typeOptions: { password: true },
      noDataExpression: true,
      default: "",
    },
    {
      displayName: "Delivery",
      name: "deliveryId",
      type: "hidden",
      typeOptions: { password: true, expirable: true },
      noDataExpression: true,
      default: "",
    },
  ];
}
