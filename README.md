# actions

Shared GitHub Actions workflows for CoderizeHQ repos: the checks every repo runs (`ci-site`, `ci-node`, `ci-tofu`,
`axe`), `deploy-preview` and `release` for sites, and `build-app-image` and `deploy-app` for apps on the app
server. Repos call them at the moving `v1` tag, which moves only after canary sites
pass. Plan: https://claude.ai/artifact/6E29RvZEoYpcNBBEDRc4gP (fresh start plan v2.0, Phase 3). Site facts, role names,
the storage layout and the manifest format come from platform's site contract.

## Why this repo is public

CoderizeHQ repos are private except two: `packages` (public so npm can show provenance) and this one, which stays
public on purpose (James's call, C1072, 2026-11-16):

- **The workflows need it.** Every shared workflow checks out `CoderizeHQ/actions` partway through a run, with the
  caller's own `GITHUB_TOKEN`, to load its scripts at the same version as the workflow: axe, ci-node, ci-site,
  ci-tofu, deploy-preview and release. A caller's token can read a public repo but not another private one. Making
  this repo private would break every site's CI, deploys and releases, and platform's plans. The fixes are worse:
  - a read credential for this repo in every caller, which would put an App key within reach of PR code;
  - or a redesign. A static `uses:` can't pin the scripts to the workflow's own version.
- **Nothing in it is secret.** It holds workflow code, scripts and gitleaks rules: no keys, no tokens, no client
  data. Roles and secrets are named, never stored. Each AWS role these workflows use trusts only its own workflow
  file here at `v1` (`job_workflow_ref`), run from a named CoderizeHQ repo (org and repo ids, on `main`; platform's
  `aws/trust/`), so a copy of this repo elsewhere gets nothing.
- **It's kept safe by:**
  - the `protected` ruleset: changes only by reviewed PR, the review gate, and James's approval;
  - the `tags` ruleset: only the release App moves `v1`;
  - gitleaks on every PR;
  - Renovate's pins: third-party actions by commit SHA.
- **The public `packages` repo uses the same checks,** which also requires this repo to be readable.

Revisit this only if GitHub lets a private repo's workflows check out another private repo in the same org with the
caller's token.

## Workflows

Each runs on `vars.RUNNER_LABEL` (the org variable that moves every repo between the runner VM and GitHub-hosted
runners), falling back to `ubuntu-26.04`. Scripts live in `scripts/` and `release-check/`; a workflow asks GitHub which
commit of itself the run uses (the run's `referenced_workflows`) and loads its scripts from that same commit, so a site
pinned to `v1.2.3` runs `v1.2.3`'s scripts. Jobs that do that need `actions: read` from the caller. Jobs run Node 26
(`runtime: node@26`), the LTS line STANDARDS.md 3 names.

The checks reach PRs through platform's rulesets ("Require workflows to pass"), not through each repo's own workflow
files, so a PR can't change or skip them: the `sites` ruleset runs `site-checks.yml` and the `platform` ruleset runs
`platform-checks.yml`, both from this repo at `refs/tags/v1`. GitHub runs them in the PR's repo, with that repo's
secrets. Each wrapper calls the shared workflows at `@v1` by full name, so job names (`ci / ci-site`, `axe / axe`) and
OIDC claims (`job_workflow_ref` `…/ci-tofu.yml@refs/tags/v1`) are the same as when a repo calls them itself. Because
rulesets pin `v1`, **every file a ruleset names must exist on `v1` before the ruleset that names it is applied**: a
required workflow that isn't there blocks every PR it covers.

| Workflow | Called by | Inputs | Caller grants | Trust it relies on |
| --- | --- | --- | --- | --- |
| `site-checks.yml` | the `sites` ruleset, every site PR | none (a ruleset workflow takes none) | (sets its own) | Calls `ci-site` and `axe`; skips itself on this repo's own PRs |
| `platform-checks.yml` | the `platform` ruleset, every platform PR | none | (sets its own) | Calls `ci-tofu` with platform's two read-only secrets, by name |
| `ci-site.yml` | `site-checks.yml` | `build-dir` (`dist`) | `contents: read`, `actions: read` | Required by the `sites` ruleset ("ci / ci-site"). Lockfile changes without package.json pass only for Renovate's App on `renovate/**` |
| `ci-node.yml` | a Node repo's ci.yml (this repo's own `ci.yml`, by path) | `test-database` (optional) | `contents: read`, `actions: read` | None, or with `test-database` the `NEON_CI_API_KEY` secret the caller passes: a key scoped to the CI Neon project only |
| `axe.yml` | `site-checks.yml` | `build-dir` (`dist`), `min-pages` (1) | `contents: read`, `actions: read` | Required by the `sites` ruleset ("axe / axe"). No AWS, no secrets. Runs the PR's code |
| `deploy-preview.yml` | site, push to main | `site`, `build-dir` (`dist`), `max-delete-share` (`0.25`) | `contents: read`, `actions: read`, `id-token: write` | `coderizehq-preview-deploy-<site>` trusts only this file at `v1`/`v1.*`, from the site repo's main; `notify` uses `coderizehq-notify-send` (Notifications) |
| `release.yml` | site, version tag or weekly on main | `site`, `max-delete-share` (`0.25`) | `contents: read`, `pull-requests: read`, `checks: read`, `statuses: read`, `actions: read`, `deployments: write`, `id-token: write` | `coderizehq-live-publish-<site>` trusts only this file at `v1`/`v1.*`, in the `release` environment, from a version tag or main; `notify` uses `coderizehq-notify-send` |
| `build-app-image.yml` | an app repo, every PR and push to main | `app`, `package`, `entry` | `contents: read`, `actions: read`, `id-token: write` | Builds the app's linux/arm64 image without Docker (crane on a pinned Node base); on main, `coderizehq-app-build-<app>` pushes it to ECR tagged with the commit. That role trusts only this file at `v1`/`v1.*`, from the app repo's main (platform `docs/apps.md`) |
| `deploy-app.yml` | an app repo, version tag or main | `app` | `contents: read`, `actions: read`, `id-token: write` | `coderizehq-app-deploy-<app>` trusts only this file at `v1`/`v1.*`, in the `release` environment, from a version tag or main; it may only run the app's own deploy document on the app server, read and tag its own ECR repository, and find the server |
| `ci-tofu.yml` | `platform-checks.yml` | `roots` (platform's four, `cloudflare/ai` planned offline); secrets `CLOUDFLARE_READ_TOKEN`, `PLATFORM_READ_APP_KEY` and the caller's variable `PLATFORM_READ_APP_CLIENT_ID` (all optional) | `contents: read`, `actions: read`, `id-token: write`, `pull-requests: write` | `coderizehq-infra-plan` in each account trusts only this file at `v1`/`v1.*`, from platform's PRs; it reads state and never writes or locks it |

Role ARNs are always derived from `site` (`arn:aws:iam::798070830797:role/coderizehq-preview-deploy-<site>`,
`arn:aws:iam::243891826043:role/coderizehq-live-publish-<site>`); no workflow takes an ARN as an input. `site` must be 1
to 38 of `a-z`, `0-9` and `-` (the role names must fit IAM's 64 characters).

### ci-site

In this order, so nothing from the site runs before the checks on its committed files:

1. the PR title is a Conventional Commit (`scripts/prTitle.mjs`; pull requests only);
2. gitleaks over the full history, with `config/gitleaks.toml` (gitleaks' defaults plus the fleet's extra rules; a
   repo's `.gitleaksignore` clears false positives);
3. a lockfile change needs a package.json change, unless it's Renovate's App on a `renovate/**` branch with only
   Renovate's commits (pull requests only);
4. `scripts/packageCheck.mjs`: no floating version specifiers (`latest`, `next`, `*`, `x`, an empty string, or a
   non-registry source; `workspace:`, `catalog:`, `link:`, `file:` are fine) in any package.json, and no
   package-lock.json, npm-shrinkwrap.json or yarn.lock;
5. every package.json in sort-package-json's order (`pnpm dlx sort-package-json@4.1.0 --check`);
6. `scripts/lockfileCheck.mjs`: every pnpm-lock.yaml entry from `registry.npmjs.org` (no tarball, git or folder
   sources) with a sha512 checksum that matches the one the registry publishes for that version, and no `.npmrc`
   registry but npm's;
7. `scripts/auditCheck.mjs`: `pnpm audit` at moderate and above. Ignores go in the repo's `audit-ignore.json`, each
   `{ "id": "GHSA-…", "reason": "…", "expires": "YYYY-MM-DD" }`; an expired one fails, and pnpm's own `auditConfig`
   is refused (it takes no reason or date);
8. `pnpm install --frozen-lockfile`, then Prettier (only with a Prettier config in the repo), ESLint (only with an
   `eslint.config.*`), `pnpm test` (only with a test script) and `pnpm run build`; a missing config or script is
   a notice, not a failure, until the site template (Phase 4) adds them;
9. `scripts/seoCheck.mjs` on the build: robots.txt present, not blocking every crawler, naming a sitemap in the
   build; every sitemap URL https on the host robots.txt names, built, indexable and without a trailing slash; one
   absolute https canonical per indexable page on that host, no trailing slash, not the home page's elsewhere; a
   non-empty, unique `<title>` per page; no internal link with a trailing slash.

### ci-node

The PR title, gitleaks, the audit (all as in ci-site), then install, ESLint (with a config) and tests (with a test
script). This repo's own `ci.yml` calls it by path, so its PRs run their own version of it, and their titles are
Conventional Commits too (Release Please reads them).

With `test-database: true` (an API whose tests need Postgres; STANDARDS.md 6, no Docker in jobs), a temporary branch
of the CI Neon project (organization variable `NEON_CI_PROJECT_ID`, no client data, its main an empty database) is
made before the tests and deleted after, whatever happened. The tests get `DATABASE_URL` (pooled) and `DIRECT_URL`,
masked; the repo's test setup migrates the empty database. Branches left by killed runs (`ci-` and over two hours
old) are swept at the start of each run (`scripts/neonTestBranch.mjs`).

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
     Renovate's verified commits, changing only `pnpm-lock.yaml` (and for a pnpm update package.json's
     `packageManager` line, to a minor or patch pnpm, nothing else in package.json), every version move minor or patch
     from the npm registry, all checks passed. The one other commit allowed is platform's file sync: written by the
     platform App through GitHub's API (committer web-flow, signed), one parent, no renames, and touching only platform's
     synced files that change neither the build nor the release (`CODEOWNERS`, `renovate.json`; platform's
     `tofu/sites.tf`). A sync of a workflow (`deploy-preview.yml` or `release.yml`) waits for James, because it changes
     how that commit is built or released.
     The run still publishes the build deploy-preview stored for the run's own commit, never a rebuild. A gap with no
     dependency update (nothing new, or platform syncs alone) publishes nothing; anything else is left for James;
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

`check`: the PR title, `tofu fmt -check`, `tofu validate` per root, `node --test` (platform's trust-policy and other
unit tests), gitleaks over the full history. `trust`: the live negative trust tests (`scripts/trustProbe.mjs`). The
job's own OIDC token (platform, a pull request, `ci-tofu.yml@refs/tags/v1`) calls `sts:AssumeRoleWithWebIdentity` on
every role it must never reach, and each must answer AccessDenied:

| Role | Refused because the token has |
| --- | --- |
| `coderizehq-preview-deploy-<site>`, every site | another repository (platform, not the site's), another workflow file (not `deploy-preview.yml`), a pull-request ref (not main) |
| `coderizehq-live-publish-<site>`, every live site (not a preview-only record, `"live": false`, which has none) | another repository, another workflow file (not `release.yml`), no `release` environment, a pull-request ref (not a version tag or main) |
| `coderizehq-infra-deploy`, each account | the right repository, but another workflow file (actions' `ci-tofu.yml`, not platform's `apply.yml`), no `apply` environment, not main |

Every attempt differs from its role's trust in more than one way, so this proves the deployed policies refuse a
platform PR; platform's `aws/trust/trust.test.mjs` proves each condition on its own against the templates (another
repository, a fork, another workflow file, a branch instead of a tag, a `v10` tag, the live role without the release
environment). An assumed role fails the job (its credentials are never read), and so does any other answer than
AccessDenied, a refused role that doesn't exist (checked with `iam:GetRole` as the plan role), or a control that
fails: the same token must assume `coderizehq-infra-plan` in each account through the same unsigned call. `plan`: per root, as the live account's `coderizehq-infra-plan` for the state (profile
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
| `.github/workflows/ci.yml` | This repo's own PR checks: `ci-node` by path. Its tests are every `*.test.mjs`, including dry runs of deploy-preview and release against an in-memory S3 (`scripts/lib/memoryStore.mjs`) |
| `config/gitleaks.toml` | The secret-scan rules every check runs gitleaks with |

`v1` is moved only by `platform`'s `release-bootstrap` workflow (James starts it), as the release App, after the canary
(see Versions); the `tags` ruleset refuses everyone else.

## Not done yet

- The canary covers `deploy-preview` only; `release.yml`, `ci-site` and `axe` on the canary channel come later
  (platform's `docs/release-safety.md`).
- ci-tofu's plans of roots that use the Cloudflare or GitHub provider need platform's `CLOUDFLARE_READ_TOKEN` and
  `PLATFORM_READ_APP_KEY` secrets and `PLATFORM_READ_APP_CLIENT_ID` variable (platform's README says what they are);
  until then those plans are skipped.
- ci-site's workflow standards check (each repo's files against the template) comes with the template in Phase 4.
- The runner VM (Phase 3): jobs need `gh`, `jq`, `curl`, `unzip` and, for axe, Playwright's system packages
  (`playwright install --with-deps`, which needs root) on its image; ci-tofu's `trust` job also needs the AWS CLI.
