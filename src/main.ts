import * as fs from 'fs';
import * as t from 'runtypes';
import {debug, getInput, notice, setFailed} from '@actions/core';
import {context, getOctokit} from '@actions/github';
import {create as createGlob} from '@actions/glob';
import {gzipSizeFromFile} from 'gzip-size';
import {markdownTable} from 'markdown-table';
import prettyBytes from 'pretty-bytes';

const GIST_HISTORY_FILE_NAME = 'history.json';
const GIST_PACKAGE_VERSION = 0;

const SIZE_COMPARE_HEADING =
  '## 🚛 [size-compare](https://github.com/effector/size-compare) report';
const SIZE_COMPARE_HEADING_RAW = '🚛 size-compare report';

const SizeCompareLiteral = t.Literal(GIST_PACKAGE_VERSION);

const FilesSizes = t.Dictionary(
  t.Record({
    raw: t.Number,
    gzip: t.Number,
  }),
  'string',
);

const HistoryRecord = t.Record({
  unixtimestamp: t.Number,
  commitsha: t.String,
  files: FilesSizes,
});

type HistoryRecord = t.Static<typeof HistoryRecord>;

const HistoryFile = t.Record({
  'size-compare': SizeCompareLiteral,
  history: t.Array(HistoryRecord),
});

type ChangeState = 'modified' | 'added' | 'removed' | 'not changed';

interface Change {
  state: ChangeState;
  path: string;
  raw: {
    before: number | null;
    now: number | null;
    diff: number | null;
  };
  gzip: {
    before: number | null;
    now: number | null;
    diff: number | null;
  };
}

