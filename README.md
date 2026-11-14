# actions

Shared GitHub Actions workflows for CoderizeHQ repos: the checks every repo runs (`ci-site`, `ci-node`, `ci-tofu`,
`axe`), `deploy-preview` and `release`. Repos call them at the moving `v1` tag, which moves only after canary sites
pass. Plan: https://claude.ai/artifact/6E29RvZEoYpcNBBEDRc4gP (fresh start plan v2.0, Phase 3).

Public on purpose: it holds no secrets, and the public `packages` repo can use the same checks.

## What's here (Phase 1 hard gate versions)

| Path | What |
| --- | --- |
| `.github/workflows/ci-site.yml` | The `ci-site` check site repos call (`uses: CoderizeHQ/actions/.github/workflows/ci-site.yml@v1`). For now: the gate-test switch and the lockfile rule |
| `release-check/` | The `release` check (a composite action, `uses: CoderizeHQ/actions/release-check@v1`): a release passes only if the release App made it from a merged Release Please PR that James approved at its head and that changed only the release files |
| `.github/workflows/review-stub.yml`, `scripts/reviewStub.mjs` | The `review` check until the review service (Phase 5): every 5 minutes, as the `coderizehq-reviewer` App, from the `review` environment (main only) |
| `.github/workflows/test.yml` | Unit tests for the two scripts' decisions |

`v1` is moved only by `platform`'s `release-bootstrap` workflow (James starts it), as the release App; the `tags`
ruleset refuses everyone else.
