// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openInChrome } from './chrome.ts';

/* A stand-in Chrome on the same DevTools pipe, started through FD_CHROME. It
   logs every method it receives, holds its first answer until the release
   file exists, and never answers the method named in FD_FAKE_CHROME_SILENT.
   With FD_FAKE_CHROME_SERVICE it starts a child that writes into the profile
   once the browser is gone, as Chrome's network and storage services do:
   Browser.close waits for it, a SIGTERM does not. Only the helper's timers are
   faked, so the budgets run in fake time while the processes run for real. */
const FAKE_CHROME = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { Socket } from 'node:net';
const input = new Socket({ fd: 3, readable: true, writable: false });
const output = new Socket({ fd: 4, readable: false, writable: true });
const { FD_FAKE_CHROME_LOG: log, FD_FAKE_CHROME_RELEASE: release, FD_FAKE_CHROME_SILENT: silent, FD_FAKE_CHROME_SERVICE: service } = process.env;
const profile = process.argv.find((argument) => argument.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
appendFileSync(log, 'profile ' + profile + '\n');
const flush = 'const { mkdirSync, writeFileSync } = require("node:fs"); process.stdin.resume().on("end", () => setTimeout(() => { mkdirSync(process.argv[1] + "/Default", { recursive: true }); writeFileSync(process.argv[1] + "/Default/Cookies", ""); }, 100));';
const child = service ? spawn(process.execPath, ['-e', flush, profile], { stdio: ['pipe', 'ignore', 'ignore'] }) : null;
const close = () => {
  if (!child) process.exit(0);
  child.once('exit', () => process.exit(0));
  child.stdin.end();
};
const send = (message) => output.write(JSON.stringify(message) + '\0');
const answer = ({ id, method }) => {
  if (method === silent) return;
  if (method === 'Browser.close') close();
  else if (method === 'Target.createTarget') send({ id, result: { targetId: 't' } });
  else if (method === 'Target.attachToTarget') send({ id, result: { sessionId: 's' } });
  else if (method === 'Runtime.evaluate') send({ id, result: { result: { value: 'ready' } } });
  else send({ id, result: {} });
  if (method === 'Page.navigate') send({ method: 'Page.loadEventFired', sessionId: 's', params: {} });
};
let first = true;
let buffer = '';
input.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    appendFileSync(log, message.method + '\n');
    if (!first) { answer(message); continue; }
    first = false;
    const poll = setInterval(() => {
      if (!release || existsSync(release)) { clearInterval(poll); answer(message); }
    }, 10);
  }
});
`;

interface NodeApi {
	readonly mkdtempSync: (prefix: string) => string;
	readonly writeFileSync: (
		path: string,
		data: string,
		options?: { readonly mode: number },
	) => void;
	readonly readFileSync: (path: string, encoding: 'utf8') => string;
	readonly existsSync: (path: string) => boolean;
	readonly rmSync: (
		path: string,
		options: { readonly recursive: true; readonly force: true },
	) => void;
	readonly tmpdir: () => string;
}

const {
	process: { env, execPath },
	setImmediate,
} = globalThis as unknown as {
	readonly process: {
		readonly env: Record<string, string | undefined>;
		readonly execPath: string;
	};
	readonly setImmediate: (callback: () => void) => void;
};

let node: NodeApi;
let directory = '';
let saved: Record<string, string | undefined> = {};

async function nodeApi(): Promise<NodeApi> {
	const [fs, os] = await Promise.all([
		import('node:' + 'fs'),
		import('node:' + 'os'),
	]);
	return { ...fs, ...os } as NodeApi;
}

function fakeChrome(options: {
	readonly hold?: boolean;
	readonly silent?: string;
	readonly service?: boolean;
}) {
	const log = directory + '/methods.log';
	const release = directory + '/release';
	node.writeFileSync(log, '');
	node.writeFileSync(directory + '/fake-chrome.mjs', FAKE_CHROME);
	node.writeFileSync(
		directory + '/fake-chrome',
		`#!/bin/sh\nexec '${execPath}' '${directory}/fake-chrome.mjs' "$@"\n`,
		{ mode: 0o755 },
	);
	for (const key of [
		'FD_CHROME',
		'FD_FAKE_CHROME_LOG',
		'FD_FAKE_CHROME_RELEASE',
		'FD_FAKE_CHROME_SILENT',
		'FD_FAKE_CHROME_SERVICE',
	]) {
		saved[key] = env[key];
	}
	env.FD_CHROME = directory + '/fake-chrome';
	env.FD_FAKE_CHROME_LOG = log;
	env.FD_FAKE_CHROME_RELEASE = options.hold ? release : '';
	env.FD_FAKE_CHROME_SILENT = options.silent ?? '';
	env.FD_FAKE_CHROME_SERVICE = options.service ? '1' : '';
	return {
		/** Resolves once the fake has received `method`, so its timer is armed. */
		received: (method: string) =>
			until(() => node.readFileSync(log, 'utf8').split('\n').includes(method)),
		release: () => node.writeFileSync(release, ''),
		/** The directory openInChrome made for this Chrome's profile. */
		directory: () =>
			node
				.readFileSync(log, 'utf8')
				.split('\n')
				.find((line) => line.startsWith('profile '))!
				.slice('profile '.length)
				.replace(/\/profile$/, ''),
	};
}

