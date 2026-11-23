# Changelog

## [1.12.0](https://github.com/CoderizeHQ/actions/compare/v1.11.0...v1.12.0) (2026-11-23)


### Features

* publish government sites from the Government account, never deleting there ([#57](https://github.com/CoderizeHQ/actions/issues/57)) ([6c09bc3](https://github.com/CoderizeHQ/actions/commit/6c09bc36be6dc10ebc4001326b41942db06b8bd9))

## [1.11.0](https://github.com/CoderizeHQ/actions/compare/v1.10.0...v1.11.0) (2026-11-23)


### Features

* refresh a site's feed data by rebuilding its released commit with named secrets, and release it with its data ([#55](https://github.com/CoderizeHQ/actions/issues/55)) ([c430a05](https://github.com/CoderizeHQ/actions/commit/c430a0581096b5967ecd88b7fb474844b77bbb2a))

## [1.10.0](https://github.com/CoderizeHQ/actions/compare/v1.9.0...v1.10.0) (2026-11-22)


### Features

* scan a sample of each big family of template pages in axe ([#53](https://github.com/CoderizeHQ/actions/issues/53)) ([52e069e](https://github.com/CoderizeHQ/actions/commit/52e069e8d95d6d205995071a12368bab3705d575))

## [1.9.0](https://github.com/CoderizeHQ/actions/compare/v1.8.0...v1.9.0) (2026-11-22)


### Features

* let a noindex site pass the SEO and release checks ([#47](https://github.com/CoderizeHQ/actions/issues/47)) ([96fe637](https://github.com/CoderizeHQ/actions/commit/96fe637754c7411543bc31372f268266bbfb5edc))

## [1.8.0](https://github.com/CoderizeHQ/actions/compare/v1.7.1...v1.8.0) (2026-11-21)


### Features

* rebuild a live site's released commit when its build-time content changes ([#50](https://github.com/CoderizeHQ/actions/issues/50)) ([330fe66](https://github.com/CoderizeHQ/actions/commit/330fe6600d379fd7a2db2b8cbb5608d1cdc09b94))

## [1.7.1](https://github.com/CoderizeHQ/actions/compare/v1.7.0...v1.7.1) (2026-11-21)


### Bug Fixes

* let a workspace package's package.json justify a lockfile change in ci-site ([#48](https://github.com/CoderizeHQ/actions/issues/48)) ([c2d8e61](https://github.com/CoderizeHQ/actions/commit/c2d8e613f147e0d3b0509259ad6ee6c3b93308d4))

## [1.7.0](https://github.com/CoderizeHQ/actions/compare/v1.6.0...v1.7.0) (2026-11-21)


### Features

* publish a site's go-live release from platform's apply, before its alias move ([#45](https://github.com/CoderizeHQ/actions/issues/45)) ([cb8b45a](https://github.com/CoderizeHQ/actions/commit/cb8b45adc3f97313fe4c779a7ab26a8eb99854cd))


### Bug Fixes

* warn instead of failing on a site role the next apply makes ([#44](https://github.com/CoderizeHQ/actions/issues/44)) ([d08dd28](https://github.com/CoderizeHQ/actions/commit/d08dd28f1ea3be1d13bf066e867174f6ee28a338))

## [1.6.0](https://github.com/CoderizeHQ/actions/compare/v1.5.0...v1.6.0) (2026-11-20)


### Features

* release a site to its distribution before an alias move ([#42](https://github.com/CoderizeHQ/actions/issues/42)) ([0703343](https://github.com/CoderizeHQ/actions/commit/07033431e504b11d924a1daac830357c7499b4c0))

## [1.5.0](https://github.com/CoderizeHQ/actions/compare/v1.4.2...v1.5.0) (2026-11-20)


### Features

* build a site from one package of a workspace, and record its own deployments ([#40](https://github.com/CoderizeHQ/actions/issues/40)) ([c230c93](https://github.com/CoderizeHQ/actions/commit/c230c93c37ac7f21bb11412bc6e6bc05bc02587f))

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
