import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { test } from 'node:test';
import { DOM_PROPERTY_SPELLINGS } from '../../packages/cli/src/dom-properties.ts';

test('the checked spellings follow the Octane version the UI package uses', () => {
	const octane = realpathSync(
		new URL('../../packages/ui/node_modules/octane', import.meta.url),
	);
	const diagnostics = readFileSync(
		octane + '/dist/host-property-diagnostics.js',
		'utf8',
	);
	const list = /KNOWN_CAMELCASE_PROPERTIES = [^[]*\[([^\]]*)\]/.exec(diagnostics);
	assert.ok(list, 'Octane no longer declares KNOWN_CAMELCASE_PROPERTIES');
	/* Not attributes a screen writes in lowercase: React-style escape hatches and
	   className, which Flowdular screens spell as class. */
	const ignored = /^(className|dangerouslySetInnerHTML|suppress[A-Za-z]+)$/;
	const expected = [...list[1].matchAll(/"([A-Za-z]+)"/g)]
		.map((match) => match[1])
		.filter((name) => !ignored.test(name));
	const checked = new Set(DOM_PROPERTY_SPELLINGS);
	assert.deepEqual(
		expected.filter((name) => !checked.has(name)),
		[],
	);
});
