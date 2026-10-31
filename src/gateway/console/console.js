"use strict";
let csrf = "",
  view = "accounts",
  accounts = [],
  activity = {},
  bundle = "",
  deliveryId = "",
  deviceTimer,
  reconnectProfileId = "",
  navigationRevision = 0,
  renderRevision = 0,
  sessionRevision = 0,
  loggingOut = false,
  loggedOut = false;
const content = document.getElementById("content"),
  notice = document.getElementById("notice");
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const button = (text, action, cls) => {
  const n = el("button", text, cls);
  n.type = "button";
  n.addEventListener("click", () => Promise.resolve(action()).catch(showError));
  return n;
};
const showError = (e) => {
  if (e.name === "StaleConsoleResponse") return;
  notice.textContent = e.message || "The operation could not be completed.";
};
async function api(route, data) {
  const scope = [navigationRevision, renderRevision, sessionRevision];
  const r = await fetch("/control/v1/" + route, {
    method: data === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      ...(data === undefined
        ? {}
        : { "Content-Type": "application/json", "X-CSRF-Token": csrf }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const value = await r.json();
  if (
    route !== "logout" &&
    (scope[0] !== navigationRevision ||
      scope[1] !== renderRevision ||
      scope[2] !== sessionRevision)
  ) {
    const stale = new Error("An earlier console response was superseded.");
    stale.name = "StaleConsoleResponse";
    throw stale;
  }
  if (!r.ok) throw Error(value.error?.message || "The request failed.");
  return value;
}
function heading(title, description) {
  content.replaceChildren();
  const h = el("h1", title);
  h.id = "view-title";
  content.append(h, el("p", description, "subtitle"));
  return ++renderRevision;
}
function field(form, label, type = "text") {
  const l = el("label", label),
    input = el(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") input.type = type;
  l.append(input);
  form.append(l);
  return input;
}
async function showBundle(id) {
  deliveryId = id;
  bundle = JSON.stringify(await api("delivery", { id }), null, 2);
  document.getElementById("secret").value = bundle;
  document.getElementById("secret").type = "password";
  document.getElementById("delivery-id").textContent =
    "Pending delivery ID: " + id;
  document.getElementById("delivery").showModal();
}
async function login(initialized) {
  heading(
    initialized ? "Welcome back" : "Welcome to Codex Wire",
    "Connect your Codex subscription accounts and keep your automations in one place.",
  );
  const form = el("form", undefined, "card form");
  let token;
  if (!initialized)
    token = field(
      form,
      "Bootstrap token from the protected operator file",
      "password",
    );
  const passphrase = field(
    form,
    initialized
      ? "Administrator passphrase"
      : "Create an administrator passphrase",
    "password",
  );
  passphrase.autocomplete = initialized ? "current-password" : "new-password";
  const submit = el("button", initialized ? "Sign in" : "Create workspace");
  submit.type = "submit";
  form.append(submit);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      sessionRevision++;
      const result = await api(initialized ? "login" : "bootstrap", {
        passphrase: passphrase.value,
        ...(token ? { token: token.value } : {}),
      });
      csrf = result.csrf;
      loggedOut = false;
      await navigate("accounts");
    } catch (err) {
      showError(err);
    }
  });
  content.append(form);
}
async function navigate(next) {
  if (loggingOut) return;
  const revision = ++navigationRevision;
  renderRevision++;
  clearTimeout(deviceTimer);
  document.getElementById("delivery").close();
  if (loggedOut) return login(true);
  view = next;
  notice.textContent = "";
  document.querySelectorAll("nav button").forEach((b) => {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const session = await api("session");
  if (revision !== navigationRevision) return;
  if (!session.authenticated) {
    document.getElementById("logout").hidden = true;
    return login(session.initialized);
  }
  csrf = session.csrf;
  document.getElementById("logout").hidden = false;
  if (view === "accounts") await renderAccounts();
  if (view === "add") renderAdd();
  if (view === "connections") await renderConnections();
  if (view === "activity") await renderActivity();
}
async function renderAccounts() {
  const revision = heading(
    "Your accounts",
    "Your connected subscriptions, saved allowance and session health. Limits refresh only when you ask.",
  );
  const currentAccounts = (await api("accounts")).accounts;
  if (revision !== renderRevision) return;
  accounts = currentAccounts;
  if (!accounts.length) {
    const card = el("div", undefined, "card empty"),
      image = el("img");
    image.src = "/codex.svg";
    image.alt = "";
    card.append(
      image,
      el("h2", "Connect your first account"),
      el(
        "p",
        "Use a dedicated session with one owner for token renewal.",
        "muted",
      ),
      button("Add account", () => navigate("add")),
    );
    content.append(card);
    return;
  }
  const bar = el("div", undefined, "bar");
  bar.append(
    el(
      "span",
      accounts.length +
        " connected " +
        (accounts.length === 1 ? "account" : "accounts"),
      "muted",
    ),
    button("Add account", () => {
      reconnectProfileId = "";
      return navigate("add");
    }),
  );
  content.append(bar);
  const filters = el("div", undefined, "filters"),
    search = field(filters, "Find an account", "search"),
    status = el("select"),
    statusLabel = el("label", "Account status");
  search.placeholder = "Search by label, email or plan";
  for (const [value, title] of [
    ["all", "All accounts"],
    ["ready", "Ready"],
    ["attention", "Needs attention"],
  ]) {
    const option = el("option", title);
    option.value = value;
    status.append(option);
  }
  statusLabel.append(status);
  filters.append(statusLabel);
  content.append(filters);
  const list = el("div");
  content.append(list);
  function show() {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const rows = accounts
      .filter(
        (row) =>
          [row.account.label, row.account.email, row.account.planLabel]
            .join(" ")
            .toLowerCase()
            .includes(query) &&
          (status.value === "all" ||
            (status.value === "ready"
              ? row.account.state === "ready"
              : row.account.state !== "ready")),
      )
      .sort((a, b) => a.account.label.localeCompare(b.account.label));
    for (const row of rows) {
      const account = row.account,
        card = el("article", undefined, "card"),
        top = el("div", undefined, "account-heading"),
        title = el("div");
      title.append(
        el("h2", account.label),
        el("p", account.email || "Email unavailable", "muted"),
      );
      top.append(
        title,
        el("span", account.planLabel || "Plan unavailable", "badge"),
      );
      card.append(top);
      const state =
        account.state === "ready"
          ? "Ready"
          : account.state === "expired"
            ? "Session expired"
            : account.state === "refresh_uncertain"
              ? "Outcome unknown"
              : "Reconnect required";
      card.append(
        el(
          "span",
          state,
          account.state === "ready" ? "badge" : "badge warning",
        ),
        el("span", "Renewal: " + account.renewal.replaceAll("_", " "), "muted"),
      );
      const saved = row.savedLimits,
        windows = (saved?.limits?.buckets || []).flatMap((bucket) =>
          bucket.windows.map((window) => ({
            ...window,
            bucket: bucket.name || bucket.id,
          })),
        ),
        ordinary = (saved?.limits?.buckets || []).find(
          (bucket) => bucket.scope === "ordinary",
        ),
        primary = ordinary?.windows.find((window) => window.kind === "primary"),
        next = windows
          .map((window) => window.resetsAt)
          .filter(Boolean)
          .sort()[0];
      const grid = el("div", undefined, "grid");
      for (const [label, value, note] of [
        [
          "Included allowance",
          primary?.remainingPercent == null
            ? "Unavailable"
            : primary.remainingPercent + "% remaining",
          "Provider-reported window",
        ],
        [
          "Next reset",
          next
            ? new Intl.DateTimeFormat(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date(next))
            : "Unavailable",
          "Your local time",
        ],
        [
          "Credits",
          saved?.credits?.balance ?? "Unavailable",
          saved?.credits?.unit || "Unit not reported",
        ],
      ]) {
        const metric = el("div");
        const display = el(
          label === "Next reset" && next ? "time" : "div",
          value,
          "metric",
        );
        if (label === "Next reset" && next) {
          display.dateTime = next;
          display.title = new Date(next).toString();
          display.setAttribute("aria-label", display.title);
        }
        metric.append(el("p", label, "muted"), display, el("small", note));
        grid.append(metric);
      }
      card.append(grid);
      for (const window of windows) {
        if (window.remainingPercent == null) continue;
        const line = el("div", undefined, "allowance-window"),
          label = window.bucket + " · " + window.kind + " window";
        line.append(
          el("span", label, "muted"),
          el("span", window.remainingPercent + "% remaining", "muted"),
        );
        const progress = el("progress");
        progress.max = 100;
        progress.value = window.remainingPercent;
        progress.setAttribute("aria-label", label + " remaining allowance");
        line.append(progress);
        card.append(line);
      }
      card.append(
        el(
          "p",
          "Limits checked " +
            (saved?.checkedAt
              ? new Date(saved.checkedAt).toLocaleString()
              : "not yet"),
          "muted",
        ),
      );
      const actions = el("div", undefined, "actions");
      actions.append(
        button(
          "Reconnect account",
          async () => {
            reconnectProfileId = row.profileId;
            await navigate("add");
          },
          "secondary",
        ),
        button(
          "Refresh limits",
          async () => {
            await api("limits", { profileId: row.profileId });
            await renderAccounts();
          },
          "secondary",
        ),
      );
      card.append(actions);
      const details = el("details");
      details.append(el("summary", "Account details and provenance"));
      const data = el("dl");
      for (const [label, value] of [
        ["Profile ID", row.profileId],
        ["Session expires", new Date(account.expiresAt).toLocaleString()],
        [
          "Email source",
          account.emailSource?.replaceAll("_", " ") || "Not reported",
        ],
        [
          "Plan source",
          account.planSource?.replaceAll("_", " ") || "Not reported",
        ],
        [
          "Available earned resets",
          saved?.resetCredits?.availableCount ?? "Unavailable",
        ],
      ])
        data.append(el("dt", label), el("dd", String(value)));
      details.append(data);
      for (const credit of saved?.resetCredits?.entries || []) {
        const allocation = el("p", undefined, "muted");
        allocation.textContent =
          (credit.title || credit.resetType) +
          " · " +
          credit.status +
          (credit.expiresAt
            ? " · Expires " + new Date(credit.expiresAt).toLocaleString()
            : "") +
          (credit.ineligibleReason
            ? " · " + credit.ineligibleReason.replaceAll("_", " ")
            : "");
        details.append(allocation);
      }
      card.append(details);
      list.append(card);
    }
    if (!rows.length)
      list.append(el("p", "No accounts match these filters.", "muted"));
  }
  search.addEventListener("input", show);
  status.addEventListener("change", show);
  show();
}
function renderAdd() {
  heading(
    reconnectProfileId ? "Reconnect your account" : "Add an account",
    "This account must have one owner for token renewal. Device login uses the official provider flow.",
  );
  const form = el("div", undefined, "card form"),
    label = field(form, "Account label");
  label.placeholder = "Automation";
  form.append(
    button("Sign in with device code", async () => {
      const attempt = await api("device", {
        label: label.value,
        ...(reconnectProfileId ? { reconnectProfileId } : {}),
      });
      const state = el("div");
      form.append(state);
      const refresh = async () => {
        if (view !== "add") return;
        const d = await api("device/status", { id: attempt.id });
        state.replaceChildren();
        if (d.state === "waiting") {
          if (d.url) {
            const link = el("a", "Open official verification page");
            link.href = d.url;
            link.target = "_blank";
            link.rel = "noreferrer";
            state.append(
              el("p", "Enter this code on the official verification page."),
              el("div", d.code, "device-code"),
              link,
              el(
                "p",
                "Expires " + new Date(d.expiresAt).toLocaleTimeString(),
                "muted",
              ),
            );
          } else state.append(el("p", "Preparing device login…"));
          state.append(
            button(
              "Cancel",
              async () => {
                await api("device/cancel", { id: attempt.id });
                clearTimeout(deviceTimer);
                await navigate("add");
              },
              "secondary",
            ),
          );
          deviceTimer = setTimeout(() => refresh().catch(showError), 2000);
        } else if (d.state === "connected") {
          state.append(el("p", "Account connected."));
          if (d.deliveryId) await showBundle(d.deliveryId);
          else {
            reconnectProfileId = "";
            await navigate("accounts");
          }
        } else state.append(el("p", d.message || d.state));
      };
      await refresh();
    }),
  );
  const manual = el("details");
  manual.append(el("summary", "Import a dedicated session instead"));
  const format = el("select");
  for (const value of ["token-set", "codex-auth-json"]) {
    const o = el("option", value);
    o.value = value;
    format.append(o);
  }
  const fl = el("label", "Protected session format");
  fl.append(format);
  manual.append(fl);
  const file = field(manual, "Choose a protected JSON file", "file");
  file.accept = ".json,application/json";
  manual.append(
    el(
      "p",
      "The file is sent only to this account owner. It is never saved in browser storage.",
      "muted",
    ),
    button(
      "Import account",
      async () => {
        if (!file.files[0] || file.files[0].size > 262144)
          throw Error("Choose a JSON session file up to 256 KiB.");
        const result = await api("import", {
          label: label.value,
          format: format.value,
          session: JSON.parse(await file.files[0].text()),
          ...(reconnectProfileId ? { reconnectProfileId } : {}),
        });
        file.value = "";
        if (result.deliveryId) await showBundle(result.deliveryId);
        else {
          reconnectProfileId = "";
          await navigate("accounts");
        }
      },
      "secondary",
    ),
  );
  form.append(manual);
  content.append(form);
}
async function renderConnections() {
  const revision = heading(
    "Connections",
    "Use the OpenAI provider in n8n with a credential named Codex Wire. Requests use your connected Codex subscription account.",
  );
  const currentAccounts = (await api("accounts")).accounts;
  if (revision !== renderRevision) return;
  accounts = currentAccounts;
  const currentActivity = await api("activity");
  if (revision !== renderRevision) return;
  activity = currentActivity;
  const connections = (await api("connections")).connections;
  if (revision !== renderRevision) return;
  for (const p of connections) {
    const card = el("article", undefined, "card");
    card.append(
      el("h2", p.name),
      el(
        "span",
        p.mode === "pool" ? "Qualified account pool" : "Fixed account",
        "badge",
      ),
      el(
        "p",
        p.enabled
          ? "Enabled"
          : p.awaitingContext
            ? "Awaiting matched n8n runtime handshake"
            : "Disabled",
        "muted",
      ),
      el("p", "Provider: OpenAI · Credential name: Codex Wire"),
    );
    card.append(
      el(
        "p",
        "Base URL: " +
          (activity.inferenceOrigin || "Inference origin is not configured") +
          "/v1",
        "muted",
      ),
    );
    card.append(
      el("p", "Leave organization and custom-header fields empty.", "muted"),
    );
    if (p.mode === "fixed")
      card.append(
        el(
          "p",
          "Stock client retries may consume additional allowance. Automatic resets are disabled.",
          "muted",
        ),
      );
    if (p.enabled)
      card.append(
        button(
          "Disable connection",
          async () => {
            await api("connections/disable", { id: p.id });
            await renderConnections();
          },
          "secondary",
        ),
      );
    else if (!p.awaitingContext) {
      card.append(
        button(
          "Enable connection",
          async () => {
            await api("connections/update", { id: p.id, enabled: true });
            await renderConnections();
          },
          "secondary",
        ),
      );
      card.append(
        button(
          "Delete retained history",
          async () => {
            if (
              !confirm(
                "Delete live retained content for this disabled connection? Existing history references will stop working. Account pins and operation fences remain.",
              )
            )
              return;
            await api("retention/delete", { id: p.id });
            notice.textContent =
              "Retained live content deleted. Operator backups follow their separate retention policy.";
          },
          "secondary",
        ),
      );
    }
    const edit = el("details");
    edit.append(
      el("summary", "Edit connection policy"),
      el(
        "p",
        "Candidate changes affect new branches. Existing conversations keep their admitted account.",
        "muted",
      ),
    );
    const connectionId = field(edit, "Connection ID for installation setup");
    connectionId.value = p.id;
    connectionId.readOnly = true;
    const candidates = [];
    for (const account of accounts) {
      const row = el("label", undefined, "check"),
        checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.value = account.profileId;
      checkbox.checked = p.profiles.includes(account.profileId);
      row.append(checkbox, document.createTextNode(account.account.label));
      edit.append(row);
      candidates.push(checkbox);
    }
    const priority = el("p", "", "muted");
    const showPriority = () => {
      const selected = candidates.filter((value) => value.checked).map((value) => value.value);
      const order = [...p.profiles.filter((id) => selected.includes(id)), ...selected.filter((id) => !p.profiles.includes(id))];
      priority.textContent = "Effective priority: " + order.map((id, index) => `${index + 1}. ${accounts.find((a) => a.profileId === id)?.account.label ?? id}`).join(" → ");
    };
    candidates.forEach((checkbox) => checkbox.addEventListener("change", showPriority));
    showPriority();
    edit.append(priority);
    const allowed = field(edit, "Allowed models for " + p.name);
    allowed.value = p.allowedModels.join(", ");
    edit.append(
      button(
        "Save policy",
        async () => {
          const selected = candidates.filter((value) => value.checked).map((value) => value.value);
          const profiles = [
            ...p.profiles.filter((id) => selected.includes(id)),
            ...selected.filter((id) => !p.profiles.includes(id)),
          ];
          if (!profiles.length || (p.mode === "fixed" && profiles.length !== 1))
            throw Error(
              "Choose exactly one account for a fixed connection, or at least one pool candidate.",
            );
          await api("connections/update", {
            id: p.id,
            profiles,
            allowedModels: allowed.value
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          });
          await renderConnections();
        },
        "secondary",
      ),
    );
    card.append(edit);
    content.append(card);
  }
  const form = el("div", undefined, "card form");
  form.append(el("h2", "Create an Agents connection"));
  const name = field(form, "Connection name");
  name.value = "Codex Wire";
  const selection = el("div");
  const choices = [];
  for (const a of accounts) {
    const l = el("label", undefined, "check"),
      c = el("input");
    c.type = "checkbox";
    c.value = a.profileId;
    l.append(c, document.createTextNode(a.account.label));
    selection.append(l);
    choices.push(c);
  }
  form.append(selection);
  const advanced = el("details");
  advanced.append(el("summary", "Advanced policy"));
  const installation = field(
      advanced,
      "Installation ID matching the context configuration (required for a pool)",
    ),
    models = field(
      advanced,
      "Allowed model IDs, comma-separated (blank allows compatible catalog models)",
    );
  advanced.append(
    el(
      "p",
      "Explicit store:false requests retain no conversation content. Operation safety records remain separate.",
      "muted",
    ),
    el(
      "p",
      activity.contextQualified
        ? "Model Request Context v1 is enabled."
        : "Full pools are unavailable until the matched lifecycle integration is qualified.",
      "muted",
    ),
  );
  form.append(advanced);
  const consent = el("label", undefined, "check"),
    check = el("input");
  check.type = "checkbox";
  consent.append(
    check,
    document.createTextNode(
      "Allow encrypted conversation storage: " +
        activity.retention.idleDays +
        " days after use, up to " +
        activity.retention.absoluteDays +
        " days.",
    ),
  );
  form.append(
    consent,
    button("Create connection", async () => {
      const profiles = choices.filter((c) => c.checked).map((c) => c.value);
      const result = await api("connections", {
        name: name.value,
        mode: profiles.length > 1 ? "pool" : "fixed",
        profiles,
        allowedModels: models.value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        ...(installation.value ? { installationId: installation.value } : {}),
        localContinuityConsent: check.checked,
      });
      await showBundle(result.deliveryId);
    }),
  );
  const workflow = el("details");
  workflow.append(el("summary", "Connect existing workflows"));
  const instance = field(workflow, "Instance ID from About n8n"),
    connectionIds = field(
      workflow,
      "Connection IDs allowed to use lifecycle context, comma-separated",
    );
  workflow.append(
    el(
      "p",
      "Copy the Instance ID from About n8n. Use the same ID in the connection policy and lifecycle context configuration when sharing this installation key. Keep existing Profile ID and Binding Secret fields. Set N8N_CODEX_MODE=gateway, the gateway URL and protected installation token file; remove profile store and master-key access from n8n.",
      "muted",
    ),
    button(
      "Create installation key",
      async () => {
        const result = await api("installations", {
          installationId: instance.value,
          profiles: choices.filter((c) => c.checked).map((c) => c.value),
          connections: connectionIds.value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
          allowReset: false,
        });
        await showBundle(result.deliveryId);
      },
      "secondary",
    ),
  );
  form.append(workflow);
  content.append(form);
  const admin = el("details");
  admin.append(
    el("summary", "Connect the operator command-line helper"),
    el(
      "p",
      "The helper uses a separate administrator key. Keep it in a protected file and never place it in an inference credential.",
      "muted",
    ),
    button(
      "Create administrator key",
      async () => {
        const result = await api("administrators", {});
        await showBundle(result.deliveryId);
      },
      "secondary",
    ),
  );
  content.append(admin);
  const resume = el("div", undefined, "card form");
  resume.append(el("h2", "Resume interrupted setup"));
  const pending = (await api("deliveries")).deliveries;
  if (revision !== renderRevision) return;
  for (const delivery of pending) {
    const row = el("div", undefined, "row");
    row.append(
      el(
        "span",
        delivery.name +
          " · " +
          delivery.kind +
          (delivery.kind === "account" && !delivery.connected
            ? " · Connection not complete"
            : ""),
      ),
      button("Open setup", () => showBundle(delivery.id), "secondary"),
    );
    resume.append(row);
  }
  if (pending.length) content.append(resume);
  const recovery = el("details");
  recovery.append(el("summary", "Advanced setup recovery"));
  const id = field(recovery, "Pending delivery ID");
  recovery.append(
    button("Open protected bundle", () => showBundle(id.value), "secondary"),
  );
  content.append(recovery);
}
async function renderActivity() {
  const revision = heading(
    "Activity & settings",
    "Operational status without a prompt or reasoning viewer. Account refreshes and spending actions are deliberate.",
  );
  const currentActivity = await api("activity");
  if (revision !== renderRevision) return;
  activity = currentActivity;
  const c = el("div", undefined, "card");
  c.append(
    el("h2", "Gateway status"),
    el("div", String(activity.activeRequests) + " active requests", "metric"),
    el("p", activity.usageCoverage, "muted"),
    el(
      "p",
      "History retention: " +
        activity.retention.idleDays +
        " days after use, up to " +
        activity.retention.absoluteDays +
        " days.",
      "muted",
    ),
    el(
      "p",
      "Unknown outcomes require deliberate recovery. Deleting live history cannot erase copies in operator-managed backups.",
      "muted",
    ),
  );
  const limits = el("details");
  limits.append(
    el("summary", "Advanced limits"),
    el(
      "p",
      "Configured in the protected operator file. Restart the gateway to apply changes.",
      "muted",
    ),
  );
  limits.append(
    el(
      "p",
      "Admission: " +
        activity.limits.admission.active +
        " active, " +
        activity.limits.admission.account +
        " per account, " +
        activity.limits.admission.queued +
        " queued, " +
        activity.limits.admission.waitMs / 1000 +
        " seconds maximum wait.",
    ),
  );
  limits.append(
    el(
      "p",
      "Encrypted state budget: " +
        activity.limits.state.globalBytes / 1024 ** 2 +
        " MiB total, " +
        activity.limits.state.connectionBytes / 1024 ** 2 +
        " MiB per connection.",
    ),
  );
  limits.append(
    el(
      "p",
      "Fixed safety limits: 24-hour operation retry window; at least 48-hour outcome tombstones. Wire and memory ceilings are documented separately.",
      "muted",
    ),
  );
  c.append(limits);
  content.append(c);
  const credentials = el("div", undefined, "card");
  credentials.append(
    el("h2", "Connection access keys"),
    el(
      "p",
      "Only identifiers and scopes are shown. Revocation is immediate for new requests; it does not reveal or recreate a secret.",
      "muted",
    ),
  );
  const keys = (await api("keys")).keys;
  if (revision !== renderRevision) return;
  for (const key of keys) {
    const row = el("div", undefined, "actions");
    row.append(
      el(
        "span",
        key.role +
          " · " +
          key.id +
          " · " +
          (key.revoked
            ? "Revoked"
            : key.active
              ? "Active"
              : "Awaiting acknowledgement"),
      ),
    );
    if (!key.revoked)
      row.append(
        button(
          "Revoke " + key.id,
          async () => {
            if (
              !confirm(
                "Revoke this " +
                  key.role +
                  " key? Its client will lose access. This cannot be undone.",
              )
            )
              return;
            await api("keys/revoke", { id: key.id });
            await renderActivity();
          },
          "secondary",
        ),
      );
    credentials.append(row);
  }
  content.append(credentials);
  const rows = activity.recent || [];
  if (rows.length) {
    const card = el("div", undefined, "card activity-table"),
      table = el("table"),
      head = el("tr");
    for (const name of [
      "Time",
      "Model",
      "Input",
      "Cached input",
      "Output",
      "Reasoning",
    ])
      head.append(el("th", name));
    table.append(head);
    for (const entry of rows) {
      const value = entry.value,
        usage = value.usage || {},
        row = el("tr");
      for (const cell of [
        new Date(value.at).toLocaleString(),
        value.model,
        usage.inputTokens ?? "Unknown",
        usage.cachedInputTokens ?? "Unknown",
        usage.outputTokens ?? "Unknown",
        usage.reasoningOutputTokens ?? "Unknown",
      ])
        row.append(el("td", String(cell)));
      table.append(row);
    }
    card.append(
      el("h2", "Recent reported usage"),
      el(
        "p",
        "Provider-reported tokens from completed gateway Responses. Other sessions and missing counters remain unknown.",
        "muted",
      ),
      table,
    );
    content.append(card);
  }
}
document
  .querySelectorAll("nav button")
  .forEach((b) =>
    b.addEventListener("click", () =>
      navigate(b.dataset.view).catch(showError),
    ),
  );
document.getElementById("logout").addEventListener("click", async () => {
  const pending = api("logout", {});
  loggingOut = true;
  loggedOut = true;
  sessionRevision++;
  navigationRevision++;
  renderRevision++;
  csrf = "";
  view = "signed-out";
  clearTimeout(deviceTimer);
  document.getElementById("delivery").close();
  document.getElementById("logout").hidden = true;
  heading("Signing out…", "Closing the protected account console.");
  try {
    await pending;
  } catch (error) {
    showError(error);
  } finally {
    loggingOut = false;
    await login(true);
  }
});
document.getElementById("reveal").onclick = () => {
  const input = document.getElementById("secret");
  input.type = input.type === "password" ? "text" : "password";
  document.getElementById("reveal").textContent =
    input.type === "password" ? "Show" : "Hide";
};
document.getElementById("delivery").addEventListener("close", () => {
  bundle = "";
  deliveryId = "";
  document.getElementById("secret").value = "";
  document.getElementById("secret").type = "password";
  document.getElementById("reveal").textContent = "Show";
});
document.getElementById("copy").onclick = () =>
  navigator.clipboard.writeText(bundle).catch(showError);
document.getElementById("download").onclick = () => {
  const blob = new Blob([bundle], { type: "application/json" }),
    url = URL.createObjectURL(blob),
    a = el("a");
  a.href = url;
  a.download = "codex-wire-setup.json";
  a.click();
  URL.revokeObjectURL(url);
};
document.getElementById("acknowledge").onclick = async () => {
  try {
    await api("delivery/acknowledge", { id: deliveryId });
    bundle = "";
    document.getElementById("secret").value = "";
    document.getElementById("delivery").close();
    await navigate(view);
  } catch (e) {
    showError(e);
  }
};
navigate("accounts").catch(showError);
