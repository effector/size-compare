import * as path from 'path';
import core from '@actions/core';
import github, {context, getOctokit} from '@actions/github';
import {markdownTable} from 'markdown-table';

async function main() {
  const gistId = core.getInput('gist-id', {required: true});
  const token = core.getInput('token', {required: true});
  const bundleDirectory = path.resolve(
    process.cwd(),
    core.getInput('bundle-directory', {required: true}),
  );

  const mainBranch = core.getInput('main-branch');
  const include = core.getInput('include');
  const exclude = core.getInput('exclude');

  const octokit = getOctokit(token);

  const {} = context;

  const time = new Date().toTimeString();
  core.setOutput('time', time);
  // Get the JSON webhook payload for the event that triggered the workflow
  const payload = JSON.stringify(context.payload, undefined, 2);
  console.log(`The event payload: ${payload}`);
  console.log(
    markdownTable([
      ['Branch', 'Commit'],
      ['main', 'asdasda'],
    ]),
  );
}

main().catch((error) => {
  if (error instanceof Error) {
    core.setFailed(error.message);
  } else {
    core.setFailed(String(error));
  }
});
