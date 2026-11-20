# Changelog

## [1.4.2](https://github.com/CoderizeHQ/actions/compare/v1.4.1...v1.4.2) (2026-11-20)


### Bug Fixes

* wait for the app image in deploy-app instead of failing while it builds ([#38](https://github.com/CoderizeHQ/actions/issues/38)) ([5cb4513](https://github.com/CoderizeHQ/actions/commit/5cb45132dc7f7c3efcd283fb02e9a817ba556ef7))

## [1.4.1](https://github.com/CoderizeHQ/actions/compare/v1.4.0...v1.4.1) (2026-11-20)


### Bug Fixes

* keep pnpm's package links intact in the app image layer ([#36](https://github.com/CoderizeHQ/actions/issues/36)) ([1091a6e](https://github.com/CoderizeHQ/actions/commit/1091a6e4924d69ce2467f44f946f2e6fc3961c49))

## [1.4.0](https://github.com/CoderizeHQ/actions/compare/v1.3.0...v1.4.0) (2026-11-20)


### Features

* give ci-node a throwaway Postgres database for API tests, on the runner VM ([#34](https://github.com/CoderizeHQ/actions/issues/34)) ([d9d68c0](https://github.com/CoderizeHQ/actions/commit/d9d68c0775d17c0e1107913f1ea7f39ac651941f))

## [1.3.0](https://github.com/CoderizeHQ/actions/compare/v1.2.0...v1.3.0) (2026-11-20)


### Features

* add build-app-image and deploy-app for apps on the app server ([#32](https://github.com/CoderizeHQ/actions/issues/32)) ([0c24677](https://github.com/CoderizeHQ/actions/commit/0c24677a94197566d2bdb33055ad954a2a69b7d1))

## [1.2.0](https://github.com/CoderizeHQ/actions/compare/v1.1.1...v1.2.0) (2026-11-17)


### Features

* skip the live publish role for a preview-only site record ([#30](https://github.com/CoderizeHQ/actions/issues/30)) ([49a9307](https://github.com/CoderizeHQ/actions/commit/49a9307db90aa622c8f023c8bfda11a8a708528c))

## [1.1.1](https://github.com/CoderizeHQ/actions/compare/v1.1.0...v1.1.1) (2026-11-17)


### Bug Fixes

* let platform's file syncs and pnpm updates through the dependency check ([#28](https://github.com/CoderizeHQ/actions/issues/28)) ([9bcbf31](https://github.com/CoderizeHQ/actions/commit/9bcbf31df9f2a467b4969794425ecf8dac87c9dc))

## [1.1.0](https://github.com/CoderizeHQ/actions/compare/v1.0.5...v1.1.0) (2026-11-16)


### Features

* plan the cloudflare/ai root on platform PRs, offline ([#25](https://github.com/CoderizeHQ/actions/issues/25)) ([57edbc1](https://github.com/CoderizeHQ/actions/commit/57edbc100af34011d36a0284c1a3a0bde3c76e27))

## [1.0.5](https://github.com/CoderizeHQ/actions/compare/v1.0.4...v1.0.5) (2026-11-16)


### Bug Fixes

* build and deploy sites on Node 26 and Ubuntu 26.04 ([#21](https://github.com/CoderizeHQ/actions/issues/21)) ([b3c4a36](https://github.com/CoderizeHQ/actions/commit/b3c4a362e6e5d8b09258b4a33dd1e906fc0c4a35))

## [1.0.4](https://github.com/CoderizeHQ/actions/compare/v1.0.3...v1.0.4) (2026-11-15)


### Bug Fixes

* trust CoderizeHQ's self-hosted Renovate App ([#14](https://github.com/CoderizeHQ/actions/issues/14)) ([6907586](https://github.com/CoderizeHQ/actions/commit/6907586731f8fa00c633eb1d24b151426da7f4db))
* use the preset path syntax for the Renovate policy ([#15](https://github.com/CoderizeHQ/actions/issues/15)) ([8af67b8](https://github.com/CoderizeHQ/actions/commit/8af67b842d098f9d3e869c3e4b202d30a4512713))

## [1.0.3](https://github.com/CoderizeHQ/actions/compare/v1.0.2...v1.0.3) (2026-11-15)


### Bug Fixes

* run the live trust tests on the base branch's site records, so a new site's PR passes before its roles exist ([#12](https://github.com/CoderizeHQ/actions/issues/12)) ([7ff0051](https://github.com/CoderizeHQ/actions/commit/7ff005188286cde81ad362a958b0b0d5346fb40d))

## [1.0.2](https://github.com/CoderizeHQ/actions/compare/v1.0.1...v1.0.2) (2026-11-15)


### Bug Fixes

* plan the github root against its applied state, since a read-only App can't read rulesets or merge settings ([#10](https://github.com/CoderizeHQ/actions/issues/10)) ([23069c6](https://github.com/CoderizeHQ/actions/commit/23069c6e5ced1232a540b0282fa29aae7aab9378))

## [1.0.1](https://github.com/CoderizeHQ/actions/compare/v1.0.0...v1.0.1) (2026-11-15)


### Bug Fixes

* install Chromium's system libraries only on GitHub-hosted runners ([#8](https://github.com/CoderizeHQ/actions/issues/8)) ([e16d09d](https://github.com/CoderizeHQ/actions/commit/e16d09df6ba37131ad9786e9dfe49c781207534c))

## 1.0.0 (2026-11-15)


### Features

* release actions as v1.x.y and email ops@ about deploy and release runs ([#5](https://github.com/CoderizeHQ/actions/issues/5)) ([f349b47](https://github.com/CoderizeHQ/actions/commit/f349b475886c5b8d796d7354b9550dd142d73495))
