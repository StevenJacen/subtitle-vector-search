import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const endpoint =
  'https://kwoppqigrtvgmmbnzbpx.supabase.co/functions/v1/hybrid-subtitle-search'

const queries = [
  'memory and identity',
  'Sometimes the hardest journey is finding the courage to return home.',
  'fate and free will',
  'Love survives even when time pulls people apart.',
  'power and betrayal',
  'What does it mean to remain hopeful when everything is lost?',
]

const envPath = resolve(process.argv[2] ?? '.env')
const outputPath = resolve(
  process.argv[3] ?? 'test-results/hybrid-search-random-themes.json',
)
const token = readEnvValue(await readFile(envPath, 'utf8'), 'SUBTITLE_PERSONAL_TOKEN')

const runs = []
for (const query of queries) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-subtitle-token': token,
    },
    body: JSON.stringify({ query, limit: 5 }),
  })

  const responseBody = await response.json()
  runs.push({
    query,
    limit: 5,
    httpStatus: response.status,
    response: responseBody,
  })
}

const output = {
  generatedAt: new Date().toISOString(),
  endpoint,
  retrieval: 'Supabase gte-small embedding + PostgreSQL full-text search + RRF',
  runs,
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ outputPath, statuses: runs.map(run => run.httpStatus) }))

function readEnvValue(source, name) {
  const line = source
    .split(/\r?\n/u)
    .find(candidate => candidate.startsWith(`${name}=`))
  if (line === undefined) {
    throw new Error(`${name} is missing from the environment file`)
  }

  const value = line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/u, '$2')
  if (value === '') {
    throw new Error(`${name} is empty in the environment file`)
  }
  return value
}
