# AI Gateway — Frontend Design Brief

**Audience:** Product, UX, and UI designers
**Document type:** Product and interaction requirements
**Status:** Based on the current implementation

## How to use this brief

This document explains what the AI Gateway console must help a user understand and do. It is not a visual design specification.

The designer may choose the visual language, information hierarchy, layout, navigation treatment, components, spacing, typography, colors, iconography, motion, responsive breakpoints, and interaction patterns. The brief does not require a particular visual style or a particular arrangement of controls.

The design should represent the capabilities and limits described here. It should not imply that an unsupported capability already exists.

## 1. Product purpose

AI Gateway is a small, self-hosted gateway for personal tools and agents. It gives an administrator one place to:

- keep provider API keys behind the gateway;
- map stable gateway model aliases to provider model IDs;
- grant each calling project access to selected models;
- provide project-specific connection information and tokens;
- observe calls, tasks, responses, timing, usage, and failures;
- test configured models and project permissions.

The current gateway supports two kinds of upstream work:

- LLM requests through OpenAI-compatible Chat Completions and Anthropic Messages;
- synchronous DashScope ASR transcription through a native JSON request.

The gateway is normally used as a local service and is prepared for a future single Linux server deployment. The console is an administrator-facing management surface. Calling projects use the API and do not receive console access.

## 2. Users and trust boundaries

### Administrator

The administrator configures connections, models, projects, permissions, and self-service application decisions. The administrator can inspect all request records and may explicitly retrieve a stored project token or provider token through the relevant protected action.

### Calling project or client

A project represents one calling application or agent, such as a coding assistant or writing tool. It authenticates with its own gateway token and can call only the models granted to it. A project token cannot read provider keys, change configuration, approve applications, or read historical request records.

### Self-service applicant

A client can submit an application through the public enrollment API. The gateway creates a disabled project and issues its token immediately, so the client can save its configuration before approval. The token becomes usable only after the administrator approves the application.

The current product has one administrator role. Do not introduce multi-user roles, teams, billing accounts, or organization management into the design unless the product scope changes.

## 3. Core concepts

The main relationship is:

**Provider connection → model mapping → project permission → request or task record**

### Provider connection

A connection identifies where a request is sent and which provider credential is used.

It contains:

- a user-defined connection name;
- provider type, such as Zhipu, MiniMax, DeepSeek, DashScope, or custom;
- one or more protocol-specific base endpoints;
- one encrypted provider token;
- enabled or disabled state.

Chat Completions, Anthropic Messages, and DashScope ASR are distinct protocols. A connection can expose only the protocols that are configured for it. The gateway does not convert Chat Completions into Messages or vice versa.

### Model mapping

A model is the stable name that a project uses while the gateway maps it to a provider model.

It contains:

- display name for the administration console;
- globally unique call alias, sent by clients as the `model` value;
- linked provider connection;
- upstream provider model ID;
- enabled protocols supported by this mapping;
- optional context-window declaration for LLM models;
- optional default parameters used only when a client omits them;
- enabled or disabled state.

The display name is administrative metadata. The call alias is part of client configuration. Changing the alias requires client configuration to be updated; changing the display name does not change authorization. A model can be available through both LLM protocols under one alias. ASR models use DashScope ASR and do not use LLM temperature, max-token, or thinking defaults.

### Project and permission

A project has one currently valid gateway token and a many-to-many set of model grants.

The administrator can:

- create, edit, enable, disable, and delete a project;
- grant or revoke individual model access;
- retrieve a protected copy of the current token;
- explicitly save an existing legacy token;
- rotate the token, which immediately invalidates the old token;
- copy protocol-specific endpoint and model configuration.

New projects have no model permission until the administrator grants one. A project can be enabled while a particular model or connection is disabled, but calls still fail until every required object and protocol is enabled.

### Request record

A request record is one gateway call. It can be an administrator model test, a project call, a streaming call, a non-streaming call, or a DashScope ASR call.

Depending on what was captured, a record may contain:

- project, model, connection, provider, and protocol;
- start time, duration, status, and error category;
- input and output content;
- time-to-first-token, time-to-first-content, and estimated output speed for applicable LLM calls;
- input, output, cached, or provider-reported usage values;
- original request and upstream response/event data;
- an indication that content is still being written, missing, or truncated;
- ASR audio duration, transcript, word timing, and hotword-related request data.

