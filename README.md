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
| `ci-site.yml` | `site-checks.yml`; platform's `app-checks.yml` per package site | `build-dir` (`dist`), `package` (empty), `indexed` (`true`) | `contents: read`, `actions: read` | Required by the `sites` ruleset ("ci / ci-site"). Lockfile changes without package.json pass only for Renovate's App on `renovate/**` |
| `ci-node.yml` | a Node repo's ci.yml (this repo's own `ci.yml`, by path) | `test-database` (`false`) | `contents: read`, `actions: read` | None: no AWS, no secrets. `test-database` uses a CI-only Postgres with no password |
| `axe.yml` | `site-checks.yml`; platform's `app-checks.yml` per package site | `build-dir` (`dist`), `package` (empty), `min-pages` (1), `pages-per-template` (3; 0 scans every page) | `contents: read`, `actions: read` | Required by the `sites` ruleset ("axe / axe"). No AWS, no secrets. Runs the PR's code |
| `deploy-preview.yml` | site, push to main; a site's rebuild workflow (Content rebuilds); a site's refresh and release workflows (Data refreshes) | `site`, `build-dir` (`dist`), `package` (empty), `max-delete-share` (`0.25`), `rebuild-commit` (empty; the rebuild and refresh workflows only), `refresh-lockfile-sha256` (empty; a data refresh's store only), `account` (`live`; `government` for a government site) | `contents: read`, `actions: read`, `id-token: write` | `coderizehq-preview-deploy-<site>` trusts only this file at `v1`/`v1.*`, from the site repo's main, and (for a refresh site's release storing its refresh) its version tags; `notify` uses `coderizehq-notify-send` (Notifications) |
| `release.yml` | site, version tag or weekly on main; a site's rebuild and refresh workflows | `site`, `max-delete-share` (`0.25`), `deployment` (`live`), `check-only`, `refresh` (`false`), `refresh-results` (empty), `account` (`live`; `government` for a government site); outputs `publish`, `commit`, `refreshable` | `contents: read`, `pull-requests: read`, `checks: read`, `statuses: read`, `actions: read`, `deployments: write`, `id-token: write` | `coderizehq-live-publish-<site>` trusts only this file at `v1`/`v1.*`, in the `release` environment, from a version tag or main; `notify` uses `coderizehq-notify-send` |
| `rebuild-target.yml` | a site's rebuild or refresh workflow (Content rebuilds, Data refreshes) | `site`, `deployment` (`live`); output `commit` | `contents: read`, `pull-requests: read`, `checks: read`, `statuses: read`, `actions: read`, `deployments: read` | None: no AWS, no writes. Finds the commit a content rebuild or data refresh builds |
| `refresh-build.yml` | a site's refresh and release workflows (Data refreshes) | `site`, `package` (empty), `build-dir` (`dist`), `commit`, `environment`, `secret-names`; output `lockfile-sha256`; `secrets: inherit` | `contents: read` | None: no AWS (no `id-token`), stores nothing. The only job a site's feed secrets reach, from its refresh environment, and only its build step |
| `build-app-image.yml` | an app repo, every PR and push to main | `app`, `package`, `entry` | `contents: read`, `actions: read`, `id-token: write` | Builds the app's linux/arm64 image without Docker (crane on a pinned Node base); on main, `coderizehq-app-build-<app>` pushes it to ECR tagged with the commit. That role trusts only this file at `v1`/`v1.*`, from the app repo's main (platform `docs/apps.md`) |
| `deploy-app.yml` | an app repo, version tag or main | `app` | `contents: read`, `actions: read`, `id-token: write` | `coderizehq-app-deploy-<app>` trusts only this file at `v1`/`v1.*`, in the `release` environment, from a version tag or main; it may only run the app's own deploy document on the app server, read and tag its own ECR repository, and find the server |
| `ci-tofu.yml` | `platform-checks.yml` | `roots` (platform's four, `cloudflare/ai` planned offline, `aws/live` planned at `-parallelism=30`); secrets `CLOUDFLARE_READ_TOKEN`, `PLATFORM_READ_APP_KEY` and the caller's variable `PLATFORM_READ_APP_CLIENT_ID` (all optional) | `contents: read`, `actions: read`, `id-token: write`, `pull-requests: write` | `coderizehq-infra-plan` in each account trusts only this file at `v1`/`v1.*`, from platform's PRs; it reads state and never writes or locks it |

Role ARNs are always derived from `site` (`arn:aws:iam::798070830797:role/coderizehq-preview-deploy-<site>`,
`arn:aws:iam::243891826043:role/coderizehq-live-publish-<site>`), and for a government site from `account` too
(`arn:aws:iam::355600359887:role/coderizehq-live-publish-<site>`; Government sites, below); no workflow takes an ARN as
an input. `site` must be 1 to 38 of `a-z`, `0-9` and `-` (the role names must fit IAM's 64 characters).

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
   non-empty, unique `<title>` per page; no internal link with a trailing slash. With `indexed: false` (noindex
   mode: only platform's `app-checks.yml` passes it, for a site whose record says `"indexed": false`, from the app
   repo's `SITE_PACKAGES` variable, which a PR can't change), robots.txt must instead disallow every crawler from the
   whole site and name no sitemap, the build has no `sitemap*.xml`, and pages need no canonical (one that is there is
   still checked); titles and links are checked as usual.

### ci-node

The PR title, gitleaks, the audit (all as in ci-site), then install, ESLint (with a config) and tests (with a test
script). This repo's own `ci.yml` calls it by path, so its PRs run their own version of it, and their titles are
Conventional Commits too (Release Please reads them).

With `test-database: true` (an API whose tests need Postgres; STANDARDS.md 6), the job makes an empty database for
itself just before the tests and drops it after them, whatever happened (`scripts/testDatabase.mjs`):

- **Where:** on the runner VM, the `test-db` container (CoderizeHQ/runners): Postgres 18, as in production, on a RAM
  disk, on the jobs network with no published port, reachable from job containers only. The autoscaler gives every job
  `CODERIZEHQ_TEST_DB`. On a GitHub-hosted runner (the `RUNNER_LABEL` fallback, and this repo's own CI) the step
  starts the image's own PostgreSQL 18 (`ubuntu-26.04`), listening on localhost only. Any other runner fails the step
  with what's missing, so `ci / ci-node` can't pass without the database.
- **Who:** the role `ci`: `LOGIN CREATEDB`, not a superuser, and no password. pg_hba trusts `ci` from the jobs network
  (or 127.0.0.1) and refuses every other role over the network. There is no secret to pass or to leak; nothing about
  the database needs masking in the log.
- **Separation, not isolation:** each job's database is `ci_<unix seconds>_<12 random hex>`, so concurrent jobs never
  share one by accident. They share the server and the role, so a job's own code could, on purpose, open, change or
  drop another running job's database, or fill the VM server's 1 GB RAM disk. What it can reach is other runs' test
  fixtures and CI's availability, nothing else: no client data, no credential, nothing outside the VM. Running code
  there at all takes push access to a private CoderizeHQ repo.
- **Cleanup:** the drop step runs `if: always()` (`DROP DATABASE ... WITH (FORCE)`). Before making its own, every job
  drops, best effort, every database `ci` owns that is over three hours old by its name, dated ahead, or not named
  like ours (only jobs make databases there). The database is made inside this job, whose timeout is 60 minutes, so
  runner queue time never counts. The VM's server keeps its data on a RAM disk, so a restart empties it.
- **The tests** get one URL as both `DATABASE_URL` and `DIRECT_URL` (there is no pooler). The repo's test setup
  must migrate the empty database; ci-node doesn't. **Nothing but test fixtures ever goes in it:** never a dump, a
  restore or a copy of a real database.

This repo's own `ci.yml` turns `test-database` on. This repo is public and `RUNNER_LABEL` reaches only private repos,
so its PRs run on GitHub-hosted runners and exercise the fallback end to end:
`scripts/testDatabase.test.mjs` checks the database it was given is empty, writable, Postgres 18, and not a superuser's.

### deploy-preview

1. `build` (no credentials): `pnpm install --frozen-lockfile`, `pnpm run build`, the build uploaded as an artifact. The
   lockfile's SHA-256 is taken before anything from the site runs.
2. `deploy` (the preview role; one queue per site, a running deploy is never cancelled, the newest waiting one wins):
   - stores the build in `coderizehq-previews-798070830797` (a government site: `coderizehq-gov-builds-355600359887`,
     Government sites below) at `_builds/<site>/<commit>/files/<path>`, every write
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

With `rebuild-commit` (a content rebuild, below), `build` first checks the run is the `content-rebuild` dispatch on main
and the input a 40-character SHA, then checks out and builds that commit instead of the run's; `deploy` stores it at
`_builds/<site>/<commit>/rebuilds/<run id>/` (the same write-once rules, its manifest naming the run and the content
hash), queued apart from push deploys (`deploy-preview-<site>-rebuild`), and leaves the preview alone. The OIDC token
still names the run's own commit, which the deploy role trusts as before.

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
   - `refs/heads/main` from the `repository_dispatch` `go-live-release` (a go-live release): platform's apply sends it,
     as the platform App (`coderizehq-platform[bot]`, the only sender accepted), with `client_payload.site` naming the
     site, for a site going live by an alias move whose new distribution has no aliases yet. It publishes main's head,
     so the site's first publish needs no release PR and no `Release-As` commit. `publish` refuses it for a
     distribution that serves any name, and checks that again right before it writes, so it lands only where the
     new distribution's own `*.cloudfront.net` name serves it (public, but linked from nowhere), never on the site's
     domain. The domain gets it only through James's alias move (platform's `alias-move.yml`), which checks that
     build first; from then on the site's releases are version releases as usual. A dispatch
     from anyone else, or naming another site, is refused, never taken for a dependency run;
   - `refs/heads/main` from the `repository_dispatch` `content-rebuild` (a content rebuild, below), sent by the release
     App (`coderizehq-release[bot]`, the only sender accepted) with `client_payload.site` naming the site and
     `client_payload.content_sha256`: verify finds the commit live runs now itself (`scripts/lib/rebuild.mjs`), and
     publish takes that commit's rebuild stored by the same run, never the run's own commit (main's head). Refused
     like the go-live release when anything doesn't match, and never taken for a dependency run;
   - anything else is refused.
2. `publish` (the `release` environment, the live role; one queue per site):
   - finds the live distribution: the one whose Comment is exactly `<site>` (platform sets it), and the domain from
     its apex alias. The bucket is `coderizehq-live-<site>`. The site passes neither. A distribution with no aliases
     yet is a site moving in by an alias move (platform's `alias_move`, its docs/go-live.md "Zero-downtime cutover"):
     the old fleet still serves the domain, so the release publishes to the new distribution and runs the live checks
     below against its own `*.cloudfront.net` name, fetching the sitemap by its path there;
   - reads the manifest for the exact commit (waiting up to 20 minutes for deploy-preview to store it) and records a
     GitHub deployment to `live` whose payload names the commit, the release PR, the approver (or the Renovate PRs),
     the manifest's SHA-256 and the workflow commit;
   - downloads every stored file and checks its size and SHA-256 against the manifest;
   - copies each file with one CopyObject from `_builds/<site>/<commit>/files/` (the only writes the live role may
     make; never a multipart copy, which IAM refuses), deletes what the build doesn't have (same mass-delete guard),
     then checks the bucket holds exactly the build (sizes and MD5 ETags of the checked bytes). A government site
     deletes nothing and refuses a dropped page without a redirect (Government sites, below);
   - invalidates `/*` and waits, then checks the live home page and robots.txt are this build's bytes, robots.txt
     doesn't block every crawler and names a sitemap on the site's own host, and the sitemap answers. A site whose
     home page comes back with `X-Robots-Tag: noindex` is noindex on purpose (that header comes only from platform's
     `coderizehq-live-noindex` headers policy, which only a record with `"indexed": false` gets; a build can't set
     it): its robots.txt must instead disallow every crawler and name no sitemap, and no sitemap is fetched;
   - marks the deployment successful, or failed with the reason.
3. `notify`: emails ops@coderize.dev when `publish` succeeded, or when `verify` or `publish` failed (a refusal
   included, with its reasons). Nothing is sent when there was nothing to publish, for a run on a ref release can
   never take (neither a version tag nor main), for a weekly dependency run held for James (platform's weekly digest
   lists it), or for a backup cron run repeating the week's run (Notifications).

### Government sites

A government site (platform's `"government": true` record, in the Government account 355600359887, built by platform's
`aws/government`) holds public records, which are never deleted, only archived. Platform writes `account: government`
into every call the site's workflows make to `deploy-preview.yml` and `release.yml` (its deploy, release, rebuild and
refresh workflows). Every other site passes nothing and gets `account: live`, which behaves exactly as before. The
value is `live` or `government`; anything else fails the job's first step, before any AWS call. The account map is
`ACCOUNTS` in `scripts/lib/build.mjs` (live 243891826043, government 355600359887); `release.yml`'s `Pick the account`
step repeats it, and a test keeps the two the same.

| | `account: live` (the default) | `account: government` |
| --- | --- | --- |
| deploy-preview stores the build in | `coderizehq-previews-798070830797` | `coderizehq-gov-builds-355600359887` (Object-Locked, governance, 7 years), same `_builds/<site>/<commit>/` layout, same write-once rules |
| deploy-preview's role | `coderizehq-preview-deploy-<site>` (798070830797) | the same role, which platform lets write and read its own `_builds/<site>/` in the government bucket |
| the preview | `https://<site>.preview.coderize.dev`, copied from the stored build | the same, copied across accounts from the government bucket |
| release's role | `arn:aws:iam::243891826043:role/coderizehq-live-publish-<site>` | `arn:aws:iam::355600359887:role/coderizehq-live-publish-<site>` |
| release copies from / into | the preview account's builds / `coderizehq-live-<site>` | the government builds / `coderizehq-live-<site>` in 355600359887 (Object-Locked) |
| what the build no longer has | deleted, refusing a drop of more than `max-delete-share` (25%) | **never deleted** (below); `max-delete-share` has nothing to guard |
| the deployment record's payload | as before | adds `"account": "government"` |

**Never delete.** A government release deletes nothing from live:

- a file the build no longer has (an old hashed bundle, an image, a document) stays in the live bucket, and its URL
  keeps answering;
- a page (an `.html` or `.htm` object) the build no longer has refuses the release, before anything is copied or
  written and with every such page listed, unless the site's redirect map has an entry for the page's URL (the router's
  URL for it, with no trailing slash: `/` for `index.html`, `/<dir>` for `<dir>/index.html`, `/<key>` for any other
  page). The router keys the map by the path as the browser sent it, so the key is matched raw, with each segment
  through `encodeURIComponent`, or as a browser encodes it (spaces and unicode encoded, `#` and `?` as `%23` and `%3F`,
  other reserved characters left alone); the refusal lists each page in that last form. A redirected page stays in the bucket too, and the router answers its URL with
  the 301 before the file is ever reached (it reads the redirect map before any file). To drop a page, add a redirect
  for it to the record's `redirects` (platform `sites/<site>.json`), apply, then release. The kept page is still in
  the bucket, so every later release checks its redirect again: taking the redirect out would serve the old page again,
  and is refused the same way;
- the check after the copy allows exactly the kept objects beside the build; the summary counts them.

The redirect map comes from where the router reads it: platform's redirect sync writes each government record's
`redirects` into the CloudFront KeyValueStore `coderizehq-government-redirects` (key `<apex><path>`). Release reads it
only when a page is dropped: `cloudfront:DescribeKeyValueStore` finds its ARN by name, then
`cloudfront-keyvaluestore:ListKeys`, 50 keys a call, keeping the keys whose apex, dots as hyphens, is the site name. So
a page can only be dropped once its redirect is really served, not merely written in a file. The KeyValueStore API is
signed with SigV4A, which `@aws-sdk/signature-v4a` (pure JS, imported by `scripts/lib/aws.mjs`) provides.

**Object Lock.** S3 refuses an upload to a bucket with a default retention unless it carries a checksum header. Every
PutObject here already names its SHA-256 (`x-amz-checksum-sha256`), and the S3 client pins the SDK's own default
(`requestChecksumCalculation: 'WHEN_SUPPORTED'`) so a runner's `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` can't
turn it off. A copy into a government bucket also asks S3 for the copy's SHA-256 (`x-amz-checksum-algorithm: SHA256`);
a live site's copy request is unchanged. `scripts/government.test.mjs` checks both on the wire through the SDK, and the
in-memory store refuses an upload or copy into a locked bucket without one, and any delete there.

### Content rebuilds

For a live site whose build bakes in content from an API (event pages, testimonials, prices), so that the content
reaching live doesn't wait for a code release. Platform's record field `rebuild` opts a site in, and platform's content
check (its `release-bootstrap.yml`, as the release App) hashes the record's content URLs each hour; when the hash
changed it sends the site's repo the `repository_dispatch` `content-rebuild` with the site and the hash. The site's
platform-written rebuild workflow (`rebuild.yml`, or `rebuild-<site>.yml` in an app repo) runs three jobs in one run:

1. `rebuild-target.yml`: checks the dispatch and finds the **commit live runs now**, the newest successful deployment
   to `live` (or `live-<site>`), and only if it still passes the rules that let it go live: a version tag on it passes
   `release-check`, or it is a dependency-only release on top of the last version (`dependencyCheck.mjs`). Nothing
   live, a go-live release (before the first version release), or anything else is refused. So a content rebuild
   never ships code: merges not yet released stay unreleased, and a rolled-back site is rebuilt at the version it
   was rolled back to.
2. `deploy-preview.yml` with `rebuild-commit`: builds that commit with no credentials and stores it as this run's
   rebuild (above). The commit's first build is never touched.
3. `release.yml`: verify finds the target again on its own and must agree; publish copies this run's stored rebuild
   to the distribution that already serves the site, refuses one with no aliases yet (an alias move under way), and
   asks again right before it writes whether live still runs that commit (a release published meanwhile wins: the
   rebuild is refused, and platform's next check rebuilds the new commit if the content still differs). It records a
   deployment of kind `content` whose payload adds `rebuild` (`run`, `basis`, `tag`, `content_sha256`), shares the
   per-site release queue, keeps the mass-delete guard, runs every live check and emails ops@ like any release.

No new trust: every AWS call is made by the same roles as before (the preview role for `deploy-preview.yml` on main,
the live role for `release.yml` in the `release` environment on main), and both read and write only
`_builds/<site>/*` and the site's own bucket, as they always did.

### Data refreshes

For a live site whose build bakes in data from a feed that needs credentials and has to stay fresh by a rule
(lapeerrealty.com's MLS listings: Realcomp allows displayed data at most 12 hours old; James, C2614). Platform's record
field `refresh` (`{ "every": "3h", "secrets": ["REALCOMP_CLIENT_ID", "REALCOMP_CLIENT_SECRET"] }`) opts a site in,
gives its repo a `refresh` environment (`refresh-<site>` for a package site; main and version tags only, since a
release builds there too) whose secrets James types in,
and platform's refresh check (its `release-bootstrap.yml`, as the release App) sends the site's repo the
`repository_dispatch` `data-refresh` (`{ site, reason }`) every `every` hours and straight after a release publishes.
**The code is always the commit James approved in the site's last release; only the feed data changes.** The site's
platform-written refresh workflow (`refresh.yml`, or `refresh-<site>.yml` in an app repo) runs four jobs:

1. `rebuild-target.yml`: checks the dispatch and finds the commit live runs now, exactly as for a content rebuild,
   with one difference: a go-live release (an alias move under way) is taken too, but only when its commit is itself an
   approved release (`approvedCommit`: a version tag passing `release-check`, or a dependency-only gap). main's head
   that no release names never gets the secrets.
2. `refresh-build.yml`: the only job the secrets reach. It names the environment (an environment's secrets reach only a
   job that names it, and the calling job can't, so the caller passes them with `secrets: inherit`), checks the
   inputs (the environment matches the package, each name follows platform's rules again: none the runner or the
   build's tools read, none a framework inlines into pages), checks out the commit, hashes the lockfile, runs
   `pnpm install` with no secrets, then takes only the named secrets (a missing one fails here) into a file only the
   build step reads and deletes (never `$GITHUB_ENV`, so the upload never sees them), builds and uploads `site-build`.
   `build-dir` must be a relative folder inside the package, with no `..`. Anything `pnpm install` writes to the job's
   environment files is discarded and the build refused, so install scripts can't reach the steps that hold secrets.
   Outside a `data-refresh` dispatch, `commit` must be the run's own commit. It has Contents: read only: no `id-token`, so no AWS role can trust it.
3. `deploy-preview.yml` with `rebuild-commit` and `refresh-lockfile-sha256`: skips its own build, stores the run's
   `site-build` write-once at `_builds/<site>/<commit>/refreshes/<run>/` (its manifest says `refresh: { run }`), and
   leaves the preview alone. No secret reaches it.
4. `release.yml` with `refresh: true` and `refresh-results` (how build and store ended): verify finds the target again
   and refuses unless both succeeded (so a failed refresh is emailed, never silent); publish copies the run's stored
   refresh, also to a distribution with no names yet (the feed data goes in before an alias move's names move), and
   refuses if live moved meanwhile. It records a deployment of kind `refresh` whose payload adds `refresh` (`run`,
   `basis`, `tag`, `reason`).

**Releases with the data** (James, C2620 a). A release publishes the build stored for its commit, built with no
secrets, which over a refreshed site would delete the feed's pages (and be refused by the mass-delete guard). So a
refresh site's platform-written release workflow (and so `fleet rollback`, which starts it on an older tag) calls
`release.yml` with `check-only: true` first: verify alone, whose `refreshable` output says whether the run's commit may
be built with the secrets (a version or dependency-only release; a go-live release only when its commit is an approved
one). Then `refresh-build.yml` and `deploy-preview.yml` on the run's own commit, then `release.yml` again with
`refresh: true`, which publishes that refresh: one release, with the feed data, never a build without it. A commit that
isn't refreshable is published as before. `refresh` on a release records the usual kind (`version`, `dependency`,
`go-live`) with the `refresh` payload beside it.

Trust: the live role and notify role are unchanged. Storing a refresh from a release on a version tag needs the
preview role to trust `deploy-preview.yml` on the site repo's version tags as well as main: platform gives only a site
with `refresh` the separate `aws/trust/preview-deploy-refresh.json.tftpl` (every other site keeps the main-only
`preview-deploy.json.tftpl`); tags are made only by the release App. This is the cost of releasing with the data in
one run (C2620 a).

### Notifications

Email only (James's call, C955 a), to ops@coderize.dev, from `CoderizeHQ <notify@notify.coderize.dev>` through SES in
the live account with the `coderizehq-notify` configuration set (bounces and complaints go to platform's feedback
topic). The `notify` jobs run `scripts/notify.mjs` as `arn:aws:iam::243891826043:role/coderizehq-notify-send`, fixed in
the workflows. platform's `aws/live/notify.tf` makes that role: it trusts only `deploy-preview.yml` and `release.yml`
at `v1`/`v1.*`, from a site repo (by id, from the site records) on main or a version tag, and may only call
`ses:SendEmail` from that address to that one recipient. The email is plain text: the site, ref, commit, each job's
result, the live URL and approval for a release, a refusal's reasons, and the run's link.

Release's `notify` sends nothing in two cases (James, C2719 c), decided by `notify.mjs decide` before any AWS:

- **A hold.** The weekly dependency run (GitHub's cron, or platform's `weekly-dependency-release` dispatch as the
  release App) refused only because the gap is left for James: verify's `hold` output. A hold isn't an error, and one
  platform sync of `release.yml` holds every site at once (21 sites, about 50 emails on 2026-11-24). Platform's weekly
  digest lists every held site in one email instead (its `scripts/siteReleases.mjs`, release-bootstrap's
  `site-releases` and `release-digest` jobs), with the reasons, since when, and whether a release PR is open; it finds
  each hold by the line `release-hold: {"reasons":[…],"base":"vX.Y.Z"}` that verify prints (`HOLD_MARKER` in
  `scripts/release.mjs`). The run still fails in verify, with the reasons as errors and a "Held for James" summary, so
  main's release shows it isn't released and platform's dispatcher still counts it as the week's run. A hand-started
  run (`workflow_dispatch`) still emails its hold.
- **A repeat.** A run of the site's backup cron that comes after a run in the same slot (the cron's last Tuesday 09:37
  UTC, read from `github.event.schedule`) by the cron, a hand start or platform's dispatch as the release App, for the
  same commit, which ended the same way and whose own `Email ops@` step succeeded. A cron run for a newer commit, one
  that ends differently (a publish that fails this time), or one after a run that emailed nothing (a hold, then a
  real failure on the cron) emails.

Every other failure emails as before: a publish error, any refusal that isn't a hold, and a job that fails outright.
If the decide step can't read the runs, it emails.

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
AccessDenied, or a control that fails: the same token must assume `coderizehq-infra-plan` in each account through the
same unsigned call. Each refused role is checked to exist (`iam:GetRole` as the plan role), since STS refuses a role
that isn't there too. A site role that isn't made yet (a record merged before the apply that makes its roles) is a
warning, shown as "not made yet": nobody can assume a role that doesn't exist, and failing on it blocked every platform
PR until that apply ran. A missing `coderizehq-infra-deploy`, or every role of one kind missing in its account (what a
wrong role name here would look like), still fails; so the first role of a kind in an account, from a record not yet
applied, still blocks until its apply, which is the price of that guard. Only IAM's NoSuchEntity counts as missing:
any other `GetRole` error fails the job.

`plan`: per root, as the live account's `coderizehq-infra-plan` for the state (profile
`state`) and the root's own account's for its resources (profile `account`), `tofu plan -lock=false`. A root whose
provider needs a token the caller didn't pass (Cloudflare, GitHub) is skipped and says so. `comment`: one PR comment
with every plan, updated on each push.

A root's `"parallelism"` sets how many resources its plan refreshes at once (`-parallelism`, 1 to 50; OpenTofu's
default of 10 without it). aws/live's is 30, as in its plan in platform's `apply.yml` (platform #375): its refresh reads
about 1,540 resources and is mostly waiting, and its PR plan took 3m10s to 4m36s at 10. A plan only reads, so 30 is
safe on the plan role's read APIs: S3 and IAM don't throttle at it, and the provider's retries absorb CloudFront's and
CloudWatch's bursts. The other roots keep 10. The key is in the matrix, so aws/live's check is named
`ci / plan (aws/live, 243891826043, 30)`; no ruleset requires a plan check by name (platform's requires the
workflow).

### axe

Builds the site, serves the build the way live does (`/page` from `/page/index.html`, a missing page answers
`/404.html` with 404), and runs axe (Playwright and `@axe-core/playwright`, pinned in `pnpm-lock.yaml`) on its pages
in light and dark color schemes after the network is idle, against WCAG 2.2 AA with `target-size` enabled. It fails
on any violation, a page that doesn't answer 200, fewer pages than `min-pages`, or a sitemap URL with no built page.

Pages built from one template give the same violations, so a big family of them is sampled
(`scripts/axeScan.mjs`, `templateKeys` and `samplePages`). The family comes from the shape of the paths: a path
segment after the first is a slug when more than 10 different values (or `pages-per-template`, if higher) sit at
that place under the same parent. So 300 `/events/<slug>` pages are one family, `/events/*`; with more than 10
chapters, `/chapters/<c>/events/<slug>` is one family across every chapter, and `/chapters/<c>/contact` another. A
top-level page (`/about`) and a handful of siblings (`/legal/privacy`, `/legal/terms`) are never a family: each is
scanned. From a family of more than `pages-per-template` pages (3 by default), that many are scanned, sorted and
spread evenly from the first to the last, so every run scans the same pages; `0` scans every page. `min-pages` and
the sitemap check still count every built page, since they read the build's files, not the browser. The job summary
says how many pages were built and how many scanned, with a row per sampled family.

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
  (platform's `docs/release-safety.md`). So release's `account` input and never delete (Government sites) are proved by
  the tests, not by a canary run.
- ci-tofu's trust probe (`scripts/trustProbe.mjs`) tries live publish roles in the live account only, so a government
  site's `coderizehq-live-publish-<site>` in 355600359887 isn't probed yet (platform's `aws/trust` tests its policy);
  probing it needs `coderizehq-infra-plan` in that account and the trust job given its credentials.
- ci-tofu's plans of roots that use the Cloudflare or GitHub provider need platform's `CLOUDFLARE_READ_TOKEN` and
  `PLATFORM_READ_APP_KEY` secrets and `PLATFORM_READ_APP_CLIENT_ID` variable (platform's README says what they are);
  until then those plans are skipped.
- ci-site's workflow standards check (each repo's files against the template) comes with the template in Phase 4.
- The runner VM (Phase 3): jobs need `gh`, `jq`, `curl`, `unzip` and, for axe, Playwright's system packages
  (`playwright install --with-deps`, which needs root) on its image; ci-tofu's `trust` job also needs the AWS CLI.
