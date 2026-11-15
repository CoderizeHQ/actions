// Reads the claims of the job's GitHub OIDC token: the same token AWS checks, so what the manifest and the deployment
// record say about the workflow (job_workflow_ref, job_workflow_sha) is what AWS trusted. Needs id-token: write.

/** @param {string} jwt */
export function decodeClaims(jwt) {
  const part = String(jwt).split('.')[1]
  if (!part) throw new Error('not a JWT')
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

/** The job's OIDC token itself (a JWT), for code that hands it to AWS. */
export async function requestToken(audience = 'sts.amazonaws.com') {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env
  if (!url || !bearer) throw new Error('no OIDC token available (the job needs id-token: write)')
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { authorization: `bearer ${bearer}` } })
  if (!res.ok) throw new Error(`OIDC token request: ${res.status}`)
  return (await res.json()).value
}

export async function requestClaims(audience = 'sts.amazonaws.com') {
  return decodeClaims(await requestToken(audience))
}

/**
 * Checks the token says this job runs `workflow` from CoderizeHQ/actions at `workflowSha`, for `repo` at `commit`.
 * @returns {string[]} problems, empty when it all matches
 */
export function checkClaims(claims, { workflow, workflowSha, repo, commit }) {
  const problems = []
  const ref = `CoderizeHQ/actions/.github/workflows/${workflow}@`
  if (!String(claims.job_workflow_ref ?? '').startsWith(ref)) problems.push(`job_workflow_ref is ${claims.job_workflow_ref}, not ${ref}…`)
  if (claims.job_workflow_sha !== workflowSha) problems.push(`job_workflow_sha ${claims.job_workflow_sha} is not the loaded scripts' ${workflowSha}`)
  if (claims.repository !== repo) problems.push(`repository ${claims.repository} is not ${repo}`)
  if (claims.sha !== commit) problems.push(`sha ${claims.sha} is not ${commit}`)
  return problems
}