Audio payload data is removed from the stored request copy. The audio sent to the provider is unaffected.

### Task record

A task groups calls that share a reliable WorkBuddy request identity. A task represents one user question and can contain a main-agent call and sub-agent calls.

Calls without a reliable grouping identity remain visible in Request Records but are not guessed into a task. A task can therefore contain incomplete observations of a client-side process; the console must not imply that it knows unobserved steps.

## 4. Console areas

The design should cover the following areas. They may be presented as the designer considers appropriate, but each capability must remain discoverable and usable.

1. **Authentication and session state**
2. **Overview and monitoring**
3. **Task Records**
4. **Request Records**
5. **Provider Connections**
6. **Model Configuration**
7. **Project Permissions**
8. **Secondary flows and protected dialogs**

There is no separate public console for calling projects. Self-service enrollment is an API flow; the administrator sees its applications inside Project Permissions.

## 5. Authentication and session states

The console needs to communicate at least these states:

- first-time setup requiring an administrator password;
- normal locked state requiring the administrator password;
- authenticated management session;
- expired or invalid management session;
- local automatic-unlock mode, where the service is ready for calls and the management page may be opened without entering a password;
- logging out of the console.

Logging out revokes the current management session. It does not stop project API calls or lock the running gateway.

Invalid credentials and expired sessions need clear recovery actions. The interface must not display provider tokens or full project tokens as ordinary list data. Secret retrieval, token rotation, and legacy-token saving are explicit protected actions with clear consequences.

## 6. Overview and monitoring requirements

The overview should help an administrator answer: “Is the gateway working, how is it performing, and where should I investigate?”

The administrator needs to select a monitoring window of:

- the last hour;
- the last 24 hours;
- the last 7 days;
- all data since monitoring began.

The overview also needs filters for project, connection, model, and streaming mode. A visible refresh state is required because the page refreshes while it is open. If metric writes have failed, the page must say that statistics may be incomplete.

The monitoring content includes six metric groups:

- request outcomes: completed, failed, and canceled;
- first response timing: TTFT and TTFC;
- input and output token totals, with known-sample context;
- total duration;
- request volume and concurrency;
- estimated output speed.

The page also needs:

- a request trend over time;
- an error distribution;
- model-level performance comparison;
- a list of recent calls.

The user should be able to move from a recent call or model-level result to the relevant request information. Empty periods, no failures, unknown metrics, and partial monitoring data are normal states and need meaningful explanations.

## 7. Task Records requirements

Task Records show only calls with a reliable grouping identity.

The task list should expose enough information to choose what to inspect, including:

- the captured question excerpt;
- project and grouping source;
- task status;
- call count;
- failure count;
- known input/output usage and the number of known samples.

Task detail should provide:

- a conversation overview with the captured user question;
- the ordered call process, including main-agent and sub-agent calls;
- grouping metadata and the fields used to form the task;
- aggregate timing and usage for all saved calls in the task;
- access to each individual request detail.

The task status reflects only what the gateway observed:

- **In progress:** at least one grouped call is still running;
- **Replied:** the latest main-agent call completed with a normal assistant response and no tool call;
- **Waiting for follow-up:** the latest observation ended with a tool call, thinking-only content, truncation, no normal ending, or no captured main-agent response;
- **Call error:** the latest main-agent call failed. A later successful main-agent call can change the current status while the failure count remains.

The design must not present “replied” as proof that the client-side task is finished.

## 8. Request Records and request inspector requirements

Request Records show every saved request, including ungrouped calls and calls that also appear inside a task.

The list needs search and filters for at least:

- project, including administrator tests and deleted or unidentified historical projects;
- model;
- provider;
- result category, such as all, completed, or unfinished;
- keyword search across the available request summary.

Selecting a record opens an inspector that can represent an active request as well as a completed historical request. The inspector needs these information areas:

1. **Messages** — request messages and response content, with tool definitions, tool calls, and content blocks preserved.
2. **Response details** — parsed response information for LLM or ASR output.
3. **Raw data** — the project request and upstream response or SSE events, with copy actions.
4. **Performance and usage** — timing, cache read/write, TPOT where applicable, token and provider usage, and final result.

The inspector must communicate these conditions without treating them as the same thing:

- request is currently running;
- request completed normally;
- request was canceled, timed out, interrupted, rejected, or truncated;
- response content is missing but a monitoring summary exists;
- a stored record was truncated by the logging limit;
- a metric is unknown, not applicable, or explicitly zero;
- a request uses streaming, non-streaming, or an unrecorded mode.