async function main() {
  const gistId = getInput('gist_id', {required: true});
  const githubToken = getInput('github_token', {required: true});
  const gistToken = getInput('gist_token', {required: false}) || githubToken;
  const files = getInput('files', {required: true});

  const {
    payload: {pull_request, repository, compare: compareLink, commits},
    repo: {owner, repo},
    sha,
    eventName,
    ref,
  } = context;

  const masterBranch = repository?.master_branch;

  debug(
    'Start: ' +
      JSON.stringify(
        {
          eventName,
          sha,
          owner,
          repo,
          ref,
          masterBranch,
          compareLink,
          commits,
        },
        null,
        2,
      ),
  );

  const globber = await createGlob(files, {omitBrokenSymbolicLinks: true});
  const foundFilesList = await globber.glob();
  const filesSizes = await Promise.all(
    foundFilesList.map(async (path) => ({
      name: path.replace(process.cwd() + '/', ''),
      relative: path.replace(process.cwd(), '.'),
      full: path,
      size: fs.statSync(path).size,
      gzip: await gzipSizeFromFile(path),
    })),
  );

  debug(`Filter "${files.split('\n').join(', ')}" resolved to: ` + foundFilesList.join('\n'));
  debug('Files resolved to sizes: ' + JSON.stringify(filesSizes, null, 2));

  const gistOctokit = getOctokit(gistToken);
  const baseOctokit = getOctokit(githubToken);

  const gist = await gistOctokit.rest.gists.get({gist_id: gistId});
  const gistFiles: Record<string, {content: string; filename: string}> = {};

  // Read each file from gist to do not lose them on updating gist
  Object.keys(gist.data.files!).forEach((key) => {
    const file = gist.data.files?.[key];
    if (file) {
      const filename = file.filename ?? key;
      gistFiles[filename] = {
        filename,
        content: file.content ?? '',
      };
    }
  });

  const currentHistoryRecord: HistoryRecord = {
    unixtimestamp: Date.now(),
    commitsha: sha,
    files: Object.fromEntries(
      filesSizes.map((file) => [file.name, {raw: file.size, gzip: file.gzip}]),
    ),
  };
  debug('Made current history record: ' + JSON.stringify(currentHistoryRecord, null, 2));

  const historyFile = getOrCreate(gistFiles, GIST_HISTORY_FILE_NAME, {
    filename: GIST_HISTORY_FILE_NAME,
    content: `{"size-compare": ${GIST_PACKAGE_VERSION}, "history": []}`,
  });
  const originalFileContent = historyFile.content;
  const historyFileContent = HistoryFile.check(JSON.parse(originalFileContent));

  // Note: a history is written in reversed chronological order: the latest record is the first in the list
  const latestRecord = historyFileContent.history[0];
  debug('Latest record resolved: ' + JSON.stringify(latestRecord, null, 2));

  if (pull_request) {
    debug('Start Pull Request scenario');
    const previousCommentPromise = fetchPreviousComment(
      baseOctokit,
      {owner, repo},
      {number: pull_request.number},
    );

    const changes = detectChanges(latestRecord, currentHistoryRecord);
    debug(
      `Found changes between ${latestRecord.commitsha} and ${currentHistoryRecord.commitsha} in files: ` +
        JSON.stringify(changes, null, 2),
    );

    const {significant: significantChanges, rest: foldedChanges} = findSignificantChanges(changes);

    const commentBody = [
      SIZE_COMPARE_HEADING,
      createCompareLink(owner, repo, latestRecord, currentHistoryRecord),
      changesToMarkdownTable(significantChanges),
      createCollapsibleMarkdown(`Files wasn't changed`, changesToMarkdownTable(foldedChanges)),
    ].join('\r\n');

    const previousComment = await previousCommentPromise;

    if (previousComment) {
      debug('Found previous comment in PR:' + JSON.stringify(previousComment, null, 2));
      try {
        await baseOctokit.rest.issues.updateComment({
          repo,
          owner,
          comment_id: previousComment.id,
          body: commentBody,
        });
      } catch (error) {
        console.log(
          "Error updating comment. This can happen for PR's originating from a fork without write permissions.",
          error,
        );
      }
    } else {
      debug('No previous comment found. Creating new');
      try {
        await baseOctokit.rest.issues.createComment({
          repo,
          owner,
          issue_number: pull_request.number,
          body: commentBody,
        });
      } catch (error) {
        console.log(
          "Error creating comment. This can happen for PR's originating from a fork without write permissions.",
          error,
        );
      }
    }
  }

  if (!pull_request && ref === `refs/heads/${masterBranch}`) {
    debug(`Not pull request and current branch "${ref}" is the master "${masterBranch}"`);
    const recordForThisCommitIndex = historyFileContent.history.findIndex(
      (record) => record.commitsha === sha,
    );
    const previousChanges =
      historyFileContent.history[recordForThisCommitIndex - 1] ?? historyFileContent.history[0];
    const alreadyCheckedSizeByHistory = recordForThisCommitIndex !== -1;

    if (alreadyCheckedSizeByHistory) {
      debug(`For the commit ${sha} size was already checked`);
      historyFileContent.history[recordForThisCommitIndex] = currentHistoryRecord;
    } else {
      debug(`Create new history record for the ${sha} commit`);
      historyFileContent.history.unshift(currentHistoryRecord);
    }

    const changes = detectChanges(previousChanges, currentHistoryRecord);
    debug(
      `Detected changes for commits between ${previousChanges.commitsha} and ${currentHistoryRecord.commitsha}:` +
        JSON.stringify(changes, null, 2),
    );

    const updatedHistoryContent = JSON.stringify(historyFileContent, null, 2);
    historyFile.content = updatedHistoryContent;

    // Do not commit GIST if no changes
    if (updatedHistoryContent !== originalFileContent) {
      debug('History changed, updating GIST');
      await gistOctokit.rest.gists.update({
        gist_id: gistId,
        files: gistFiles,
      });
    } else {
      debug('Looks like there is no changes in the history');
    }

    await reportNoticeForChanges(changes);
    await baseOctokit.rest.repos.createCommitComment({
      repo,
      owner,
      commit_sha: sha,
      body: [
        SIZE_COMPARE_HEADING,
        createCompareLink(owner, repo, latestRecord, currentHistoryRecord),
        changesToMarkdownTable(changes),
      ].join('\r\n'),
    });
  }
}

async function fetchPreviousComment(
  octokit: ReturnType<typeof getOctokit>,
  repo: {owner: string; repo: string},
  pr: {number: number},
) {
  const comments = await octokit.rest.issues.listComments({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: pr.number,
  });

  const sizeCompareComment = comments.data.find((comment) =>
    comment.body?.startsWith(SIZE_COMPARE_HEADING),
  );

  return sizeCompareComment ?? null;
}

