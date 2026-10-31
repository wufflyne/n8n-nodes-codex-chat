# Account visibility and earned resets

Check Account is a local versioned result. Optional email and token plan metadata come only from verified access claims after signature/issuer/audience/client/expiry checks; the unverified ID token is ignored. Provenance/time are included. Fresh authenticated usage plan takes precedence. Generic Pro is never inferred to be a dollar tier or speed entitlement.

Get Limits shows ordinary and explicitly mapped additional buckets, flags, percentages, window durations/reset times, balance as provider decimal text and `Unit not reported`. Unknown is null. `allowed:true` at 100% is still permission; `allowed:false` at 0% is not availability. Exhaustion requires fresh explicit flags plus included `rate_limit_reached`. Spending/owner/member limits and unknown applicability cannot authorize failover or reset. Account-ID mismatch invalidates data.

Explicit Get Limits forces usage. Reset details default off; List Reset Credits fetches details. Models/Router may reuse at most 30-second usage data, with immediate invalidation at a passed reset time. Actions and post429 classification force authenticated reads no older than five seconds. All results show freshness; usage may have changed. No background polling occurs.

## Manual and automatic reset

Use Reset Credit selects a currently eligible `codex_rate_limits` allocation and requires **Allow This Step to Use One Reset Credit**. The workflow can act again on a scheduled/repeated execution within caps. One input item only. Allocation count is authoritative and can exceed listed details; unknown/unlisted allocations are never guessed.

Eligibility requires a valid granted/expiry interval, available status/count, known ordinary included allowance and an identifiable active window with observed usage or explicit denial. The reset endpoint does not require `allowed:false`: an opted-in automatic threshold of 0–1% can request a preemptive reset while inference is allowed. It does not guarantee the backend will reset anything. Only `reset`, `nothing_to_reset`, `no_credit`, `already_redeemed` are definite outcomes. Post-action reads begin after the definite outcome and cannot reuse pre-action pending reads, including across token renewal. Late older reads cannot replace the newer cached limits. Every definite action refreshes limits; “Reset applied. Limits refreshed.” is warranted only when both actually happened.

Automatic Reset is off. When enabled, checks happen only at active model-call boundaries. Router defaults to trying other accounts first, deferring known low/exhausted candidates to a bounded second pass. Reset-first may request a reset before initial admission. An already pinned account can recover only itself. No accepted/ambiguous generation is repeated and n8n tools are never rerun by the adapter.

The cap is one action per native workflow execution across nodes/accounts, plus 1–3 issued/uncertain actions per provider account in 24 hours (default one). Duplicate profiles share account locks/caps. Other clients' actions are unknown. Native sub-workflows have distinct public execution IDs; no unsupported cross-parent cap is claimed. Templates do not multiply reset steps to bypass the boundary.

## Durable uncertainty

`resets/` is additive under the private profile store. Domain-separated encrypted account ledgers and execution reservations use the existing master key without changing it. They retain no tokens, bindings, email, prompts or tool content. Preserve each account's private `.initialized` marker with its ledger and all execution reservations. A missing established ledger blocks new actions; legacy reservation evidence also prevents treating missing history as a new account. The execution reservation is synced before POST; dispatch intent is synced before calling fetch. Crash/timeout/cancel after dispatch creates an uncertainty fence. A usage increase, missing credit or natural reset is not evidence of which action consumed the allocation.

Resolve Pending Reset selects no new allocation. It reuses exactly the stored redeem_request_id/credit_id, authenticated actor/account, original execution reservation and at most one attempt in an explicit execution. Minimum 30 seconds between attempts, maximum three total dispatches. Continued uncertainty stays blocked for provider/operator investigation. No “clear and spend again” operation exists. Prepared/orphan reservations are released only when an existing valid authoritative account ledger proves no dispatch. Corrupt/missing journals remain blocked.

Private directory locks are never stolen by age. After an actual crash, stop every store user and back up the complete store/key before inspecting/removing only a proven abandoned `.lock` directory. Never remove the encrypted ledger or import-renewal fence to force spending/rotation. Store-size bounds fail reset actions safely while ordinary inference remains available. Backups cannot reverse a provider reset; preserve the ledger alongside profiles through rollback/reupgrade.

This release implements no purchases, top-ups, reserve/extra-usage activation, billing settings or automatic image-quota resets. All release reset mutation tests use synthetic providers; actual entitlement/effects remain unverified.

Automatic recovery validates the complete local request before consuming a reset credit. Invalid tools, content, schema, affinity or request size therefore cannot spend a reset. After HTTP429, quota classification starts a new authenticated read after that rejection; an older in-flight usage response cannot authorize switching accounts or requesting recovery. Ordinary display reads still coalesce.

By [wufflyne](https://wufflyne.com).
