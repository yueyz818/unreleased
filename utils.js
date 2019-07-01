const fetch = require('node-fetch')

const GH_API_PREFIX = 'https://api.github.com'
const ORGANIZATION_NAME = 'electron'
const REPO_NAME = 'electron'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const NUM_SUPPORTED_VERSIONS = 4
const SLACK_USER = 'releases-wg'

async function getAll(urlEndpoint) {
  const objects = []
  for await (const obj of getAllGenerator(urlEndpoint)) objects.push(obj)
  return objects
}

async function* getAllGenerator(urlEndpoint) {
  let next = urlEndpoint
  while (true) {
    const resp = await fetch(next, { 
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    })

    if (!resp.ok) {
      if (resp.headers.get('x-ratelimit-remaining') === '0') {
        const resetTime = Math.round(resp.headers.get('x-ratelimit-reset') - Date.now() / 1000)
        throw new Error(`Ratelimited. Resets in ${resetTime} seconds.`)
      }
      throw new Error(`${resp.status} ${resp.statusText}`)
    }
  
    const json = await resp.json()
    yield *json
  
    if (!resp.headers.get('link')) break
    const next_link = resp.headers.get('link')
      .split(/,/)
      .map(x => x.split(/;/))
      .find(x => x[1].includes('next'))
    
    if (!next_link) break
    next = next_link[0].trim().slice(1, -1)
  }
}

function linkifyPRs(msg) {
  return msg.replace(/#(\d+)/g, (_, pr_id) =>
    `<https://github.com/${ORGANIZATION_NAME}/${REPO_NAME}/pull/${pr_id}|#${pr_id}>`)
}

function buildCommitsMessage(branch, commits, initiatedBy) {
  if (!commits || commits.length === 0) return `*No unreleased commits on ${branch}*`

  const formattedCommits = commits.map(c => {
    const prLink = linkifyPRs(c.commit.message.split(/[\r\n]/, 1)[0])
    return `- \`<${c.html_url}|${c.sha.slice(0, 8)}>\` ${prLink}`
  }).join('\n')

  let response = `Unreleased commits in *${branch}* (from ${initiatedBy}):\n${formattedCommits}`
  if (commits.length >= 10) {
    response += `\n <@${SLACK_USER}>, there are a lot of unreleased commits on \`${branch}\`! Time for a release?`
  }
  return response
}

async function fetchUnreleasedCommits(branch) {
  const tags = await getAll(`${GH_API_PREFIX}/repos/${ORGANIZATION_NAME}/${REPO_NAME}/tags`)
  const unreleased = []
  const url = `${GH_API_PREFIX}/repos/${ORGANIZATION_NAME}/${REPO_NAME}/commits?sha=${branch}`

  for await (const commit of getAllGenerator(url)) {
    const tag = tags.find(t => t.commit.sha === commit.sha)
    if (tag) {
      const isDraft =  await releaseIsDraft(tag.name)
      if (!isDraft) break
    }
    unreleased.push(commit)
  }
  return unreleased
}

async function releaseIsDraft(tag) {
  const releaseEndpoint = `${GH_API_PREFIX}/repos/${ORGANIZATION_NAME}/${REPO_NAME}/releases/tags/${tag}`
  const res = await fetch(releaseEndpoint)
  return res.status === 404
}

async function getSupportedBranches() {
  const branchEndpoint = `${GH_API_PREFIX}/${ORGANIZATION_NAME}/${REPO_NAME}/branches`
  const resp = await fetch(branchEndpoint)

  let branches = await resp.json()
  branches = branches.filter(branch => {
    return branch.protected && branch.name.match(/[0-9]-[0-9]-x/)
  }).map(b => b.name)

  const filtered = {}
  branches.sort().forEach(branch => filtered[branch.charAt(0)] = branch)
  return Object.values(filtered).slice(-NUM_SUPPORTED_VERSIONS)
}
module.exports = {
  buildCommitsMessage,
  fetchUnreleasedCommits,
  getSupportedBranches
}
