# Proposal: read-only ChatGPT conversation index and selected-chat recall

**Status:** Design discussion only. These interfaces are proposed, not available in the published package. This change adds no runtime behavior.

Before submitting an implementation, we would like maintainer feedback on whether this belongs in OMP Oracle, in a companion package, or outside the project's scope.

## Purpose: reuse existing threads and preserve Oracle continuity

Oracle already makes ChatGPT useful from an agent workflow. The opportunity here is to make that access useful for the conversations users already have, not only for new Oracle requests. A pre-existing thread can contain accumulated reasoning, decisions, constraints, research, and revisions that would be cumbersome to locate manually and reconstruct in another prompt.

The first goal is to streamline utilization of those threads: find a relevant conversation through a local metadata directory, retrieve its original visible discussion, and bring the relevant evidence into the current agent task. This should work for a chat begun directly in ChatGPT as well as one previously used through Oracle, rather than limiting recall to jobs created by the current local project.

The second goal is continuity across different Oracle clients, hosts, and platforms. A canonical ChatGPT conversation ID/URL can serve as a durable reference to the same remote thread when work moves between the ChatGPT interface and compatible Oracle integrations, such as OMP and `pi`, or between machines. The intention is to keep using the accumulated conversation when explicitly requested, instead of treating a client or platform change as a reason to start over in a disconnected chat.

For example, a user could explore a design in ChatGPT, retrieve its original decisions from an agent session, and later explicitly continue that same ChatGPT thread from another compatible Oracle client. Read-only retrieval and continuation are separate operations: retrieving existing evidence must not silently add a message, and continuing the thread requires an explicit request.

The portable reference is the remote conversation identity, not a copied browser profile, a local Oracle job ID, or a globally synchronized transcript cache. Each client still needs authorized access to the same account/workspace and its own supported transport; local index snapshots remain account/browser-scoped. This is a continuity goal, not a claim that cross-machine/platform behavior has already been implemented or validated, nor a promise to migrate arbitrary local agent state or conversations between ChatGPT and another provider.

Today, an agent can ask ChatGPT a question through Oracle, but discovering and retrieving an older discussion is a different operation. Starting another model turn to rediscover or summarize it adds a message and can confuse original evidence with a new answer. Explicit read-only discovery and retrieval provide the starting point for both goals, while preserving fresh-thread defaults when no existing thread is selected.

## Proposed interface

One new `oracle_index` tool and `/oracle-index` command, with four distinct actions:

| Action | Behavior | Network and persistence |
| --- | --- | --- |
| `refresh` | Explicitly enumerate conversation directory metadata from the authenticated ChatGPT account. | Browser-authenticated GET requests; atomically replace an account-scoped local metadata snapshot only after a successful refresh. |
| `search` | Find conversations by title, full/partial ID, or available project metadata. | Local snapshot search; not transcript-content search. |
| `status` | Report snapshot scope, freshness, and available metadata. | Local only. |
| `read` | Retrieve one explicitly selected, indexed conversation's current visible branch. | GET only that conversation; return a bounded transcript window. Do not add a message or cache a separate transcript. |

Proposed examples:

```text
/oracle-index refresh
/oracle-index search <title terms>
/oracle-index read <indexed-id-or-chatgpt-url> [offset] [max-chars]
```

This does not replace `oracle_read` job inspection/recollection. Existing Oracle jobs and arbitrary older ChatGPT conversations have different identities and should remain distinguishable.

If a user explicitly wants to ask a new question in the selected older chat, that remains a separate continuation operation which sends a message. Read-only recall must never silently become continuation. Fresh-thread defaults remain unchanged.

## Transport and ownership

A local prototype uses ChatGPT's private directory and conversation GET endpoints through the configured managed browser or Chrome relay. The access token stays inside the authenticated page. Every request is scoped to a newly owned, background tab; cleanup closes only that tab, not another Oracle job's tab or the user's session.

The first implementation would cover those managed/relay transports, not claim compatibility with seed-profile-only transport, Grok, or every browser/platform. Those limitations should be explicit at the tool boundary rather than hidden behind a fallback.

The directory is scoped to the browser source and authenticated user/workspace. Reading verifies that the live identity still matches the selected snapshot; switching accounts must not leak metadata or return a transcript from a different account.

## Directory versus transcript

The persisted directory would contain only identifiers, titles, canonical URLs, timestamps, archive state, and project association when available. It would not persist messages, snippets, cookies, or access tokens. Refresh would deduplicate paginated entries, handle active/archived listings, and preserve the old snapshot if a refresh fails.

`read` would require a full indexed ID or recognized ChatGPT conversation URL, not a guessed prefix or arbitrary external URL. It would follow the selected parent chain to the current node and return visible user/assistant content in order, excluding sibling regenerations, system/tool messages, and reasoning. Corrupt or mismatched selected history would fail explicitly instead of returning an apparently complete partial transcript.

Text windows would expose their offsets, total length, and continuation offset. Media and attachments would be labeled as omitted, not downloaded or represented as full fidelity exports. Retrieved content is untrusted data, not instructions. Returned text naturally enters the calling agent's normal session logs; “no separate transcript cache” does not mean “no transcript retention anywhere.”

## Limits and risks

- These are private ChatGPT web APIs, not a supported public history API. They can change or stop working.
- A directory snapshot is not a promise of exhaustive history. Search freshness and account scope must be visible.
- No transcript-wide history search, periodic background scraping, automatic model summarization, or bulk transcript export is proposed.
- Metadata itself is private. Local files should have restrictive permissions and must never enter repository archives or public validation artifacts.
- Reading is not a new ChatGPT inference request, but it still accesses a remote authenticated service and can encounter authentication failures, rate limits, and browser challenges.

## Packaging question

Our current preference is an opt-in addition to OMP Oracle because the transport already needs Oracle's authentication, browser leases, tab ownership, and account configuration. A standalone `oracle-index` repository would give it an independent lifecycle, but the current prototype cannot simply be copied out as a self-contained package: it imports those existing host facilities.

If a companion package is preferred, we would first agree a narrow supported integration boundary rather than duplicate authentication/browser machinery or depend on undocumented deep imports. This proposal does not create that boundary or commit the project to supporting one.

## Existing local evidence and proposed contribution scope

A local prototype has exercised metadata refresh/search and selected-conversation read in an isolated OMP session, without posting a ChatGPT message. A before/after metadata-file digest stayed unchanged during read. Focused helper/service checks and the local validation ladder were also exercised. That evidence supports the workflow, not broad platform or account coverage; private conversation data is intentionally not included here.

If the direction is welcome, the implementation contribution would include the scoped tool/command, account/transport checks, bounded selected-branch retrieval, behavioral tests, user documentation, and sanitized verification evidence. It would exclude unrelated browser/auth changes currently present in the development checkout.

## Maintainer questions

1. Is streamlined reuse of pre-existing ChatGPT threads, with an explicit conversation identity for continuity across Oracle clients/platforms, useful and in scope for OMP Oracle?
2. Would you prefer an integrated opt-in tool, a companion package, or no addition here?
3. Is the explicit private-API dependency acceptable with the limitations above, and is managed/relay-only coverage a reasonable initial supported scope?
4. Does `oracle_index` with separate `refresh/search/status/read` actions fit the tool surface, or would a different boundary be preferable?

Related project contracts: [Architecture](ARCHITECTURE.md), [Security model](SECURITY.md), [Compatibility](COMPATIBILITY.md), and [Upstream](UPSTREAM.md).
