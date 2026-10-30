"use strict";
// Qualification-only preload: real provider calls are denied and rewritten to the internal fixture.
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (["chatgpt.com", "auth.openai.com"].includes(url.hostname))
    return original(new URL(url.pathname + url.search, "http://fixture:8790"), {
      ...init,
      redirect: "error",
    });
  if (["fixture", "gateway", "127.0.0.1", "localhost"].includes(url.hostname))
    return original(input, { ...init, redirect: "error" });
  throw new Error("External network is disabled in synthetic qualification.");
};
