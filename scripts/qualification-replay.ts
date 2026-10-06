import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, lstat, open, opendir, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, parse, join, sep } from 'node:path';
import { ReplayRunner, simulationChecksum, type EngineIdentity, type ReplayRecording } from '@frontier/simulation';
import type { CommandReceipt, PlayerView } from '@frontier/shared';

type MatchBoundary = Pick<PlayerView, 'matchId' | 'matchEpoch'>;
/** A reconnect may discard an old unresolved command before it can be resent.
 * Check every observed boundary before the completion predicate, including when
 * another recipient is still awaiting a view. A missing resync view alone is not
 * evidence of a changed boundary; the caller retains its normal completion test. */
export function qualificationReceiptWaitReady(boundaries: readonly { expected: MatchBoundary; observed: MatchBoundary | undefined }[], ready: () => boolean, phase: 'setup' | 'reconnect'): boolean {
  for (const { expected, observed } of boundaries) if (observed && (observed.matchId !== expected.matchId || observed.matchEpoch !== expected.matchEpoch))
    throw new Error(`${phase === 'setup' ? 'SETUP' : 'RECONNECT'}_MATCH_BOUNDARY_CHANGED_DURING_RECEIPT_REPLAY`);
  return ready();
}

/** A boundary can change after the harness precheck but before the replay is admitted.
 * Stale authority must still fail qualification; it is not a changed cached receipt. */
export function assertQualificationReceiptReplay(original: CommandReceipt, replayed: CommandReceipt, phase: 'setup' | 'reconnect'): void {
  if (JSON.stringify(original) === JSON.stringify(replayed)) return;
  if (original.status === 'accepted' && replayed.status === 'rejected' && replayed.code === 'STALE_MATCH' && replayed.clientCommandId === original.clientCommandId)
    throw new Error(`${phase === 'setup' ? 'SETUP' : 'RECONNECT'}_MATCH_BOUNDARY_CHANGED_DURING_RECEIPT_REPLAY`);
  throw new Error(phase === 'setup' ? 'DUPLICATE_RECEIPT_CHANGED' : 'RECONNECT_DUPLICATE_CHANGED');
}

