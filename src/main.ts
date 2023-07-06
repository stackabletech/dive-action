import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import stripAnsi from 'strip-ansi'
import fs from 'fs'

function format(output: string): string {
  const ret = ['**The container image has inefficient files.**']
  let summarySection = false
  let inefficientFilesSection = false
  let resultSection = false

  for (const line of output.split('\n')) {
    if (line.includes('Analyzing image')) {
      summarySection = true
      inefficientFilesSection = false
      resultSection = false
      ret.push('### Summary')
    } else if (line.includes('Inefficient Files:')) {
      summarySection = false
      inefficientFilesSection = true
      resultSection = false
      ret.push('### Inefficient Files')
    } else if (line.includes('Results:')) {
      summarySection = false
      inefficientFilesSection = false
      resultSection = true
      ret.push('### Results')
    } else if (summarySection || resultSection) {
      ret.push(stripAnsi(line))
    } else if (inefficientFilesSection) {
      if (line.startsWith('Count')) {
        ret.push('| Count | Wasted Space | File Path |')
        ret.push('|---|---|---|')
      } else {
        // https://github.com/wagoodman/dive/blob/master/runtime/ci/evaluator.go#L140
        ret.push(
          `| ${line.slice(0, 5)} | ${line.slice(7, 19)} | ${line.slice(21)} |`
        )
      }
    }
  }
  return ret.join('\n')
}

async function run(): Promise<void> {
  try {
    const image = core.getInput('image')
    const configFile = core.getInput('config-file')
    const diveImage = core.getInput('dive-image')
    const reportOnly = Boolean(core.getInput('report-only'))

    await exec.exec('docker', ['pull', diveImage])

    const dockerOptions = [
      '-e',
      'CI=true',
      '-e',
      'DOCKER_API_VERSION=1.37',
      '--rm',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock'
    ]

    const diveOptions = []

    if (configFile && !fs.existsSync(configFile)) {
      if (fs.existsSync(configFile)) {
        dockerOptions.push(
          '--mount',
          `type=bind,source=${configFile},target=/.dive-ci`
        )
        diveOptions.push('--config-file', '/.dive-ci')
      } else {
        core.setFailed(`Dive configuration file ${configFile} doesn't exist!`)
        return
      }
    }

    const parameters = [
      'run',
      ...dockerOptions,
      diveImage,
      image,
      ...diveOptions
    ]
    let output = ''
    const execOptions = {
      ignoreReturnCode: true,
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString()
        },
        stderr: (data: Buffer) => {
          output += data.toString()
        }
      }
    }
    const exitCode = await exec.exec('docker', parameters, execOptions)

    if (exitCode === 0 && !reportOnly) {
      // success
      return
    }

    const token = core.getInput('github-token')
    if (!token) {
      return
    }

    const octokit = github.getOctokit(token)
    const comment = {
      ...github.context.issue,
      issue_number: github.context.issue.number,
      body: format(output)
    }
    await octokit.rest.issues.createComment(comment)

    if (!reportOnly) {
      core.setFailed(`Scan failed (exit code: ${exitCode})`)
    }
  } catch (error) {
    core.setFailed(String(error))
  }
}

run()
