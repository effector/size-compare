import * as fs from 'fs';
import * as t from 'runtypes';
import {getInput, setFailed} from '@actions/core';
import {context, getOctokit} from '@actions/github';
import {create as createGlob} from '@actions/glob';
import {gzipSizeFromFile} from 'gzip-size';
import {markdownTable} from 'markdown-table';
import prettyBytes from 'pretty-bytes';

const GIST_HISTORY_FILE_NAME = 'history.json';
const GIST_PACKAGE_VERSION = 0;

const SIZE_COMPARE_HEADING =
  '## 🚛 [size-compare](https://github.com/effector/size-compare) report';

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

async function main() {
  const gistId = getInput('gist_id', {required: true});
  const gistToken = getInput('gist_token', {required: true});
  const githubToken = getInput('github_token', {required: false}) || gistToken;
  const files = getInput('files', {required: true});

  const {
    payload: {pull_request, repository, compare: compareLink, commits},
    repo: {owner, repo},
    sha,
    eventName,
    ref,
  } = context;

  const masterBranch = repository?.master_branch;

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

  const historyFile = getOrCreate(gistFiles, GIST_HISTORY_FILE_NAME, {
    filename: GIST_HISTORY_FILE_NAME,
    content: `{"size-compare": ${GIST_PACKAGE_VERSION}, "history": []}`,
  });
  const originalFileContent = historyFile.content;
  const historyFileContent = HistoryFile.check(JSON.parse(originalFileContent));

  // Note: a history is written in reversed chronological order: the latest is the first
  const latestRecord = historyFileContent.history[0];

  if (pull_request) {
    const previousCommentPromise = fetchPreviousComment(
      baseOctokit,
      {owner, repo},
      {number: pull_request.number},
    );
    const masterFiles = {...(latestRecord?.files ?? {})};
    const prFiles = recordToList(currentHistoryRecord.files, 'path', 'size');

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
          diff: difference(masterFile.raw, current.gzip),
        };
        const hasChanges = raw.diff !== 0;

        if (hasChanges) {
          // changes.push({state: 'not changed', path, raw, gzip});
        } else {
          changes.push({state: 'modified', path, raw, gzip});
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

    const commentBody = [
      SIZE_COMPARE_HEADING,
      markdownTable([
        ['File', '+/-', 'Base', 'Current', '+/- gzip', 'Base gzip', 'Current gzip'],
        ...changes.map(({path, raw, gzip}) => {
          return [
            path,
            raw.diff ? signedFixedPercent(raw.diff) : '',
            raw.before ? prettyBytes(raw.before) : '',
            raw.now ? prettyBytes(raw.now) : '',
            gzip.diff ? signedFixedPercent(gzip.diff) : '',
            gzip.before ? prettyBytes(gzip.before) : '',
            gzip.now ? prettyBytes(gzip.now) : '',
          ];
        }),
      ]),
    ].join('\r\n');

    function difference(a: number, b: number): number {
      return (Math.abs(a - b) / a) * Math.sign(b - a) * 100;
    }
    function signedFixedPercent(value: number): string {
      if (value === 0) {
        return '=';
      }
      return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
    }

    const previousComment = await previousCommentPromise;

    if (previousComment) {
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

  if (!pull_request) {
    const recordForThisCommitIndex = historyFileContent.history.findIndex(
      (record) => record.commitsha === sha,
    );
    const alreadyCheckedSizeByHistory = recordForThisCommitIndex !== -1;

    if (alreadyCheckedSizeByHistory) {
      historyFileContent.history[recordForThisCommitIndex] = currentHistoryRecord;
    } else {
      historyFileContent.history.unshift(currentHistoryRecord);
    }

    const updatedHistoryContent = JSON.stringify(historyFileContent, null, 2);
    historyFile.content = updatedHistoryContent;

    // Do not commit GIST if no changes
    if (updatedHistoryContent !== originalFileContent) {
      console.log('History changed, updating GIST');
      await gistOctokit.rest.gists.update({
        gist_id: gistId,
        files: gistFiles,
      });
    }
  }

  console.log(
    '>>',
    JSON.stringify(
      {
        commits,
        files,
        list: filesSizes,
        pull_request,
        repository,
        owner,
        repo,
        ref,
        sha,
        compareLink,
        eventName,
        masterBranch,
      },
      null,
      2,
    ),
  );
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
