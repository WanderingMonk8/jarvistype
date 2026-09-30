# Lumiverse host-managed STT invocation API proposal

## Status

- Proposed by: JarvisType
- Target: Lumiverse Spindle backend API
- Baseline tested: Lumiverse `1.2.4`, `lumiverse-spindle-types` `0.6.36`
- Related evidence: `PHASE0-VALIDATION.md`, run R-005

## Summary

Add a host-managed `spindle.stt` API that lets an extension invoke a user's existing Lumiverse speech-to-text connection without exposing its credentials.

Lumiverse currently lets extensions register an STT provider through `spindle.providers.register()` and receive host-originated invocations through `spindle.providers.handle()`. The inverse operation is missing: an extension cannot submit audio to the user's configured STT connection.

The proposed API follows the existing `spindle.imageGen` pattern:

- dedicated permission;
- redacted provider and connection discovery;
- one-shot and streaming operations;
- user-scoped connection resolution;
- host-side credential use;
- provider capability discovery;
- typed cancellation and errors.

## Motivation

Voice-composition extensions need to:

1. capture audio in an extension-owned interface;
2. submit that audio to the STT connection the user already configured in Lumiverse;
3. provide recent conversational context and vocabulary hints when supported;
4. display genuine provider partials when available;
5. cancel processing and reject late results;
6. receive a final transcript without reading the provider API key.

Without a host invocation API, an extension must either request a duplicate provider key, operate an external relay, or attempt to automate Lumiverse's native UI. Those alternatives weaken security, create duplicate configuration, or depend on unstable DOM behavior.

## Goals

- Reuse existing user-managed STT connections and credentials.
- Keep provider keys and provider authorization headers inside Lumiverse.
- Support completed staged uploads as the primary audio transport.
- Support genuine partial results without simulating them.
- Make provider feature support discoverable and auditable.
- Enforce user, extension, and upload ownership on every request.
- Work consistently across Spindle `process`, `sandbox`, and legacy `worker` runtimes.
- Provide enough functionality for JarvisType without coupling the API to JarvisType.

## Non-goals

- Managing or returning raw provider credentials.
- Allowing extensions to override arbitrary provider URLs or headers.
- Replacing `providers.stt.register`, which serves the opposite direction.
- Requiring every provider to support partials, context, keywords, or every audio format.
- Sending microphone-sized binary payloads through ordinary frontend/backend JSON messages.
- Defining browser microphone capture; that remains an extension/frontend responsibility.

## Permission model

Add a permission named `stt`.

```json
{
  "permissions": ["stt"]
}
```

`stt` permits an extension to:

- list redacted STT provider and connection metadata;
- use the current user's active or explicitly selected STT connection;
- submit extension-owned or user-accessible audio;
- receive transcript events and final results.

It does not permit an extension to:

- read API keys, authorization headers, secret references, or unrestricted connection metadata;
- create, update, or delete the user's connection;
- register an STT provider.

Provider registration remains separately gated by `providers.stt.register`.

## Host capability

Advertise the initial contract as:

```ts
spindle.host.capabilities['stt-invocation-v1'] === 1
```

Extensions must feature-detect this capability and provide a clear unsupported-host message when it is absent.

## Proposed backend API

The initial API is backend-only. An extension frontend records and stages audio, then sends only the upload identifier and bounded options to its backend. This preserves Lumiverse's credential boundary and avoids carrying audio bytes in ordinary extension messages.

`transcribeStream` means progressive provider output after a completed audio source is submitted. Continuous transcription while the microphone is still capturing would require a separate host-managed binary/live-session transport and is not required for this initial contract.

```ts
interface SpindleAPI {
  stt: {
    transcribe(input: SttTranscriptionRequestDTO): Promise<SttTranscriptionResultDTO>

    transcribeStream(
      input: SttTranscriptionRequestDTO,
    ): AsyncGenerator<SttStreamEventDTO, void, void>

    getProviders(userId?: string): Promise<SttProviderDTO[]>
    listConnections(userId?: string): Promise<SttConnectionDTO[]>
    getConnection(
      connectionId: string,
      userId?: string,
    ): Promise<SttConnectionDTO | null>
  }
}
```

