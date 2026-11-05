# Changelog — Python SDK (`faultline_sdk`)

## [Unreleased]

### Changed (server side)

- **`claims_trending()` now needs a valid API key on the server.** The API's `GET /claims/trending` (and the other `/claims` routes) answered without a key until 2026-10-14; they now answer `401` without one. The client always sends `x-api-key`, so a client built with a valid key is unaffected; a client built with an empty or wrong key now gets `401` from this call. Since the per-caller claim index, results are the calling key's own claims only, and Gemini-grounded verdicts are never in them.

## [0.5.0]

Version in `pyproject.toml` before this changelog was started; earlier history is in git.
