// The only file that talks to AWS. deployPreview.mjs and release.mjs take a `store` with these methods, notify.mjs a
// `mailer`, and appImage.mjs and deployApp.mjs their ECR, EC2 and SSM calls, so the tests (and a dry run) hand them
// an in-memory fake instead. Credentials come from configure-aws-credentials.

import { CloudFrontClient, CreateInvalidationCommand, ListDistributionsCommand, waitUntilInvalidationCompleted } from '@aws-sdk/client-cloudfront'
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2'
import { DescribeImagesCommand, ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr'
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm'

import { sha256Base64ToHex, sha256HexToBase64 } from './files.mjs'

const REGION = 'us-east-1'

// Without s3:ListBucket on a prefix, S3 answers a missing key with 403, not 404. Both mean "not there for us"; a real
// denial still surfaces at the next write.
const missing = (err) => ['NoSuchKey', 'NotFound', 'AccessDenied', 'Forbidden'].includes(err?.name) ||
  [403, 404].includes(err?.$metadata?.httpStatusCode)

/** @param {string} bucket @param {string} key */
export const copySource = (bucket, key) => `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`

export function awsStore() {
  const s3 = new S3Client({ region: REGION })
  const cloudfront = new CloudFrontClient({ region: REGION })
  return {
    /** @returns {Promise<{ body: Buffer, etag: string } | null>} */
    async get(bucket, key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        return { body: Buffer.from(await res.Body.transformToByteArray()), etag: res.ETag }
      } catch (err) {
        if (missing(err)) return null
        throw err
      }
    },

    /** @returns {Promise<{ etag: string, size: number, sha256: string | null } | null>} */
    async head(bucket, key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }))
        const sha256 = res.ChecksumSHA256 && res.ChecksumType !== 'COMPOSITE' ? sha256Base64ToHex(res.ChecksumSHA256) : null
        return { etag: res.ETag, size: res.ContentLength, sha256: sha256 ?? res.Metadata?.sha256 ?? null }
      } catch (err) {
        if (missing(err)) return null
        throw err
      }
    },

    /**
     * A create-only write (If-None-Match: *), with the SHA-256 S3 checks the body against.
     * @returns {Promise<'created' | 'exists'>}
     */
    async putIfAbsent(bucket, key, body, { contentType, cacheControl, sha256 }) {
      for (let attempt = 1; ; attempt++) {
        try {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: body,
              ContentType: contentType,
              CacheControl: cacheControl,
              IfNoneMatch: '*',
              ChecksumSHA256: sha256HexToBase64(sha256),
              Metadata: { sha256 },
            }),
          )
          return 'created'
        } catch (err) {
          const status = err?.$metadata?.httpStatusCode
          if (status === 412 || err?.name === 'PreconditionFailed') return 'exists'
          // 409: another write to the same key was in flight; S3 asks for a retry.
          if (status === 409 && attempt < 3) continue
          throw err
        }
      }
    },

    // Server-side copy, keeping the source's Content-Type, Cache-Control and metadata. One CopyObject per file: a
    // multipart copy (what the CLI's s3 cp/sync does over 8 MB) starts with a write that carries no copy source, which
    // the live role's IAM refuses. A single CopyObject takes up to 5 GB.
    async copy(srcBucket, srcKey, bucket, key) {
      const res = await s3.send(
        new CopyObjectCommand({ Bucket: bucket, Key: key, CopySource: copySource(srcBucket, srcKey), MetadataDirective: 'COPY' }),
      )
      return { etag: res.CopyObjectResult?.ETag }
    },

    /** @returns {Promise<{ key: string, size: number, etag: string }[]>} keys relative to `prefix` */
    async list(bucket, prefix) {
      const out = []
      let token
      do {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        for (const o of res.Contents ?? []) out.push({ key: o.Key.slice(prefix.length), size: o.Size, etag: o.ETag })
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      return out
    },

    async deleteMany(bucket, keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000)
        const res = await s3.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Quiet: true, Objects: chunk.map((Key) => ({ Key })) } }),
        )
        if (res.Errors?.length) throw new Error(`delete failed for ${res.Errors.length} keys, first: ${res.Errors[0].Key} ${res.Errors[0].Code}`)
      }
    },

    /** The distribution whose Comment is exactly `comment` (platform sets each live site's to its name). */
    async findDistribution(comment) {
      const found = []
      let marker
      do {
        const res = await cloudfront.send(new ListDistributionsCommand({ Marker: marker }))
        for (const d of res.DistributionList?.Items ?? []) {
          if (d.Comment === comment) found.push({ id: d.Id, aliases: d.Aliases?.Items ?? [] })
        }
        marker = res.DistributionList?.IsTruncated ? res.DistributionList.NextMarker : undefined
      } while (marker)
      if (found.length > 1) throw new Error(`${found.length} distributions have the comment ${comment}`)
      return found[0] ?? null
    },

    /** Waits up to 10 minutes for an invalidation to finish. */
    async waitInvalidation(distributionId, id) {
      await waitUntilInvalidationCompleted({ client: cloudfront, maxWaitTime: 600, minDelay: 10 }, { DistributionId: distributionId, Id: id })
    },

    async invalidate(distributionId, paths, reference) {
      const res = await cloudfront.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: { CallerReference: reference, Paths: { Quantity: paths.length, Items: paths } },
        }),
      )
      return res.Invalidation?.Id
    },
  }
}

