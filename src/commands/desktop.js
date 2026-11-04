import { addIcon, removeIcon, stableCommand } from '../desktop';
import { done, info, paint } from '../out';
import { selfCommand } from './web';

const MENUS = { darwin: 'your Applications folder', win32: 'the Start menu' };

export const add = async () => {
	const place = await addIcon({ command: stableCommand(selfCommand([])) });

	done(
		`Ender is in ${MENUS[process.platform] ?? 'your app menu'}: it opens ender web, which stops once its page is closed`,
	);
	info(paint.dim(`  ${place}`));
	info(paint.dim('  ender desktop remove takes it away'));

	return 0;
};

export const remove = async () => {
	const removed = await removeIcon();

	if (removed.length === 0) {
		info('No Ender icon was there to remove');

		return 0;
	}

	done('Removed the Ender icon');

	for (const place of removed) info(paint.dim(`  ${place}`));

	return 0;
};