For LLM calls, the interface should preserve the distinction between assistant text, thinking content, tool calls, and tool results. For ASR calls, it should show transcript, sentence/word timing when available, audio duration, and provider response or error without treating audio duration as token usage.

When the gateway applied a known provider compatibility transformation, the record should expose what field changed and the before/after values. The original client input remains the original input.

## 9. Provider Connections requirements

The connection area manages the destinations and provider credentials used by models.

The list needs to expose, at minimum:

- connection name and provider;
- configured protocols and their base endpoints;
- credential configured/not configured state;
- enabled/disabled state;
- actions to edit, replace or explicitly reveal a credential, disable, and delete.

Create and edit flows need to support:

- provider templates for Zhipu, MiniMax, DeepSeek, and DashScope;
- custom provider connections;
- independently enabling Chat Completions, Anthropic Messages, or DashScope ASR where supported;
- protocol-specific base endpoints;
- a provider token entered as a secret;
- enabled/disabled state.

The form must explain that a base endpoint excludes the final gateway call path. It must validate required fields and endpoint format. Saving configuration does not automatically make a provider request.

Deleting a connection is a destructive relationship change. Before it completes, the administrator must be able to understand:

- which models use the connection;
- which projects are indirectly affected through those models;
- whether to delete linked models one at a time or delete the connection and all linked models together;
- that historical project records remain.

The operation must handle a changed relationship list, cancellation, failure, and retry without silently deleting a different set of models.

## 10. Model Configuration requirements

The model area manages the stable aliases that clients call.

The list needs to expose:

- display name;
- call alias;
- provider model ID;
- linked connection;
- enabled protocols that are currently usable;
- context-window declaration for LLM models;
- enabled/disabled state;
- actions to edit, test, disable, and delete.

Create and edit flows need to support:

- choosing a configured connection;
- selecting one or more protocols that the connection exposes;
- manually entering the upstream model ID;
- optionally fetching a provider model catalog for a selected protocol;
- setting an optional context window for LLM models;
- setting optional default temperature and maximum-output values;
- configuring MiniMax-specific thinking defaults when the selected provider/protocol supports them;
- enabling or disabling the model.

Catalog results are suggestions from the provider, not proof of subscription entitlement or protocol compatibility. The administrator must remain able to enter the model ID manually.

The test action needs to make the following explicit before the call:

- which connection will be used;
- which upstream model ID will be called;
- which protocol will be tested;
- that a real provider test may consume quota;
- for ASR, which audio file and optional hotwords will be sent.

Test results need to show success, provider errors, gateway errors, and the returned content in a way that can be inspected without implying that saving configuration itself performed a test.

Changing a model alias affects client configuration. Changing the display name does not affect calls or grants. Deleting a model removes its project grants but leaves projects and historical requests available. A deleted alias can later be reused by a new model, which must start with new grants.

## 11. Project Permissions requirements

The project area is where the administrator manages calling identities and model grants.

The project list needs to expose:

- project name;
- token prefix or another non-secret identifier;
- granted model aliases;
- enabled/disabled state;
- pending, approved, or rejected enrollment state when an application is associated;
- actions for access information, project test call, edit, disable, and delete.

Create and edit flows need to support:

- project name;
- enabled/disabled state;
- selecting any number of configured models;
- clear explanation that unchecked models cannot be called;
- creation of a new token for a new project.

The access-information flow needs to let the administrator select a client protocol and then see/copy the correct endpoint, project token, and authorized model alias. It should support:

- Chat Completions;
- Anthropic Messages;
- DashScope ASR.

It must distinguish a base URL from a complete ASR transcription URL and explain the protocol-specific client expectation. A complete configuration copy is useful, but it must remain a deliberate action because it contains a secret.

Token behavior that the design must communicate:

- a newly generated token is shown at creation time and is encrypted for later administrator retrieval;
- an administrator may retrieve the current token through an explicit action;
- rotating the token invalidates the previous token immediately;
- a legacy project may need to have an existing full token saved before it can be retrieved later;
- a project token cannot read provider credentials or management data.

### Self-service applications

The project area also handles applications created by clients through the enrollment API.

An application can show:

- client name;
- requested protocol;
- requested models;
- optional note;
- creation time;
- current status.

