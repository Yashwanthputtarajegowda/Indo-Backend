# Indo Backend Canonical Base

This repository's `main` branch is the only supported backend base.

## Rules for future updates

1. Build every backend change from the current canonical files on `main`.
2. Do not restore, copy, or reintroduce legacy route/service implementations from historical commits or temporary bootstrap code.
3. Keep one canonical implementation per active API capability; do not create versioned route/service snapshots as a new source of truth.
4. Preserve the current API contracts used by the frontend unless a requested feature explicitly changes them.
5. Keep production data semantics canonical and backward-compatible with the current live application.
6. Before release, verify the server starts, authentication works, profile/social APIs work, media engagement works, notifications work, and deployment health checks pass.

## Baseline

This file marks the current `main` state as the permanent backend starting point for the next feature update. Historical commits are reference history only, not implementation sources.
