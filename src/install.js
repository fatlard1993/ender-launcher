import { mkdir } from 'node:fs/promises';

import { ensureFile, pool } from './download';
import { assetJobs, fetchAssetIndex } from './meta/mojang';
import { detail, plural, progress, step } from './out';

const runJobs = async (label, jobs, { concurrency = 8 } = {}) => {
	if (jobs.length === 0) return 0;

	const bar = progress();
	let fetched = 0;

	const results = await pool(jobs, async job => (await ensureFile(job)) && ++fetched, {
		concurrency,
		onProgress: (finished, total) => bar.update(`   ${label} ${finished}/${total}`),
	});

	bar.clear();

	detail(label, `${results.length} checked, ${fetched} fetched`);

	return fetched;
};

/** Put everything the plan names on disk, skipping whatever is already there and intact. */
export const installPlan = async (plan, { assets = true, donors = {} } = {}) => {
	const jarJob = plan.side === 'server' ? plan.serverJar : plan.clientJar;

	step(`Installing Minecraft ${plan.id}${plan.loader ? ` with Fabric ${plan.loader.version}` : ''}`);

	if (jarJob === undefined) throw new Error(`Mojang publishes no ${plan.side} jar for ${plan.id}`);

	await runJobs('game jar  ', [jarJob]);
	await runJobs('libraries ', plan.libraries, { concurrency: 12 });

	if (plan.logging) await runJobs('log config', [plan.logging.job]);

	if (assets && plan.side === 'client') {
		const { index } = await fetchAssetIndex(plan.meta, donors.assets ?? []);
		const jobs = assetJobs(index, donors.assets ?? []);

		await runJobs('assets    ', jobs, { concurrency: 16 });

		detail('assets', plural(jobs.length, 'object'));
	}

	await mkdir(plan.nativesDirectory, { recursive: true });

	return plan;
};