Supported states are pending, approved, rejected, and disabled at the project level. A pending applicant already has a token, but the token must not call models until approval. Approval must re-check that requested models are still enabled and support the requested protocol. Rejection keeps the token unusable. The design should make the effect of each decision clear and should not suggest that the client needs a new token after approval.

## 12. Project test-call flow

The administrator can test a call using a real project identity from the request area or another appropriate entry point.

The flow needs to support:

- selecting a project or entering its full gateway token;
- selecting an authorized model;
- selecting a protocol available for that model;
- entering a short LLM message, or selecting an audio file and optional hotwords for ASR;
- starting a call;
- showing in-progress state;
- canceling an in-progress request where supported;
- showing returned text, transcription, or an actionable error.

The flow must distinguish administrator model tests from project-identity tests. A model test bypasses the project grant but still checks model and connection state; a project test uses the project token and performs the normal authorization path.

## 13. Shared states and content behavior

Every area needs a complete set of product states, including:

- loading;
- no data yet;
- no data matching the current filters;
- successful save or decision;
- field validation failure;
- unauthorized or expired session;
- forbidden action;
- provider or gateway failure;
- request timeout or cancellation;
- stale data requiring refresh;
- destructive confirmation;
- operation in progress;
- retry after an operation failed.

The interface should keep the user’s entered values when a recoverable save or network error occurs. For destructive operations, show the affected objects and the consequence before confirmation. Long names, long endpoints, long model IDs, large messages, and large raw payloads are expected and need a usable reading/copying path.

Status wording should distinguish configuration state from runtime result. For example, an enabled project is not proof that its last request succeeded; a configured model is not proof that the provider currently accepts it; a successful model test is not proof that every client or tool-call loop is compatible.

## 14. Terminology to preserve

Use these concepts consistently in labels and help text, even if the final wording is localized:

- **Provider connection:** destination and provider credential;
- **Provider token / provider key:** secret held by the gateway;
- **Model alias:** stable name sent by a client;
- **Upstream model ID:** provider’s actual model identifier;
- **Project token:** gateway credential held by one calling project;
- **Model grant / permission:** project access to a model;
- **Protocol:** Chat Completions, Anthropic Messages, or DashScope ASR;
- **Request:** one gateway call;
- **Task:** a reliable group of related requests;
- **Connection enabled / model enabled / project enabled:** independent configuration states;
- **Request status:** runtime result of one call.

Avoid using “provider,” “model,” “project,” and “task” interchangeably. They represent different objects.

## 15. Explicitly out of scope

The current frontend should not present the following as existing product features:

- automatic model routing or provider fallback;
- billing, cost accounting, quotas, or per-project rate limits;
- multi-user administration, teams, organizations, or role management;
- general-purpose secret vault references or vendor account management;
- Responses API, Realtime API, arbitrary protocol conversion, or async ASR jobs;
- image or video generation;
- client-facing historical request browsing;
- automatic conversation memory or context reconstruction;
- a promise of provider availability, subscription entitlement, or production performance;
- real Linux deployment management.

## 16. Suggested design deliverables

The designer should decide the visual and interaction solution, then cover the following deliverables:

- a navigable console concept for all console areas;
- the main success path: configure connection → create model → grant project access → copy access information → inspect a call;
- the enrollment path: pending application → approve or reject;
- the investigation path: overview → task/request → detailed call evidence;
- protected-secret flows for reveal, save, copy, and rotation;
- empty, loading, validation, error, confirmation, and in-progress states for each major area;
- a narrow-window/mobile-usable treatment for the workflows that can reasonably be performed away from a wide desktop screen;
- representative data for LLM, streaming, and ASR records.

The final design should let a reviewer verify that every current capability has a clear home, every destructive or secret-bearing action is understandable, and unsupported capabilities are not implied.

## 17. Source of truth

This brief is derived from the current project implementation and the following project documents:

- `README.md` for product scope and normal workflows;
- `HANDOFF.md` for current status and validation boundaries;
- `docs/current-architecture.md` for object relationships and request behavior;
- `docs/configuration-and-permissions.md` for connection, model, project, and token rules;
- `docs/project-enrollment.md` for self-service application behavior;
- `docs/workbuddy-tasks.md` for task grouping and status semantics;
- `docs/asr.md` for DashScope ASR behavior and storage limits.

If an existing screen and this brief disagree, confirm the behavior against the current API and implementation before inventing a new product rule.