For a user-scoped extension, Lumiverse infers the owning user. Operator-scoped extensions must supply `userId`, following existing Spindle conventions.

## Audio source

Reuse the established media-source shape, restricted to audio-capable sources:

```ts
type SttAudioSourceDTO =
  | {
      kind: 'upload'
      upload_id: string
      filename?: string
      mime_type?: string
    }
  | {
      kind: 'audio'
      audio_id: string
    }
  | {
      kind: 'inline'
      data: Uint8Array
      filename?: string
      mime_type: string
    }
```

`upload` should be the recommended source for browser recordings. Inline data should have a conservative host-configurable limit and is intended for small backend-generated samples.

The host must resolve uploads by authenticated user and extension ownership. The API must never accept a filesystem path or arbitrary remote URL.

The caller remains responsible for deleting its staged upload in `finally`. Transcription must not silently change upload lifetime.

## Request contract

```ts
type SttFeatureDTO =
  | 'partials'
  | 'context_prompt'
  | 'keywords'
  | 'language_hint'
  | 'punctuation'
  | 'word_timestamps'

interface SttTranscriptionRequestDTO {
  source: SttAudioSourceDTO

  // Omit to use the user's active/default STT connection.
  connection_id?: string

  language?: string
  context_prompt?: string
  keywords?: string[]
  punctuation?: 'auto' | 'enabled' | 'disabled'
  word_timestamps?: boolean

  // Fail before dispatch when these cannot be honored.
  require_features?: SttFeatureDTO[]

  // Host clamps this to an installation-wide maximum.
  timeout_ms?: number

  signal?: AbortSignal
}
```

`context_prompt` is free-form transcription context, such as a bounded selection of recent chat messages. `keywords` are literal vocabulary hints, such as glossary entries and proper nouns.

Provider adapters may map these fields into provider-specific constructs. They must report what was actually applied. If a requested item appears in `require_features` and cannot be honored, the host fails before sending audio.

## Redacted connection and provider metadata

```ts
interface SttCapabilitiesDTO {
  streaming_partials: boolean
  context_prompt: boolean
  keywords: boolean
  language_hint: boolean
  punctuation_control: boolean
  word_timestamps: boolean
  supported_mime_types: string[]
  supported_languages?: string[]
  max_audio_bytes?: number
  max_audio_duration_ms?: number
  max_context_chars?: number
  max_keywords?: number
}

interface SttProviderDTO {
  id: string
  name: string
  capabilities: SttCapabilitiesDTO
}

interface SttConnectionDTO {
  id: string
  name: string
  provider: string
  model: string | null
  is_default: boolean
  has_api_key: boolean
  capabilities: SttCapabilitiesDTO
}
```

These DTOs must not contain API URLs, headers, raw metadata bags, secret references, or credentials.

Capabilities should reflect the resolved provider/model combination, not just the provider's theoretical maximum.

## One-shot result

```ts
interface SttWordDTO {
  text: string
  start_ms: number
  end_ms: number
  confidence?: number
}

interface SttTranscriptionResultDTO {
  request_id: string
  text: string
  language?: string
  duration_ms?: number
  words?: SttWordDTO[]
  provider: string
  model: string | null
  applied_features: SttFeatureDTO[]
  unsupported_optional_features: SttFeatureDTO[]
}
```

The result identifies provider/model behavior for diagnostics but exposes no connection secret or provider request body.

## Streaming events

Mirror `spindle.imageGen.generateStream()` with an `AsyncGenerator`:

```ts
type SttStreamEventDTO =
  | {
      type: 'started'
      request_id: string
      provider: string
      model: string | null
      applied_features: SttFeatureDTO[]
      unsupported_optional_features: SttFeatureDTO[]
    }
  | {
      type: 'partial'
      request_id: string
      sequence: number
      segment_id: string
      text: string
      revision: number
    }
  | {
      type: 'final_segment'
      request_id: string
      sequence: number
      segment_id: string
      text: string
      revision: number
      words?: SttWordDTO[]
    }
  | {
      type: 'done'
      result: SttTranscriptionResultDTO
    }
```

