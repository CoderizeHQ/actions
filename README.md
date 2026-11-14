# actions

Shared GitHub Actions workflows for CoderizeHQ repos: the checks every repo runs (`ci-site`, `ci-node`, `ci-tofu`,
`axe`), `deploy-preview` and `release`. Repos call them at the moving `v1` tag, which moves only after canary sites
pass. Plan: https://claude.ai/artifact/6E29RvZEoYpcNBBEDRc4gP (fresh start plan v2.0, Phase 3).

Public on purpose: it holds no secrets, and the public `packages` repo can use the same checks.
