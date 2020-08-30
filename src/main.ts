import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as github from '@actions/github'
import * as convert from 'xml-js'
import * as fs from 'fs'
import * as path from 'path'

type Annotation = {
  path: string
  start_line: number
  end_line: number
  start_column: number
  end_column: number
  annotation_level: 'warning' | 'failure' | 'notice'
  message: string
  title: string
  raw_details: string
}

const octokit = github.getOctokit(core.getInput('token', {required: true}))

async function submitAnnotations(annotations: Annotation[]): Promise<void> {
  const MAX_CHUNK_SIZE = 40
  const TOTAL_CHUNKS = Math.ceil(annotations.length / MAX_CHUNK_SIZE)
  const CHECK_NAME = 'Android Lint'

  const {
    data: {id: checkId}
  } = await octokit.checks.create({
    ...github.context.repo,
    started_at: new Date().toISOString(),
    head_sha: github.context.sha,
    status: 'in_progress',
    name: CHECK_NAME
  })

  for (let chunk = 0; chunk < TOTAL_CHUNKS; chunk++) {
    const startChunk = chunk * MAX_CHUNK_SIZE
    const endChunk = startChunk + MAX_CHUNK_SIZE

    core.debug(
      `Uploading chunk ${chunk} with annotations ${startChunk} trough ${endChunk}`
    )

    await octokit.checks.update({
      ...github.context.repo,
      check_run_id: checkId,
      status: TOTAL_CHUNKS === chunk ? 'completed' : 'in_progress',
      output: {
        title: 'Android Lint results',
        summary: 'Android Lint results',
        annotations: annotations.slice(startChunk, endChunk)
      }
    })
  }
}

function stripFilePath(filePath: string): string | null {
  const filePathParts = filePath.split(path.sep)

  const repoPath = path.resolve('.')
  const repoPathParts = repoPath.split(path.sep)

  // eslint-disable-next-line @typescript-eslint/no-for-in-array
  for (const i in repoPathParts) {
    if (repoPathParts[i] !== filePathParts[i]) return null
  }

  return filePathParts.slice(repoPathParts.length).join(path.sep)
}

async function run(): Promise<void> {
  const globber = await glob.create('**/build/reports/lint-results.xml')

  for await (const file of globber.globGenerator()) {
    core.debug(`creating annotations from ${file}`)

    const report = fs.readFileSync(file, 'utf8')
    const xml = convert.xml2js(report)
    const annotations: Annotation[] = []

    for (const issueElement of xml.elements[0].elements) {
      // Skip if we somehow encounter a different element then issue
      if (issueElement.name !== 'issue') continue

      for (const locationElement of issueElement.elements) {
        // Skip if we somehow got a different element
        if (locationElement.name !== 'location') continue

        // get the file lication in the repository
        const repoFilePath = stripFilePath(locationElement.attributes['file'])

        /// Skip if the location was not in the repository
        if (repoFilePath === null) continue
        if (locationElement.attributes['column'] === undefined) continue
        if (locationElement.attributes['line'] === undefined) continue

        core.debug(
          `${repoFilePath}: ${locationElement.attributes['line']},${locationElement.attributes['column']}`
        )

        annotations.push({
          path: repoFilePath,
          start_line: parseInt(locationElement.attributes['line'], 10),
          end_line: parseInt(locationElement.attributes['line'], 10),
          start_column: parseInt(locationElement.attributes['column'], 10),
          end_column: parseInt(locationElement.attributes['column'], 10),
          annotation_level:
            issueElement.attributes['severity'] === 'Warning'
              ? 'warning'
              : 'failure',
          message: issueElement.attributes['message'],
          title: `${issueElement.attributes['category']} - ${issueElement.attributes['summary']}`.substr(
            0,
            255
          ),
          raw_details: issueElement.attributes['explanation']
        })
      }
    }

    return submitAnnotations(annotations)
  }
}

// eslint-disable-next-line github/no-then
run().catch(core.setFailed)
