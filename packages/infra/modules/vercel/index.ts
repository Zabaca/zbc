import * as path from 'node:path'
import * as fs from 'node:fs'
import { execSync } from 'node:child_process'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'

const VERCEL_API = 'https://api.vercel.com'

interface VercelProject {
  id: string
  name: string
  framework?: string
  accountId: string
}

interface VercelEnvVar {
  id: string
  key: string
  value: string
  target: string[]
}

async function vercelFetch(
  path: string,
  token: string,
  options?: RequestInit,
) {
  const res = await fetch(`${VERCEL_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Vercel API ${path} failed (${res.status}): ${body}`)
  }

  if (res.status === 204) return null
  return res.json()
}

async function findProject(
  token: string,
  projectName: string,
): Promise<VercelProject | null> {
  try {
    return await vercelFetch(`/v9/projects/${projectName}`, token)
  } catch {
    return null
  }
}

async function createProject(
  token: string,
  projectName: string,
  framework: string,
): Promise<VercelProject> {
  return vercelFetch('/v10/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: projectName,
      framework,
    }),
  })
}

async function syncEnvVars(
  token: string,
  projectId: string,
  desired: Record<string, string>,
  target: string[],
) {
  // Get existing env vars
  const data = (await vercelFetch(
    `/v9/projects/${projectId}/env`,
    token,
  )) as { envs: VercelEnvVar[] }
  const existing = data.envs ?? []

  for (const [key, value] of Object.entries(desired)) {
    const found = existing.find((e) => e.key === key)

    if (found) {
      // Update existing
      await vercelFetch(`/v9/projects/${projectId}/env/${found.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ value, target }),
      })
    } else {
      // Create new
      await vercelFetch(`/v9/projects/${projectId}/env`, token, {
        method: 'POST',
        body: JSON.stringify({ key, value, target, type: 'encrypted' }),
      })
    }
  }
}

async function syncDomain(
  token: string,
  projectId: string,
  domain: string,
) {
  try {
    await vercelFetch(`/v10/projects/${projectId}/domains`, token, {
      method: 'POST',
      body: JSON.stringify({ name: domain }),
    })
  } catch {
    // Domain may already be configured — that's fine
  }
}

function findVercelBin(projectRoot: string): string {
  const candidates = [
    path.join(projectRoot, 'packages/cli/node_modules/.bin/vercel'),
    path.join(projectRoot, 'node_modules/.bin/vercel'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('vercel CLI not found. Install it: bun add -d vercel in packages/cli')
}

function deployToVercel(
  token: string,
  sourceDir: string,
  production: boolean,
  projectRoot: string,
) {
  const vercelBin = findVercelBin(projectRoot)
  const args = [
    vercelBin,
    'deploy',
    sourceDir,
    '--token', token,
    '--yes',
  ]

  if (production) {
    args.push('--prod')
  }

  console.log(`  Deploying ${path.basename(sourceDir)}${production ? ' (production)' : ''}...`)

  try {
    const output = execSync(args.join(' '), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const raw = output.toString().trim()
    let deployUrl = ''

    // Extract the deployment URL from the output
    // The vercel CLI may output JSON (with { url: ... }) or plain text
    const urlMatch = raw.match(/https:\/\/[^\s"',}]+/)
    deployUrl = urlMatch?.[0] ?? ''
    console.log(`  Deployed: ${deployUrl}`)
    return deployUrl
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
    throw new Error(`Vercel deploy failed: ${stderr}`)
  }
}

export const vercelModule = defineModule({
  name: 'vercel',
  configSchema: z.object({
    projectName: z.string(),
    domain: z.string().optional(),
    framework: z.string().default('nextjs'),
    sourceDir: z.string().default('packages/web'),
    production: z.boolean().default(true),
  }),
  outputs: z.object({
    projectUrl: z.string(),
    projectId: z.string(),
    deployUrl: z.string().optional(),
  }),
  async apply(config, ctx) {
    const vercelToken = ctx.secrets['VERCEL_TOKEN']
    if (!vercelToken) throw new Error('Missing secret: VERCEL_TOKEN')

    // Get or create project
    let project = await findProject(vercelToken, config.projectName)

    if (project) {
      console.log(`  Project "${config.projectName}" already exists`)
    } else {
      project = await createProject(
        vercelToken,
        config.projectName,
        config.framework,
      )
      console.log(`  Created project "${config.projectName}"`)
    }

    // Sync env vars from imported module outputs
    const envVars: Record<string, string> = {}
    for (const [instanceName, outputs] of Object.entries(ctx.imports)) {
      if (typeof outputs === 'object' && outputs !== null) {
        for (const [key, value] of Object.entries(
          outputs as Record<string, unknown>,
        )) {
          if (typeof value === 'string') {
            const envKey = `${instanceName}_${key}`
              .toUpperCase()
              .replace(/-/g, '_')
            envVars[envKey] = value
          }
        }
      }
    }

    if (Object.keys(envVars).length > 0) {
      await syncEnvVars(vercelToken, project.id, envVars, [
        'production',
        'preview',
        'development',
      ])
      console.log(
        `  Synced env vars: ${Object.keys(envVars).join(', ')}`,
      )
    }

    // Configure domain
    if (config.domain) {
      await syncDomain(vercelToken, project.id, config.domain)
      console.log(`  Domain "${config.domain}" configured`)
    }

    // Write .vercel/project.json so the CLI knows which project to deploy to
    const absSourceDir = path.resolve(ctx.projectRoot, config.sourceDir)
    const vercelDir = path.join(absSourceDir, '.vercel')
    fs.mkdirSync(vercelDir, { recursive: true })
    fs.writeFileSync(
      path.join(vercelDir, 'project.json'),
      JSON.stringify({ orgId: project.accountId, projectId: project.id }),
    )

    // Deploy
    const deployUrl = deployToVercel(
      vercelToken,
      absSourceDir,
      config.production,
      ctx.projectRoot,
    )

    return {
      projectUrl: `https://${config.projectName}.vercel.app`,
      projectId: project.id,
      deployUrl,
    }
  },
  async destroy(config, ctx) {
    const vercelToken = ctx.secrets['VERCEL_TOKEN']
    if (!vercelToken) throw new Error('Missing secret: VERCEL_TOKEN')

    const project = await findProject(vercelToken, config.projectName)
    if (project) {
      await vercelFetch(`/v9/projects/${project.id}`, vercelToken, {
        method: 'DELETE',
      })
      console.log(`  Deleted project "${config.projectName}"`)
    } else {
      console.log(`  Project "${config.projectName}" not found — skipping`)
    }
  },
})
