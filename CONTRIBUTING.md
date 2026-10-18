# Contributing to JarvisType

## Setup

Use Node.js 22 or newer and install the locked dependencies:

```bash
npm ci
```

Run the complete local quality gate before committing:

```bash
npm test
```

Use `npm run format` to apply the repository formatting rules.

## Architecture rules

- Treat `PRD.md` as the product source of truth and `ROADMAP.md` as the delivery sequence.
- Keep frontend/backend messages in the versioned protocol module and validate both directions.
- Keep the unsent draft outside Lumiverse chat until the user explicitly confirms submission.
- Never let a language-model response mutate draft text directly.
- Preserve user work on every recoverable failure path.
- Do not log raw audio, full private drafts, conversation context, or credentials.

## Pull requests

Describe the relevant phase and PRD requirements, include automated tests, and identify any manual Lumiverse verification still required. Commit generated `dist` entry files with source changes so remote installations do not depend on a local build environment.
