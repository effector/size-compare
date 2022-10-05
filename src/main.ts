import * as path from 'path';
import {getInput, setFailed, setOutput} from '@actions/core';
import github, {context, getOctokit} from '@actions/github';
import {markdownTable} from 'markdown-table';

async function main() {
  const gistId = getInput('gist-id', {required: true});
  const token = getInput('token', {required: true});
  const bundleDirectory = path.resolve(
    process.cwd(),
    getInput('bundle-directory', {required: true}),
  );

  const mainBranch = getInput('main-branch');
  const include = getInput('include');
  const exclude = getInput('exclude');

  const octokit = getOctokit(token);

  const {} = context;

  const time = new Date().toTimeString();
  setOutput('time', time);
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
    setFailed(error.message);
  } else {
    setFailed(String(error));
  }
});
