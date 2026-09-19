import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
	declaredClassNames,
	unknownClassNames,
	usedClassNames,
} from '../../packages/cli/src/ui-classes.ts';

test('a stylesheet declares the classes its selectors name, and nothing else', () => {
	const declared = declaredClassNames(`
/* .ui-commented-out {} */
.ui-card,
.ui-card__head { background: url(./sprite.png); border-radius: .5rem; }
@media (prefers-color-scheme: dark) {
	:root:not([data-theme='light']) .ui-card { background: #000; }
}
`);
	assert.ok(declared.has('ui-card'));
	assert.ok(declared.has('ui-card__head'));
	assert.ok(!declared.has('png'), 'a path inside a declaration is not a class');
	assert.ok(!declared.has('5rem'), 'a length is not a class');
	assert.ok(!declared.has('ui-commented-out'));
});

test('a screen uses the class names it writes as literals', () => {
	const used = usedClassNames(`
	<div class="ui-view catalog-page">
		<span class={['ui-tag', props.mono && 'ui-tag--mono']} />
	</div>
`);
	assert.deepEqual(
		used.map((entry) => entry.name),
		['ui-view', 'catalog-page', 'ui-tag', 'ui-tag--mono'],
	);
	assert.equal(used[0].line, 2);
	assert.equal(used[2].line, 3);
});

test('a compared value and a computed suffix are not class names', () => {
	const used = usedClassNames(`
	<button class={[
		'ui-btn',
		'ui-btn--' + (props.variant ?? 'secondary'),
		props.size === 'sm' && 'ui-btn--sm',
		props.risk === 'workspace-write' && 'ui-btn--warning',
	]} />
	<i class={\`ui-dot \${tone}\`} />
`);
	assert.deepEqual(
		used.map((entry) => entry.name),
		['ui-btn', 'ui-btn--sm', 'ui-btn--warning'],
		'only the literals that name a whole class on their own',
	);
});

test('an undeclared class is reported once per place it is written', () => {
	const declared = declaredClassNames('.ui-view {} .ui-card {}');
	const used = usedClassNames(`
	<div class="ui-view ui-stak">
		<div class="ui-card ui-stak" />
	</div>
`);
	assert.deepEqual(
		unknownClassNames(used, declared).map(
			(entry) => `${entry.line}:${entry.name}`,
		),
		['2:ui-stak', '3:ui-stak'],
	);
});

test('the baseline records only classes the check still finds', () => {
	const baseline = JSON.parse(
		readFileSync(
			new URL('../ui-classes-baseline.json', import.meta.url),
			'utf8',
		),
	);
	for (const [path, names] of Object.entries(baseline)) {
		assert.ok(names.length > 0, `${path} holds an empty list`);
		assert.deepEqual(
			names,
			[...names].sort(),
			`${path} is not sorted, which makes the file churn`,
		);
	}
});