### Event guarantees

- `started` is emitted at most once and precedes transcript events.
- `sequence` increases monotonically across transcript events.
- A partial replaces the prior text for the same `segment_id`; it is not implicitly appended.
- `revision` increases for each update to a segment.
- `final_segment` freezes that segment.
- `done.result.text` is authoritative and reconciles all final segments.
- Providers without genuine partials emit no `partial` events.
- The host must not manufacture timed partial events from a final transcript.
- Normal completion emits exactly one `done` event.
- Failure or cancellation terminates iteration by throwing a typed error and never emits `done`.

These rules let clients render partial text without duplication and distinguish real provider streaming from cosmetic animation.

## Example

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const controller = new AbortController()

try {
  const events = spindle.stt.transcribeStream({
    source: {
      kind: 'upload',
      upload_id: uploadId,
      mime_type: 'audio/webm;codecs=opus',
    },
    context_prompt: recentConversation,
    keywords: glossaryTerms,
    language: 'en',
    punctuation: 'enabled',
    require_features: ['context_prompt', 'keywords'],
    signal: controller.signal,
  })

  for await (const event of events) {
    if (event.type === 'partial') {
      sendPartialToFrontend(event)
    } else if (event.type === 'final_segment') {
      commitSegment(event)
    } else if (event.type === 'done') {
      acceptFinalTranscript(event.result.text)
    }
  }
} finally {
  await spindle.uploads.delete(uploadId)
}
```

## Cancellation and late results

- Aborting `signal` must cancel or detach the upstream provider request where technically possible.
- Iteration must terminate with error code `STT_ABORTED`.
- The host must discard provider events received after cancellation or terminal completion.
- Extension unload must abort outstanding requests owned by that runtime.
- Provider adapters must clean up sockets, response bodies, timers, and temporary conversion files.
- Cancellation must not automatically delete caller-owned staged uploads.

## Typed errors

```ts
type SttErrorCode =
  | 'STT_NO_ACTIVE_CONNECTION'
  | 'STT_CONNECTION_NOT_FOUND'
  | 'STT_CONNECTION_NOT_ACCESSIBLE'
  | 'STT_API_KEY_MISSING'
  | 'STT_UPLOAD_NOT_FOUND'
  | 'STT_UPLOAD_NOT_ACCESSIBLE'
  | 'STT_EMPTY_AUDIO'
  | 'STT_AUDIO_TOO_LARGE'
  | 'STT_AUDIO_TOO_LONG'
  | 'STT_UNSUPPORTED_AUDIO'
  | 'STT_FEATURE_UNSUPPORTED'
  | 'STT_PROVIDER_ERROR'
  | 'STT_RATE_LIMITED'
  | 'STT_TIMEOUT'
  | 'STT_ABORTED'
  | 'STT_INTERNAL_ERROR'

