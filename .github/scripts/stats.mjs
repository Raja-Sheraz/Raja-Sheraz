// Regenerates assets/highlights.svg from live GitHub data.
//
// Design rules, so the card never ages badly:
//   1. No calendar year appears in any label. The window is "last 12 months", always true.
//   2. Three of the four tiles are cumulative, so a quiet month never makes the card shrink.
//   3. The headline project is whichever repo actually has the most commits, never a fixed name.
//
// Private work counts. GraphQL's contributionsCollection returns private activity only as an
// opaque "restricted" lump with no per-repository breakdown, so commits come from the commit
// search API instead, which does see private repositories the token can read.
//
// Requires a token with: repo, read:org, read:user.

import { writeFileSync, mkdirSync } from 'node:fs'

const token = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN
const login = process.env.GH_LOGIN || 'Raja-Sheraz'

if (!token) {
  console.error('No STATS_TOKEN or GITHUB_TOKEN set.')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z')
const fmt = (n) => n.toLocaleString('en-US')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function api (path, accept) {
  const res = await fetch('https://api.github.com' + path, {
    headers: {
      authorization: 'bearer ' + token,
      accept: accept || 'application/vnd.github+json',
      'user-agent': login
    }
  })
  if (!res.ok) throw new Error('GitHub REST ' + res.status + ' on ' + path + ': ' + (await res.text()))
  return res.json()
}

async function gql (query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: 'bearer ' + token,
      'content-type': 'application/json',
      'user-agent': login
    },
    body: JSON.stringify({ query, variables })
  })
  if (!res.ok) throw new Error('GitHub GraphQL ' + res.status + ': ' + (await res.text()))
  const body = await res.json()
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data
}

// Commit search is rate limited at ~30/min, so retry once on 403 rather than failing the run.
async function commitCount (query) {
  const path = '/search/commits?q=' + encodeURIComponent(query) + '&per_page=1'
  try {
    return (await api(path)).total_count
  } catch (err) {
    if (!String(err).includes('403')) throw err
    await sleep(60000)
    return (await api(path)).total_count
  }
}

const now = new Date()

// --- Contributions, from the calendar (this is the one source that counts private work) ---
const CAL = `
  query ($from: DateTime!, $to: DateTime!) {
    viewer {
      createdAt
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar { totalContributions }
      }
    }
  }
`

const yearAgo = new Date(now)
yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1)

const recent = await gql(CAL, { from: iso(yearAgo), to: iso(now) })
const contributions12mo = recent.viewer.contributionsCollection.contributionCalendar.totalContributions
const createdAt = new Date(recent.viewer.createdAt)

let contributionsAllTime = 0
for (let y = createdAt.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
  let from = new Date(Date.UTC(y, 0, 1))
  let to = new Date(Date.UTC(y, 11, 31, 23, 59, 59))
  if (from < createdAt) from = createdAt
  if (to > now) to = now

  const data = await gql(CAL, { from: iso(from), to: iso(to) })
  contributionsAllTime += data.viewer.contributionsCollection.contributionCalendar.totalContributions
}

// --- Commits, all time, including private repositories ----------------------
const commitsAllTime = await commitCount('author:' + login)

// --- Merged pull requests, all time -----------------------------------------
const prs = await gql(
  'query ($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }',
  { q: 'author:' + login + ' is:pr is:merged' }
)
const mergedPRs = prs.search.issueCount

// --- Headline project: the repo with the most commits by this author --------
const repos = []
for (let page = 1; page <= 5; page++) {
  const batch = await api(
    '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=' + page
  )
  repos.push(...batch)
  if (batch.length < 100) break
}

// Only repos touched since the account was created are worth a search call.
const candidates = repos
  .filter((r) => new Date(r.pushed_at) > createdAt)
  .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
  .slice(0, 30)

let topRepo = ''
let topRepoCommits = 0

