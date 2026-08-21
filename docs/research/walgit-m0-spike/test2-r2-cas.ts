import { AwsClient } from 'aws4fetch'

const ACCOUNT = '99a19e584439be0568f33aad0477372b'
const BUCKET = 'zbc-warehouse'
const BASE = `https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}`
const KEY = `_walgit-spike/index.json`

const aws = new AwsClient({
  accessKeyId: process.env.R2_KEY!,
  secretAccessKey: process.env.R2_SECRET!,
  service: 's3',
  region: 'auto',
})

const put = (body: string, headers: Record<string, string> = {}) =>
  aws.fetch(`${BASE}/${KEY}`, { method: 'PUT', body, headers })

const ok = (b: boolean) => (b ? 'PASS' : 'FAIL')

// clean slate
await aws.fetch(`${BASE}/${KEY}`, { method: 'DELETE' })

console.log('=== A: If-None-Match "*" (create-if-absent) ===')
let r = await put(JSON.stringify({ seq: 0 }), { 'If-None-Match': '*' })
console.log(`  absent key  -> ${r.status}  ${ok(r.status === 200)}`)
const etag0 = r.headers.get('etag')
console.log(`  etag: ${etag0}`)
r = await put(JSON.stringify({ seq: 0 }), { 'If-None-Match': '*' })
console.log(`  existing key-> ${r.status}  ${ok(r.status === 412)} (want 412)`)

console.log('\n=== B: If-Match happy path ===')
r = await put(JSON.stringify({ seq: 1 }), { 'If-Match': etag0! })
console.log(`  matching etag -> ${r.status}  ${ok(r.status === 200)}`)
const etag1 = r.headers.get('etag')
console.log(`  new etag: ${etag1}  (changed: ${ok(etag0 !== etag1)})`)

console.log('\n=== C: If-Match with STALE etag (the CAS loss) ===')
r = await put(JSON.stringify({ seq: 99 }), { 'If-Match': etag0! })
console.log(`  stale etag -> ${r.status}  ${ok(r.status === 412)} (want 412)`)
const body = await aws.fetch(`${BASE}/${KEY}`)
console.log(`  stored value unchanged: ${ok((await body.text()).includes('"seq":1'))}`)

console.log('\n=== D: 16 concurrent writers, same etag — exactly one wins ===')
const cur = await aws.fetch(`${BASE}/${KEY}`)
const etagN = cur.headers.get('etag')!
const results = await Promise.all(
  Array.from({ length: 16 }, (_, i) =>
    put(JSON.stringify({ seq: 100 + i, writer: i }), { 'If-Match': etagN }).then((x) => x.status),
  ),
)
const wins = results.filter((s) => s === 200).length
const losses = results.filter((s) => s === 412).length
const other = results.filter((s) => s !== 200 && s !== 412)
console.log(`  200s=${wins}  412s=${losses}  other=${JSON.stringify(other)}`)
console.log(`  exactly one winner: ${ok(wins === 1)}`)
console.log(`  all losers are clean 412: ${ok(losses === 15)}`)

console.log('\n=== E: conditional GET (read path, If-None-Match -> 304) ===')
const g = await aws.fetch(`${BASE}/${KEY}`, {
  headers: { 'If-None-Match': (await aws.fetch(`${BASE}/${KEY}`)).headers.get('etag')! },
})
console.log(`  matching etag -> ${g.status}  ${ok(g.status === 304)} (want 304)`)

console.log('\n=== cleanup ===')
const d = await aws.fetch(`${BASE}/${KEY}`, { method: 'DELETE' })
console.log(`  delete -> ${d.status}`)