/** Settles `promise` into a value the test can inspect at any fake time. */
function track<T>(promise: Promise<T>) {
	const state: { settled: boolean; value?: T; error?: Error } = {
		settled: false,
	};
	promise.then(
		(value) => Object.assign(state, { settled: true, value }),
		(error: Error) => Object.assign(state, { settled: true, error }),
	);
	return state;
}

/* Yields to real I/O until `done`: the pipe and the child process run in real
   time while the helper's clock is fake. Date is not faked. */
async function until(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error('The fake Chrome stalled.');
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

beforeEach(async () => {
	node = await nodeApi();
	directory = node.mkdtempSync(node.tmpdir() + '/flowdular-fake-chrome-');
	saved = {};
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
	vi.useRealTimers();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	node.rmSync(directory, { recursive: true, force: true });
});

it('waits past the call budget for a Chrome that is slow to start', async () => {
	const chrome = fakeChrome({ hold: true });
	const opened = track(
		openInChrome('about:blank', (page) => page.evaluate<string>('1')),
	);
	await chrome.received('Target.createTarget');
	await vi.advanceTimersByTimeAsync(20_000);
	expect(opened.settled).toBe(false);
	chrome.release();
	await until(() => opened.settled);
	expect(opened.error).toBeUndefined();
	expect(opened.value).toBe('ready');
});

it('gives up on a Chrome that never starts after the startup budget', async () => {
	const chrome = fakeChrome({ hold: true });
	const opened = track(openInChrome('about:blank', async () => 'unreached'));
	await chrome.received('Target.createTarget');
	await vi.advanceTimersByTimeAsync(44_000);
	expect(opened.settled).toBe(false);
	await vi.advanceTimersByTimeAsync(2_000);
	await until(() => opened.settled);
	expect(opened.error?.message).toBe(
		'Chrome did not answer Target.createTarget within the 45 s startup budget.',
	);
});

it('still fails a call fast once Chrome has started', async () => {
	const chrome = fakeChrome({ silent: 'Runtime.evaluate' });
	const opened = track(
		openInChrome('about:blank', (page) => page.evaluate<string>('1')),
	);
	await chrome.received('Runtime.evaluate');
	await vi.advanceTimersByTimeAsync(14_000);
	expect(opened.settled).toBe(false);
	await vi.advanceTimersByTimeAsync(2_000);
	await until(() => opened.settled);
	expect(opened.error?.message).toBe(
		'Chrome did not answer Runtime.evaluate within the 15 s call budget.',
	);
});

it('stops a Chrome that does not close once the close budget runs out', async () => {
	const chrome = fakeChrome({ silent: 'Browser.close' });
	const opened = track(
		openInChrome('about:blank', (page) => page.evaluate<string>('1')),
	);
	await chrome.received('Browser.close');
	await vi.advanceTimersByTimeAsync(9_000);
	expect(opened.settled).toBe(false);
	await vi.advanceTimersByTimeAsync(2_000);
	await until(() => opened.settled);
	expect(opened.error).toBeUndefined();
	expect(opened.value).toBe('ready');
	expect(node.existsSync(chrome.directory())).toBe(false);
});

it('removes the profile only after every Chrome process is done with it', async () => {
	const chrome = fakeChrome({ service: true });
	const opened = track(
		openInChrome('about:blank', (page) => page.evaluate<string>('1')),
	);
	await until(() => opened.settled);
	expect(opened.error).toBeUndefined();
	const removed = chrome.directory();
	/* A service a SIGTERM left behind writes 100 ms after the browser exits. */
	const settledAt = Date.now();
	await until(() => Date.now() - settledAt > 400);
	expect(node.existsSync(removed)).toBe(false);
});
