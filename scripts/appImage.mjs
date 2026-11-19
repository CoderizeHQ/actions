// build-app-image's helpers (platform docs/apps.md, "Images"). The image is assembled without Docker (STANDARDS.md 6:
// jobs get no Docker): the app's production files, installed for Linux ARM64 by pnpm, go in as one layer on a pinned
// Node base image for ARM64, by crane. Nothing ARM runs on the x86 runner.
//
//   node appImage.mjs check   checks the app name and that the repo installs ARM64 packages (build job)
//   node appImage.mjs push    pushes the built image to the app's ECR repository, tagged with the commit (push job,
//                             as coderizehq-app-build-<app>)

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

import { runIfMain, summary } from './lib/report.mjs'

export const REGISTRY = '243891826043.dkr.ecr.us-east-1.amazonaws.com'
export const repositoryName = (app) => `coderizehq-app-${app}`

/** The app's name as platform's apps/<app>.json has it: it goes into role names and the ECR repository. */
export function checkApp(app) {
  if (!/^[a-z][a-z0-9-]{0,29}$/.test(app ?? '')) throw new Error('app must start with a-z and be at most 30 of a-z, 0-9 and -')
  return app
}

/** A full commit sha, the image's tag. */
export function checkCommit(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('commit must be a 40-character sha')
  return commit
}

/**
 * The repo's pnpm-workspace.yaml must install Linux ARM64 (glibc) packages beside the runner's own, so packages with
 * native parts come as their ARM builds, and must inject workspace packages so `pnpm deploy` can copy the app out.
 * A plain-text check of the two settings, enough for the shape they're written in (docs/apps.md).
 * @param {string} yaml
 * @returns {string[]} problems
 */
export function checkWorkspace(yaml) {
  const problems = []
  const block = yaml.match(/^supportedArchitectures:\s*\n((?:[ \t]+.*\n?)+)/m)?.[1] ?? ''
  const list = (key) => block.match(new RegExp(`^\\s+${key}:\\s*\\[([^\\]]*)\\]`, 'm'))?.[1].split(',').map((s) => s.trim()) ?? []
  if (!list('os').includes('linux')) problems.push('supportedArchitectures.os must include linux')
  if (!list('cpu').includes('arm64')) problems.push('supportedArchitectures.cpu must include arm64')
  if (!list('libc').includes('glibc')) problems.push('supportedArchitectures.libc must include glibc')
  if (!/^injectWorkspacePackages:\s*true\s*$/m.test(yaml)) problems.push('injectWorkspacePackages must be true')
  return problems
}

/**
 * Pushes image.tar unless the commit's tag is already there (tags are immutable: a re-run of the same commit keeps
 * the image it pushed first).
 */
export async function pushImage({ ecr, crane, app, commit, imageTar, log = console.log }) {
  const repository = repositoryName(app)
  const ref = `${REGISTRY}/${repository}:${commit}`
  if (await ecr.hasTag(repository, commit)) {
    log(`${ref} is already in ECR; keeping it`)
    return { ref, pushed: false }
  }
  await crane.login(REGISTRY, await ecr.loginPassword())
  await crane.push(imageTar, ref)
  log(`pushed ${ref}`)
  return { ref, pushed: true }
}

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'] })
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (exit ${r.status})`)
}

const realCrane = {
  async login(registry, password) {
    // The password goes on stdin, never on the command line.
    run('crane', ['auth', 'login', registry, '--username', 'AWS', '--password-stdin'], password)
  },
  async push(tar, ref) {
    run('crane', ['push', tar, ref])
  },
}

runIfMain(import.meta.url, async () => {
  const [mode] = process.argv.slice(2)
  const app = checkApp(process.env.APP)
  if (mode === 'check') {
    const problems = checkWorkspace(await readFile('pnpm-workspace.yaml', 'utf8').catch(() => ''))
    if (problems.length) throw new Error(`pnpm-workspace.yaml can't build an ARM64 image (docs/apps.md):\n${problems.map((p) => `- ${p}`).join('\n')}`)
    console.log(`${app}: pnpm-workspace.yaml installs ARM64 packages`)
  } else if (mode === 'push') {
    const { awsImages } = await import('./lib/aws.mjs')
    const commit = checkCommit(process.env.COMMIT)
    const { ref, pushed } = await pushImage({ ecr: awsImages(), crane: realCrane, app, commit, imageTar: process.env.IMAGE_TAR })
    summary(`${pushed ? 'Pushed' : 'Kept'} \`${ref}\``)
  } else {
    throw new Error('usage: node appImage.mjs check|push')
  }
})
