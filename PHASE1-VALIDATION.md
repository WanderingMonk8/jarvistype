# Phase 1 Validation Register

## Scope

Phase 1 replaces the diagnostic probe runtime with the JarvisType production foundation. The PRD remains authoritative; this register tracks the technical-foundation exit gate.

Current foundation version: `0.7.0`

## Implemented baseline

| ID    | Requirement                                        | Status         | Evidence                                                                                                                                        |
| ----- | -------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| F1-01 | Installable frontend and backend bundles           | LOCAL-PASS     | `npm test` builds both committed `dist` entries and validates the manifest.                                                                     |
| F1-02 | Versioned, discriminated frontend/backend protocol | LOCAL-PASS     | Protocol types and runtime validators cover health, cancellation, success, and typed error messages.                                            |
| F1-03 | Malformed and stale-message rejection              | LOCAL-PASS     | Validators reject malformed/future messages; the request registry accepts only matching pending request IDs.                                    |
| F1-04 | Request timeout and cancellation                   | LOCAL-PASS     | Timed-out frontend requests send cancellation; backend cancellation is accepted only for an active request.                                     |
| F1-05 | Readiness and cleanup                              | LOCAL-PASS     | Frontend defers readiness until listeners/UI exist and cleanup removes UI handles, subscriptions, DOM listeners, and pending timers.            |
| F1-06 | Recoverable backend-unavailable state              | LOCAL-PASS     | A timed-out or typed-error health request exposes a retry action without enabling product operations.                                           |
| F1-07 | Permission status and live refresh                 | LOCAL-PASS     | The shell reads only the declared `media` grant and refreshes on host permission events, activation, focus, and visibility.                     |
| F1-08 | Active-chat status                                 | LOCAL-PASS     | The shell reads the host active-chat identity without reading message content and refreshes on chat switches and activation.                    |
| F1-09 | Composition skeleton                               | LOCAL-PASS     | Drawer contains the private draft placeholder and disabled Record Message, Record Edit, Undo, History, and Confirm & Send controls.             |
| F1-10 | Automated quality pipeline                         | LOCAL-PASS     | Formatting, ESLint, strict TypeScript, protocol/domain and mocked-backend tests, builds, package validation, and GitHub Actions are configured. |
| F1-11 | Hosted Lumiverse lifecycle verification            | REMOTE-PENDING | Requires installation of `0.7.0` on Lumiverse 1.2.5.                                                                                            |

## Remote verification procedure

1. Update JarvisType from the `development` branch and verify version `0.7.0`.
2. Open **JarvisType** from the input-bar action. Confirm exactly one drawer opens and the command palette has only one JarvisType entry.
3. Confirm **Backend: Ready** and Lumiverse backend/frontend versions are displayed.
4. Confirm the selected chat identifier appears. Switch to another chat, reopen or reactivate JarvisType, and confirm the displayed identifier changes without reloading.
5. Confirm the media-permission line reflects its current grant. Revoke or grant the permission in Lumiverse, return focus to the page, and confirm the line updates without restarting the extension.
6. Confirm the working-draft placeholder and all five future feature controls are visible and disabled.
7. Narrow the drawer to the smallest supported width and confirm there is no horizontal overflow and status text wraps.
8. Use the command palette to open JarvisType, reload Lumiverse, and repeat. Confirm no duplicate drawer tab, input action, command entry, or event behavior appears.
9. Disable and re-enable the extension. Confirm the shell returns normally and the backend reaches **Ready**.

Do not test recording, drafting, editing, or sending in Phase 1; those controls are intentionally disabled.

## Exit gate

Phase 1 closes when F1-11 passes on the hosted installation and no critical lifecycle, protocol, permission, or accessibility defect remains.
