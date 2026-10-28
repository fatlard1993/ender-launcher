import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { paths } from './paths';

export const KEPT_JOBS = 30;

/**
 * Run a command with its output in a log, and let it go: a game outlives the page that started it, and Ctrl-C on ender
 * web must not reach it, nor an import half done. Answers how it ended.
 */
export const detach = (argv, log) => {
	const out = openSync(log, 'w');
	const child = spawn(argv[0], argv.slice(1), {
		detached: true,
		stdio: ['ignore', out, out],
		env: { ...process.env, NO_COLOR: '1' },
	});

	closeSync(out);
	child.unref();

	return new Promise(resolve => {
		child.once('error', error => resolve({ code: 127, error: error.message }));
		child.once('exit', code => resolve({ code: code ?? 1 }));
	});
};

/**
 * The work the page started, each a run of `command(args)` known by its id, with what it printed so far and how it
 * ended. One instance has one job running at a time.
 */
export const jobRunner = ({ command, start = detach, directory = () => join(paths.cache, 'jobs') }) => {
	const jobs = new Map();
	let started = 0;

	const forgetOld = async () => {
		const finished = [...jobs.values()].filter(job => job.state !== 'running');

		for (const job of finished.slice(0, Math.max(0, jobs.size - KEPT_JOBS))) {
			jobs.delete(job.id);
			await rm(job.log, { force: true });
		}
	};

	return {
		running: instance =>
			instance === undefined
				? undefined
				: [...jobs.values()].find(job => job.instance === instance && job.state === 'running'),
		start: async (args, { title, instance }) => {
			await mkdir(directory(), { recursive: true });

			const id = `${Date.now().toString(36)}-${(started++).toString(36)}`;
			const job = {
				id,
				title,
				instance,
				log: join(directory(), `${id}.log`),
				state: 'running',
				started: new Date().toISOString(),
			};

			jobs.set(id, job);
			job.finished = start(command(args), job.log).then(({ code, error }) => {
				Object.assign(job, {
					state: code === 0 ? 'done' : 'failed',
					code,
					ended: new Date().toISOString(),
					...(error ? { error } : {}),
				});

				return forgetOld();
			});

			return job;
		},
		get: id => jobs.get(id),
		list: () => [...jobs.values()].toReversed(),
		/** The lines it printed from this one on; a line still being written waits until it ends or the job does. */
		lines: async (job, from = 0) => {
			const text = await Bun.file(job.log)
				.text()
				.catch(() => '');
			const lines = text.split('\n');

			if (job.state === 'running' || lines.at(-1) === '') lines.pop();

			return lines.slice(from);
		},
	};
};

/** A job as the page sees it. */
export const shown = ({ finished, ...job }) => job;