// SES in the live account, as coderizehq-notify-send. Plain text only: nothing from a run is ever rendered as HTML.
export function awsMailer() {
  const ses = new SESv2Client({ region: REGION })
  return {
    /** @returns {Promise<string>} the SES message id */
    async send({ from, to, configurationSet, subject, text }) {
      const res = await ses.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [to] },
          ConfigurationSetName: configurationSet,
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: { Text: { Data: text, Charset: 'UTF-8' } },
            },
          },
        }),
      )
      return res.MessageId
    },
  }
}

// ECR, as coderizehq-app-build-<app> (appImage.mjs push).
export function awsImages() {
  const ecr = new ECRClient({ region: REGION })
  return {
    async hasTag(repository, tag) {
      try {
        await ecr.send(new DescribeImagesCommand({ repositoryName: repository, imageIds: [{ imageTag: tag }] }))
        return true
      } catch (err) {
        if (err?.name === 'ImageNotFoundException') return false
        throw err
      }
    },

    /** The registry password for `AWS`, good for 12 hours. Never logged. */
    async loginPassword() {
      const res = await ecr.send(new GetAuthorizationTokenCommand({}))
      return Buffer.from(res.authorizationData[0].authorizationToken, 'base64').toString('utf8').replace(/^AWS:/, '')
    },
  }
}

// ECR, EC2 and Systems Manager, as coderizehq-app-deploy-<app> (deployApp.mjs).
export function awsDeploy() {
  const ec2 = new EC2Client({ region: REGION })
  const ssm = new SSMClient({ region: REGION })
  return {
    hasTag: awsImages().hasTag,

    /** The running instances tagged Name=<name>. */
    async instances(name) {
      const res = await ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: 'tag:Name', Values: [name] },
            { Name: 'instance-state-name', Values: ['running'] },
          ],
        }),
      )
      return (res.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => i.InstanceId)
    },

    async send({ document, instanceId, parameters, comment }) {
      const res = await ssm.send(
        new SendCommandCommand({ DocumentName: document, InstanceIds: [instanceId], Parameters: parameters, Comment: comment }),
      )
      return res.Command.CommandId
    },

    /** The command's result on the instance, or null while SSM hasn't registered it yet. */
    async invocation(commandId, instanceId) {
      try {
        const res = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }))
        return { status: res.Status, stdout: res.StandardOutputContent ?? '', stderr: res.StandardErrorContent ?? '' }
      } catch (err) {
        if (err?.name === 'InvocationDoesNotExist') return null
        throw err
      }
    },
  }
}