interface SttError extends Error {
  code: SttErrorCode
  retryable: boolean
  provider_status?: number
  unsupported_features?: SttFeatureDTO[]
}
```

Provider response bodies, request headers, and secrets must not be copied into extension-visible errors.

## Audio conversion

The STT dispatcher should use the host media pipeline when the selected provider cannot accept the supplied format:

1. inspect the source MIME type;
2. compare it with resolved connection capabilities;
3. convert only when necessary;
4. use a bounded temporary file or byte buffer;
5. delete conversion artifacts on success, failure, timeout, cancellation, and runtime unload;
6. report the effective MIME type in internal diagnostics, not transcript text.

An installation may require the existing `media` permission for explicit extension-driven conversion. Internal conversion performed as part of `stt` should not require a second permission because the extension receives neither the converted bytes nor a general media capability.

## Security and privacy requirements

- Resolve credentials exclusively from the selected Lumiverse connection.
- Never serialize credentials into a worker, frontend message, log, event, or error.
- Validate connection ownership for the authenticated user.
- Validate upload ownership for both user and calling extension.
- Dispatch only to the endpoint stored in the selected connection/provider adapter.
- Reject per-request URL, header, and authorization overrides.
- Apply provider allowlists, SSRF protections, timeouts, concurrency limits, and rate limits host-side.
- Redact transcripts, context prompts, keywords, filenames, and provider bodies from default logs.
- Expose usage telemetry only when separately documented and privacy-safe.
- Do not retain audio, context, keywords, or transcripts beyond provider processing and host operational requirements unless the user explicitly enables retention.
- Document which provider receives audio, context, keywords, and language hints.

## Limits

Recommended initial defaults:

| Item | Default |
|---|---:|
| Inline audio | 8 MiB |
| Staged-upload audio | 25 MiB |
| Context prompt | 16,000 characters |
| Keywords | 500 entries |
| Keyword length | 128 characters |
| Timeout | 120 seconds |
| Concurrent requests per extension/user | 2 |

All limits should be host-configurable and surfaced through typed validation errors. Provider-specific lower limits take precedence and should appear in resolved capabilities when known.

## Provider adapter requirements

Each built-in or registered STT adapter should normalize:

- accepted audio formats;
- batch versus genuine partial support;
- prompt/context mapping;
- keyword or keyterm mapping;
- language-code mapping;
- punctuation behavior;
- timestamp units;
- provider error classification;
- cancellation behavior;
- final transcript reconciliation.

Adapters must not claim a feature merely because the provider accepts an unstructured option. The adapter should have a tested mapping and report the feature in `applied_features` only when it was sent successfully.

## Compatibility and rollout

1. Add DTOs and `SpindleAPI.stt` to `lumiverse-spindle-types`.
2. Add the `stt` permission without changing `providers.stt.register`.
3. Advertise `stt-invocation-v1` only when the full contract is available.
4. Implement one-shot transcription first.
5. Add `transcribeStream` with the event guarantees above.
6. Expose redacted connection/provider discovery.
7. Document built-in adapter capability matrices.
8. Add a developer-guide page equivalent to Image Generation.

Hosts that lack the capability remain compatible; extensions feature-detect and disable configured-STT features with an actionable message.

## Acceptance tests

JarvisType probe `0.4.0` contains a forward-compatible executable version of these checks. It remains installable on older hosts because it does not request `stt` until `stt-invocation-v1` and the complete method surface are detected.

### Connection and permission

- An extension without `stt` receives the standard permission-denied error.
- A user-scoped extension can use only that user's connections.
- An operator-scoped extension must explicitly target an accessible user.
- DTOs contain `has_api_key` but never the key or raw metadata.
- Omitting `connection_id` selects the user's active/default STT connection.

### Upload isolation

- A calling extension can transcribe its own completed staged upload.
- Another extension cannot transcribe that upload.
- Another user cannot transcribe that upload.
- Missing, expired, partial, empty, and oversized uploads return distinct typed errors.

### Features

- Supported context and keywords appear in `applied_features`.
- Unsupported optional features appear in `unsupported_optional_features`.
- Unsupported required features fail before provider dispatch.
- Language and punctuation mappings are covered per adapter.

### Streaming

- Genuine provider partials arrive incrementally with monotonic sequence numbers.
- Revisions replace the matching segment rather than duplicating text.
- Final text reconciles with final segments.
- Batch-only providers emit no fake partials.
- Cancellation prevents late events from reaching the extension.
- Runtime unload cancels outstanding work and releases resources.

### Security

- Keys never appear in structured-clone messages, frontend traffic, logs, or errors.
- Request URL and headers cannot be overridden by the extension.
- Provider error bodies are redacted.
- Temporary conversion artifacts are removed on every terminal path.

## JarvisType exit criterion

JarvisType can treat the Lumiverse integration gap as resolved when a released host version:

1. advertises `stt-invocation-v1`;
2. transcribes an extension-owned WebM/Opus staged upload through the user's configured STT connection;
3. proves whether context, glossary hints, and genuine partials were applied;
4. aborts cleanly and rejects late results;
5. exposes no provider credential to the extension.

