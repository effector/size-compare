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

  const include = getInput('include');
  const exclude = getInput('exclude');

  const {
    payload: {pull_request, repository},
    repo,
    sha,
    action,
    eventName,
  } = context;

  const masterBranch = repository?.master_branch;

  console.log(
    '>>',
    JSON.stringify(
      {
        pull_request,
        repository,
        repo,
        sha,
        action,
        eventName,
        masterBranch,
      },
      null,
      2,
    ),
  );

  const octokit = getOctokit(token);

  const gist = await octokit.rest.gists.get({gist_id: gistId});
  console.log(gist);

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