interface ExpectedTerminal {
  matchId: string; matchEpoch: number; tick: number; result: NonNullable<PlayerView['result']>;
}
/** Host-only post-match verification. No scheduler, endpoint, sockets or live simulation. */
export async function verifyTerminalReplay(recording: ReplayRecording, identity: EngineIdentity, expected: ExpectedTerminal) {
  const started = performance.now();
  const metadata = { startTick: recording.initial.payload.state.tick, endTick: recording.endTick,
    endOrdinal: recording.endOrdinal, journalEvents: recording.events.length, checkpoints: recording.checkpoints.length };
  try {
    const replay = new ReplayRunner(recording, identity);
    if (recording.endTick !== expected.tick || recording.initial.payload.state.matchId !== expected.matchId)
      throw Error('TERMINAL_REPLAY_BOUNDARY_MISMATCH');
    const terminal = recording.checkpoints.filter(point => point.tick === recording.endTick && point.ordinal === recording.endOrdinal);
    if (!terminal.length) throw Error('TERMINAL_REPLAY_CHECKPOINT_MISSING');
    let previous = { tick: replay.simulation.state.tick, ordinal: replay.simulation.state.eventOrdinal };
    for (;;) {
      if (performance.now() - started > 30 * 60_000) throw Error('TERMINAL_REPLAY_TIME_LIMIT');
      const progress = replay.advanceTo(recording.endTick, 200);
      if (progress.done) break;
      if (progress.tick < previous.tick || progress.ordinal < previous.ordinal || progress.tick === previous.tick && progress.ordinal === previous.ordinal)
        throw Error('TERMINAL_REPLAY_NO_PROGRESS');
      previous = progress;
      await setImmediate();
    }
    const state = replay.simulation.state, checksum = simulationChecksum(replay.simulation);
    if (state.tick !== expected.tick || state.eventOrdinal !== recording.endOrdinal || state.matchEpoch !== expected.matchEpoch ||
      state.status !== 'FINISHED' || !isDeepStrictEqual(state.result, expected.result)) throw Error('TERMINAL_REPLAY_RESULT_MISMATCH');
    if (terminal.some(point => point.checksum !== checksum)) throw Error('TERMINAL_REPLAY_CHECKSUM_MISMATCH');
    return { ...metadata, passed: true as const, checksum, wallElapsedMs: Math.round(performance.now() - started), timingQualificationEligible: false as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^[A-Z][A-Z_]+(?::\d+){0,2}$/.test(message) ? message : 'TERMINAL_REPLAY_VERIFICATION_FAILED';
    return { ...metadata, passed: false as const, code, wallElapsedMs: Math.round(performance.now() - started), timingQualificationEligible: false as const };
  }
}

/** Copy only bounded replay evidence to a private host archive, including corrupt
 * files rejected by ReplayStore.list/read. Contents never enter a browser/report. */
export async function retainTerminalReplayEvidence(options: { sourceDirectory: string; archiveDirectory: string; preferredId?: string }) {
  const limits = { files: 8, fileBytes: 256 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, directoryEntries: 1024 };
  const evidence = { hostOnly: true as const, timingQualificationEligible: false as const, limits,
    files: [] as { name: string; archivePath: string; bytes: number; sha256: string }[],
    skipped: [] as { name?: string; code: string }[], directoryEntriesTruncated: false };
  const requireEvidence = (condition: unknown, code: string) => { if (!condition) throw Error(code); };
  const codeOf = (error: unknown) => error instanceof Error && /^TERMINAL_REPLAY_[A-Z_]+$/.test(error.message) ? error.message : 'TERMINAL_REPLAY_EVIDENCE_IO_FAILED';
  async function plainDirectoryTree(path: string, create = false) {
    const absolute = resolve(path); let current = parse(absolute).root;
    for (const part of relative(current, absolute).split(sep)) {
      current = join(current, part);
      if (create) await mkdir(current).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const stat = await lstat(current);
      requireEvidence(stat.isDirectory() && !stat.isSymbolicLink(), 'TERMINAL_REPLAY_EVIDENCE_LINK_OR_NON_DIRECTORY');
    }
  }
  try {
    await plainDirectoryTree(options.sourceDirectory);
    let names: string[] = [];
    if (options.preferredId !== undefined) {
      requireEvidence(/^replay_[0-9]{13}_[a-f0-9]{16}$/.test(options.preferredId), 'TERMINAL_REPLAY_EVIDENCE_INVALID_ID');
      names = [`${options.preferredId}.json`];
    } else {
      const directory = await opendir(options.sourceDirectory); let entries = 0;
      for await (const entry of directory) {
        if (++entries > limits.directoryEntries) { evidence.directoryEntriesTruncated = true; break; }
        if (/^replay_[0-9]{13}_[a-f0-9]{16}\.(json|ndjson)$/.test(entry.name)) names.push(entry.name);
      }
      names.sort((a, b) => b.localeCompare(a));
    }
    await plainDirectoryTree(options.archiveDirectory, true);
    let bytesRetained = 0, attempts = 0;
    for (const name of names) {
      if (++attempts > limits.files) { evidence.skipped.push({ code: 'TERMINAL_REPLAY_EVIDENCE_FILE_LIMIT' }); break; }
      const sourcePath = join(options.sourceDirectory, name), archivePath = join(options.archiveDirectory, name);
      let source: Awaited<ReturnType<typeof open>> | undefined, destination: Awaited<ReturnType<typeof open>> | undefined, created = false, complete = false;
      try {
        const before = await lstat(sourcePath);
        requireEvidence(before.isFile() && !before.isSymbolicLink(), 'TERMINAL_REPLAY_EVIDENCE_LINK_OR_NON_FILE');
        requireEvidence(before.size <= limits.fileBytes && bytesRetained + before.size <= limits.totalBytes, 'TERMINAL_REPLAY_EVIDENCE_BYTE_LIMIT');
        source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const opened = await source.stat();
        requireEvidence(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size && opened.mtimeMs === before.mtimeMs, 'TERMINAL_REPLAY_EVIDENCE_FILE_CHANGED');
        destination = await open(archivePath, 'wx', 0o600); created = true;
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
        for (let position = 0; position < opened.size;) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
          requireEvidence(bytesRead > 0, 'TERMINAL_REPLAY_EVIDENCE_FILE_CHANGED'); hash.update(buffer.subarray(0, bytesRead));
          for (let written = 0; written < bytesRead;) {
            const part = await destination.write(buffer, written, bytesRead - written, position + written);
            requireEvidence(part.bytesWritten > 0, 'TERMINAL_REPLAY_EVIDENCE_WRITE_FAILED'); written += part.bytesWritten;
          }
          position += bytesRead;
        }
        const after = await source.stat();
        requireEvidence(after.size === opened.size && after.mtimeMs === opened.mtimeMs, 'TERMINAL_REPLAY_EVIDENCE_FILE_CHANGED');
        await destination.sync(); evidence.files.push({ name, archivePath, bytes: opened.size, sha256: hash.digest('hex') }); bytesRetained += opened.size; complete = true;
      } catch (error) { evidence.skipped.push({ name, code: codeOf(error) }); }
      finally {
        await destination?.close().catch(() => {}); await source?.close().catch(() => {});
        if (created && !complete) await rm(archivePath, { force: true }).catch(() => {});
      }
    }
  } catch (error) { evidence.skipped.push({ code: codeOf(error) }); }
  return evidence;
}