for (const repo of candidates) {
  const n = await commitCount('author:' + login + ' repo:' + repo.full_name)
  if (n > topRepoCommits) {
    topRepoCommits = n
    topRepo = repo.full_name
  }
  await sleep(2500)
}

const topRepoName = topRepo.split('/')[1] || topRepo

const stats = {
  contributions12mo,
  contributionsAllTime,
  commitsAllTime,
  mergedPRs,
  topRepoName,
  topRepoCommits,
  reposSearched: candidates.length
}
console.log(stats)

if (!contributions12mo && !commitsAllTime) {
  console.error('Refusing to write an empty card.')
  process.exit(1)
}

// --- Render ------------------------------------------------------------------
const updated = now.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })

const tiles = [
  { value: fmt(contributions12mo), label: 'contributions', sub: 'in the last 12 months' },
  { value: fmt(commitsAllTime), label: 'commits', sub: 'authored, public and private' },
  { value: fmt(mergedPRs), label: 'pull requests', sub: 'reviewed and merged' },
  { value: fmt(topRepoCommits), label: 'commits to ' + topRepoName, sub: 'my most active codebase', accent: true }
]

const W = 1200
const H = 290
const PAD = 40
const GAP = 24
const tileW = (W - PAD * 2 - GAP * 3) / 4
const FONT = 'Segoe UI, Helvetica, Arial, sans-serif'

const tileSvg = tiles.map((t, i) => {
  const x = PAD + i * (tileW + GAP)
  const fill = t.accent ? '#FBBF24' : '#FFFFFF'
  return [
    '  <g transform="translate(' + x + ', 118)">',
    '    <rect width="' + tileW + '" height="118" rx="12" fill="#12235C" stroke="#1E3A8A"/>',
    '    <text x="22" y="50" font-family="' + FONT + '" font-size="40" font-weight="700" fill="' + fill + '">' + esc(t.value) + '</text>',
    '    <text x="22" y="76" font-family="' + FONT + '" font-size="15" fill="#DBE6FF">' + esc(t.label) + '</text>',
    '    <text x="22" y="97" font-family="' + FONT + '" font-size="12.5" fill="#8FA6D4">' + esc(t.sub) + '</text>',
    '  </g>'
  ].join('\n')
}).join('\n')

const alt = fmt(contributions12mo) + ' contributions in the last 12 months, '
  + fmt(commitsAllTime) + ' commits authored across public and private repositories, '
  + fmt(mergedPRs) + ' pull requests merged, and '
  + fmt(topRepoCommits) + ' commits to ' + topRepoName + ', my most active codebase.'

const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(alt) + '">',
  '  <title>' + esc(alt) + '</title>',
  '  <defs>',
  '    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
  '      <stop offset="0%" stop-color="#0B1842"/>',
  '      <stop offset="100%" stop-color="#16307A"/>',
  '    </linearGradient>',
  '  </defs>',
  '',
  '  <rect width="' + W + '" height="' + H + '" rx="18" fill="url(#bg)"/>',
  '',
  '  <text x="' + PAD + '" y="52" font-family="' + FONT + '" font-size="13" font-weight="600" letter-spacing="2.5" fill="#56C7E8">AT A GLANCE</text>',
  '  <text x="' + PAD + '" y="88" font-family="' + FONT + '" font-size="26" font-weight="700" fill="#FFFFFF">Live numbers from my work</text>',
  '  <text x="' + (W - PAD) + '" y="52" text-anchor="end" font-family="' + FONT + '" font-size="12.5" fill="#8FA6D4">Updated automatically &#183; ' + esc(updated) + '</text>',
  '',
  tileSvg,
  '',
  '  <text x="' + PAD + '" y="268" font-family="' + FONT + '" font-size="12" fill="#7E95C6">Counted from the GitHub API, including private repositories. Regenerated daily by a GitHub Action.</text>',
  '</svg>',
  ''
].join('\n')

mkdirSync('assets', { recursive: true })
writeFileSync('assets/highlights.svg', svg)
console.log('wrote assets/highlights.svg (' + svg.length + ' bytes)')
