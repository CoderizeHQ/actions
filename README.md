# actions

Shared GitHub Actions workflows for CoderizeHQ repos: the checks every repo runs (`ci-site`, `ci-node`, `ci-tofu`,
`axe`), `deploy-preview` and `release`. Repos call them at the moving `v1` tag, which moves only after canary sites
pass. Plan: https://claude.ai/artifact/6E29RvZEoYpcNBBEDRc4gP (fresh start plan v2.0, Phase 3). Site facts, role names,
the storage layout and the manifest format come from platform's site contract.

Public on purpose: it holds no secrets, and the public `packages` repo can use the same checks.

## Workflows

Each runs on `vars.RUNNER_LABEL` (the org variable that moves every repo between the runner VM and GitHub-hosted
runners), falling back to `ubuntu-24.04`. Scripts live in `scripts/` and `release-check/`; a workflow asks GitHub which
commit of itself the run uses (the run's `referenced_workflows`) and loads its scripts from that same commit, so a site
pinned to `v1.2.3` runs `v1.2.3`'s scripts. Jobs that do that need `actions: read` from the caller.

| Workflow | Called by | Inputs | Caller grants | Trust it relies on |
| --- | --- | --- | --- | --- |
| `ci-site.yml` | every site PR | none | `contents: read` | Required by the `sites` ruleset ("ci / ci-site"). Lockfile changes without package.json pass only for Renovate's App on `renovate/**` |
| `axe.yml` | every site PR | `build-dir` (`dist`), `min-pages` (1) | `contents: read`, `actions: read` | None: no AWS, no secrets. Runs the PR's code |
| `deploy-preview.yml` | site, push to main | `site`, `build-dir` (`dist`), `max-delete-share` (`0.25`) | `contents: read`, `actions: read`, `id-token: write` | `coderizehq-preview-deploy-<site>` trusts only this file at `v1`/`v1.*`, from the site repo's main; `notify` uses `coderizehq-notify-send` (Notifications) |
| `release.yml` | site, version tag or weekly on main | `site`, `max-delete-share` (`0.25`) | `contents: read`, `pull-requests: read`, `checks: read`, `statuses: read`, `actions: read`, `deployments: write`, `id-token: write` | `coderizehq-live-publish-<site>` trusts only this file at `v1`/`v1.*`, in the `release` environment, from a version tag or main; `notify` uses `coderizehq-notify-send` |
| `ci-tofu.yml` | every platform PR | `roots` (platform's three); secrets `cloudflare-read-token`, `github-read-token` (both optional) | `contents: read`, `actions: read`, `id-token: write`, `pull-requests: write` | `coderizehq-infra-plan` in each account trusts only this file at `v1`/`v1.*`, from platform's PRs; it reads state and never writes or locks it |

Role ARNs are always derived from `site` (`arn:aws:iam::798070830797:role/coderizehq-preview-deploy-<site>`,
`arn:aws:iam::243891826043:role/coderizehq-live-publish-<site>`); no workflow takes an ARN as an input. `site` must be 1
to 38 of `a-z`, `0-9` and `-` (the role names must fit IAM's 64 characters).

### deploy-preview

1. `build` (no credentials): `pnpm install --frozen-lockfile`, `pnpm run build`, the build uploaded as an artifact. The
   lockfile's SHA-256 is taken before anything from the site runs.
2. `deploy` (the preview role; one queue per site, a running deploy is never cancelled, the newest waiting one wins):
   - stores the build in `coderizehq-previews-798070830797` at `_builds/<site>/<commit>/files/<path>`, every write
     `If-None-Match: *` with its SHA-256 checksum; an existing complete build for the commit (its `manifest.json` is
     there) is reused, not an error;
   - writes `_builds/<site>/<commit>/manifest.json` last (the contract's format, with `workflow_sha` from the job's OIDC
     token), then checks every stored file against it;
   - if the commit is still main's head, copies the stored build into `sites/<site>/` server-side, with Cache-Control
     by file type (a year, immutable, for hashed bundles in `_astro/` and `assets/`; 5 minutes for everything else),
     deletes what the build no longer has inside `sites/<site>/` only, and refuses to delete more than
     `max-delete-share` of the files (deleting 10 or fewer always passes);
   - invalidates `/sites/<site>/*` on the preview distribution only when something changed, and waits for it.
3. `notify` (only when `build` or `deploy` failed): emails ops@coderize.dev (see Notifications).

### release

1. `verify` (no AWS), through GitHub's API:
   - a version tag `vX.Y.Z`: `release-check` (the release App's merged `release-please--` PR whose merge commit is the
     tagged commit, opened by the release App, release files only, James's approval at its final commit, and the
     GitHub release made by the release App);
   - `refs/heads/main` (the weekly dependency run): `release-check/dependencyCheck.mjs`. Every commit since the last
     version release up to the run's commit must be the squash of a Renovate App PR from `renovate/**` with only
     Renovate's verified commits, changing only `pnpm-lock.yaml`, every version move minor or patch from the npm
     registry, all checks passed. Nothing new publishes nothing; anything else is left for James;
   - anything else is refused.
2. `publish` (the `release` environment, the live role; one queue per site):
   - finds the live distribution: the one whose Comment is exactly `<site>` (platform sets it), and the domain from
     its apex alias. The bucket is `coderizehq-live-<site>`. The site passes neither;
   - reads the manifest for the exact commit (waiting up to 20 minutes for deploy-preview to store it) and records a
     GitHub deployment to `live` whose payload names the commit, the release PR, the approver (or the Renovate PRs),
     the manifest's SHA-256 and the workflow commit;
   - downloads every stored file and checks its size and SHA-256 against the manifest;
   - copies each file with one CopyObject from `_builds/<site>/<commit>/files/` (the only writes the live role may
     make; never a multipart copy, which IAM refuses), deletes what the build doesn't have (same mass-delete guard),
     then checks the bucket holds exactly the build (sizes and MD5 ETags of the checked bytes);
   - invalidates `/*` and waits, then checks the live home page and robots.txt are this build's bytes, robots.txt
     doesn't block every crawler and names a sitemap on the site's own host, and the sitemap answers;
   - marks the deployment successful, or failed with the reason.
3. `notify`: emails ops@coderize.dev when `publish` succeeded, or when `verify` or `publish` failed (a refusal
   included, with its reasons). Nothing is sent when there was nothing to publish, or for a run on a ref release can
   never take (neither a version tag nor main).

### Notifications

Email only (James's call, C955 a), to ops@coderize.dev, from `CoderizeHQ <notify@notify.coderize.dev>` through SES in
the live account with the `coderizehq-notify` configuration set (bounces and complaints go to platform's feedback
topic). The `notify` jobs run `scripts/notify.mjs` as `arn:aws:iam::243891826043:role/coderizehq-notify-send`, fixed in
the workflows. platform's `aws/live/notify.tf` makes that role: it trusts only `deploy-preview.yml` and `release.yml`
at `v1`/`v1.*`, from a site repo (by id, from the site records) on main or a version tag, and may only call
`ses:SendEmail` from that address to that one recipient. The email is plain text: the site, ref, commit, each job's
result, the live URL and approval for a release, a refusal's reasons, and the run's link.

## Versions: releases, the canary and `v1`

Each merge to main is released by Release Please (`release-please-config.json`, `.release-please-manifest.json`),
which platform's `release-bootstrap` workflow runs for this repo as the release App: it keeps a `chore(main): release
1.x.y` PR open, and once James merges it, tags `v1.x.y` and makes the GitHub release. So PR titles here are
Conventional Commits (`feat:`, `fix:`; `feat!:` would be v2): the squash commit is what Release Please reads.

`v1` (what every site calls) moves only through `release-bootstrap`'s `tag-actions` job, and only to the newest
`v1.x.y` release after the canary passed for it:

1. A platform PR names the release in `release/canary.json`. Applying it rewrites `deploy-preview.yml` in each canary
   site (records with `"group": "canary"`) to call `deploy-preview.yml@v1.x.y`, and that commit runs it: a fresh build,
   stored and published to the site's preview by the candidate. The roles trust `@refs/tags/v1.*`, so nothing else
   changes.
2. `release-bootstrap`'s `canary` job (every 15 minutes) reads each canary site's deploy-preview runs that used the
   release's commit and sets the commit status `canary` on that commit here, as the release App: `success` when every
   canary site's latest such run passed, `failure` when any failed, `pending` until each has one.
3. `tag-actions` (James starts it) moves `v1` to the newest release's commit only if that release passes `release-check`
   (the code at the current `v1`), and its latest `canary` status from the release App is `success`. A failure, or
   no result yet, leaves `v1` where it is.

Moving `v1` back is `release-bootstrap`'s `rollback-actions` job: `v1` goes to the release before the one it points
at, and that release's `canary` status is set to `failure` (rolled back) so `tag-actions` won't move forward to it
again; the fix ships as a newer release. Moving `v1` redeploys nothing: platform's `docs/release-safety.md` has the
urgent-fix steps and the refusal drills.

### ci-tofu

`check`: `tofu fmt -check`, `tofu validate` per root, `node --test` (platform's trust-policy and other unit tests),
gitleaks over the full history. `plan`: per root, as the live account's `coderizehq-infra-plan` for the state (profile
`state`) and the root's own account's for its resources (profile `account`), `tofu plan -lock=false`. A root whose
provider needs a token the caller didn't pass (Cloudflare, GitHub) is skipped and says so. `comment`: one PR comment
with every plan, updated on each push.

### axe

Builds the site, serves the build the way live does (`/page` from `/page/index.html`, a missing page answers
`/404.html` with 404), and runs axe (Playwright and `@axe-core/playwright`, pinned in `pnpm-lock.yaml`) on every built
page in light and dark color schemes after the network is idle, against WCAG 2.2 AA with `target-size` enabled. It fails
on any violation, a page that doesn't answer 200, fewer pages than `min-pages`, or a sitemap URL with no built page.

## Other pieces

| Path | What |
| --- | --- |
| `release-check/` | The `release` check as a composite action (`uses: CoderizeHQ/actions/release-check@v1`), and the code release.yml verifies with |
| `.github/workflows/review-stub.yml`, `scripts/reviewStub.mjs` | The `review` check until the review service (Phase 5): every 5 minutes, as the `coderizehq-reviewer` App, from the `review` environment (main only) |
| `.github/workflows/test.yml` | Every `*.test.mjs`, including dry runs of deploy-preview and release against an in-memory S3 (`scripts/lib/memoryStore.mjs`) |

`v1` is moved only by `platform`'s `release-bootstrap` workflow (James starts it), as the release App, after the canary
(see Versions); the `tags` ruleset refuses everyone else.

## Not done yet

- The canary covers `deploy-preview` only; `release.yml`, `ci-site` and `axe` on the canary channel come later
  (platform's `docs/release-safety.md`).
- ci-tofu's plans of roots that use the Cloudflare or GitHub provider need read-only tokens passed as
  `cloudflare-read-token` and `github-read-token`; until then those plans are skipped.
- The runner VM (Phase 3): jobs need `gh`, `jq`, `curl`, `unzip` and, for axe, Playwright's system packages
  (`playwright install --with-deps`, which needs root) on its image.
