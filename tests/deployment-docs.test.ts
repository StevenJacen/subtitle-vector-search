import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8')

it('documents hosted deployment in migration-before-function order', () => {
  const login = readme.indexOf('npx supabase login')
  const link = readme.indexOf('npx supabase link --project-ref kwoppqigrtvgmmbnzbpx')
  const push = readme.indexOf('npx supabase db push')
  const secrets = readme.indexOf('npx supabase secrets set SUBTITLE_PERSONAL_TOKEN=<random-secret>')
  const deploy = readme.indexOf('npx supabase functions deploy ingest-subtitles --no-verify-jwt')

  expect(login).toBeGreaterThan(-1)
  expect(link).toBeGreaterThan(login)
  expect(push).toBeGreaterThan(link)
  expect(secrets).toBeGreaterThan(push)
  expect(deploy).toBeGreaterThan(secrets)
  expect(readme).toContain('npx supabase migration list')
  expect(readme).toContain('npx supabase db lint --linked --level warning')
  expect(readme).toContain('Remote deployment compilation is mandatory')
})
