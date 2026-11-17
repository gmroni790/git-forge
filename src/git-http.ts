// Git smart-HTTP router: info/refs, git-upload-pack, git-receive-pack.
// Path matching, 404s, content-types, v2-vs-v0 selection, malformed-body
// survival. Auth is enforced by app.ts before routing; no auth code here.

import type { Ctx } from './types.ts';
import type { Store } from './store.ts';
import type { Repo } from './types.ts';
import { sendBuffer, sendJson } from './util.ts';
import {
  advertisementV0,
  advertisementV2,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  parsePktLines,
} from './git-protocol.ts';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Read the first pkt-line's text, for v2 command dispatch / body sniffing. */
function firstPktLineText(body: Buffer): string {
  const parsed = parsePktLines(body);
  if (parsed.lines.length === 0) return '';
  return parsed.lines[0].toString('utf8').replace(/\n$/, '');
}

/** Dispatch a v2 upload-pack body by its `command=` line. */
function handleV2UploadPack(store: Store, repo: Repo, body: Buffer): Buffer {
  const command = firstPktLineText(body);
  if (command === 'command=ls-refs') return handleLsRefs(store, repo, body);
  if (command === 'command=fetch') return handleFetchV2(store, repo, body);
  throw new Error(`unknown v2 upload-pack command: ${JSON.stringify(command.slice(0, 60))}`);
}

/**
 * Dispatch a git-upload-pack POST. The Git-Protocol header decides when
 * present (the client sends it on v2 POSTs under auto preference); otherwise
 * fall back to sniffing the body's first pkt-line for a v2 `command=` line,
 * else treat it as a v0 want/have fetch.
 */
function handleUploadPack(store: Store, repo: Repo, ctx: Ctx): Buffer {
  const header = ctx.req.headers['git-protocol'];
  if (header === 'version=2') return handleV2UploadPack(store, repo, ctx.body);
  const command = firstPktLineText(ctx.body);
  if (command === 'command=ls-refs') return handleLsRefs(store, repo, ctx.body);
  if (command === 'command=fetch') return handleFetchV2(store, repo, ctx.body);
  return handleFetchV0(store, repo, ctx.body);
}

/**
 * Route git smart-HTTP requests. Returns true when the request was handled
 * (response written), false when the path is not a git route (app.ts falls
 * through to its 404). Malformed bodies never throw out of here: they get a
 * 400 and the server stays healthy.
 */
export async function routeGit(ctx: Ctx): Promise<boolean> {
  const { store } = ctx;
  if (ctx.segments.length < 2) return false;
  const repoSegment = ctx.segments[1];
  if (!repoSegment.endsWith('.git')) return false;
  const owner = ctx.segments[0];
  const repoName = repoSegment.slice(0, -'.git'.length);
  const rest = ctx.segments.slice(2);
  const isInfoRefs = ctx.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs';
  const isUploadPack = ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack';
  const isReceivePack = ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;

  // A known git route for a repo that does not exist (or an owner that is not
  // the viewer): 404, same rule as REST. The server keeps serving other repos.
  if (owner !== store.viewer.login) {
    sendJson(ctx.res, 404, { message: 'Not Found' });
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(ctx.res, 404, { message: 'Not Found' });
    return true;
  }

  try {
    if (isInfoRefs) {
      const service = ctx.query.get('service');
      if (service === 'git-upload-pack') {
        const v2 = ctx.req.headers['git-protocol'] === 'version=2';
        if (v2) sendBuffer(ctx.res, 200, advertisementV2(store, repo), UPLOAD_ADVERTISEMENT);
        else sendBuffer(ctx.res, 200, advertisementV0(store, repo, 'git-upload-pack'), UPLOAD_ADVERTISEMENT);
      } else if (service === 'git-receive-pack') {
        sendBuffer(ctx.res, 200, advertisementV0(store, repo, 'git-receive-pack'), RECEIVE_ADVERTISEMENT);
      } else {
        sendJson(ctx.res, 404, { message: 'Not Found' });
      }
      return true;
    }
    if (isUploadPack) {
      sendBuffer(ctx.res, 200, handleUploadPack(store, repo, ctx), UPLOAD_RESULT);
      return true;
    }
    sendBuffer(ctx.res, 200, handleReceivePack(store, repo, ctx.body), RECEIVE_RESULT);
    return true;
  } catch {
    // Malformed body (or any other failure inside a git handler): 400, never
    // a crash, never corrupted state.
    try {
      sendJson(ctx.res, 400, { message: 'Bad Request' });
    } catch {
      // Response already gone; nothing more to do.
    }
    return true;
  }
}