function getOrCreate<T>(record: Record<string, T>, key: string, defaultValue: T): T {
  if (!record[key]) {
    record[key] = defaultValue;
  }
  return record[key];
}

type RecordedItem<K extends string, V extends string, T> = Record<K, string> & Record<V, T>;

function recordToList<T, K extends string, V extends string>(
  record: Record<string, T>,
  key: K,
  value: V,
): Array<RecordedItem<K, V, T>> {
  return Object.entries(record).map(([k, v]) => ({
    [key]: k,
    [value]: v,
  })) as Array<RecordedItem<K, V, T>>;
}

main().catch((error) => {
  if (error instanceof Error) {
    setFailed(error.message);
  } else {
    setFailed(String(error));
  }
});

function difference(a: number, b: number): number {
  return (Math.abs(a - b) / a) * Math.sign(b - a) * 100;
}

function signedFixedPercent(value: number): string {
  if (value === 0) {
    return '=';
  }
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function applyExists(value: number | null, fn: (value: number) => string) {
  if (value === null) return '';
  return fn(value);
}

function detectChanges(previous: HistoryRecord, current: HistoryRecord) {
  const masterFiles = {...(previous?.files ?? {})};
  const prFiles = recordToList(current.files, 'path', 'size');

  const changes: Change[] = [];

  prFiles.forEach(({path, size: current}) => {
    const masterFile = masterFiles[path];
    if (typeof masterFile !== 'undefined') {
      const raw = {
        before: masterFile.raw,
        now: current.raw,
        diff: difference(masterFile.raw, current.raw),
      };
      const gzip = {
        before: masterFile.gzip,
        now: current.gzip,
        diff: difference(masterFile.gzip, current.gzip),
      };
      const hasChanges = raw.diff !== 0;

      if (hasChanges) {
        changes.push({state: 'modified', path, raw, gzip});
      } else {
        changes.push({state: 'not changed', path, raw, gzip});
      }
      delete masterFiles[path];
    } else {
      changes.push({
        state: 'added',
        path,
        raw: {before: null, now: current.raw, diff: null},
        gzip: {before: null, now: current.gzip, diff: null},
      });
    }
  });

  recordToList(masterFiles, 'path', 'size').forEach(({path, size: masterFile}) => {
    changes.push({
      state: 'removed',
      path,
      raw: {
        before: masterFile.raw,
        now: null,
        diff: null,
      },
      gzip: {
        before: masterFile.gzip,
        now: null,
        diff: null,
      },
    });
  });

  return changes;
}

function createCompareLink(
  owner: string,
  repo: string,
  before: HistoryRecord,
  current: HistoryRecord,
): string {
  const link = `https://github.com/${owner}/${repo}/compare/${before.commitsha}...${current.commitsha}`;
  return `Comparing [${before.commitsha.slice(0, 8)}...${current.commitsha.slice(0, 8)}](${link})`;
}

function changesToMarkdownTable(changes: Change[]) {
  return markdownTable([
    ['File', '+/-', 'Base', 'Current', '+/- gzip', 'Base gzip', 'Current gzip'],
    ...changes.map(({path, raw, gzip}) => {
      return [
        path,
        applyExists(raw.diff, signedFixedPercent),
        applyExists(raw.before, prettyBytes),
        applyExists(raw.now, prettyBytes),
        applyExists(gzip.diff, signedFixedPercent),
        applyExists(gzip.before, prettyBytes),
        applyExists(gzip.now, prettyBytes),
      ];
    }),
  ]);
}

function createCollapsibleMarkdown(title: string, content: string): string {
  return `<details>
<summary>${title}</summary>

${content}

</details>`;
}

function findSignificantChanges(changes: Change[]): {
  significant: Change[];
  rest: Change[];
} {
  const significant: Change[] = [];
  const rest: Change[] = [];

  changes.forEach((change) => {
    if (change.state !== 'not changed') significant.push(change);
    else rest.push(change);
  });

  return {significant, rest};
}

async function reportNoticeForChanges(changes: Change[]) {
  const {significant: significantChanges} = findSignificantChanges(changes);
  if (significantChanges.length > 0) {
    const table = changesToMarkdownTable(significantChanges);
    const content = `This commit add changes to bundle size:\r\n${table}`;
    notice(content, {title: SIZE_COMPARE_HEADING_RAW});
  }
}
