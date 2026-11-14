import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Adds markdown to the job summary (a no-op outside Actions). */
export function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

/** Sets a step output (a no-op outside Actions). */
export function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

/** Runs `main` when the file is the entry point, printing failures as an Actions error. */
export function runIfMain(url, main) {
  if (!process.argv[1] || fileURLToPath(url) !== path.resolve(process.argv[1])) return
  main().catch((err) => {
    console.log(`::error::${err.message.split('\n')[0]}`)
    if (err.message.includes('\n')) console.log(err.message)
    process.exit(1)
  })
}
