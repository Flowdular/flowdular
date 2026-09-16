import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../src/services/html-text.ts';
import {
	parseRobots,
	RobotsCache,
	robotsAllows,
} from '../src/services/robots.ts';

describe('html to text', () => {
	it('RESEARCH-FETCH-HTML falls back to the body when the article is too short and to the first heading for a title', () => {
		const page = htmlToText(
			'<body><header>Site</header><main><h1>Short</h1></main><div>Body <b>text</b><br>next line</div></body>',
		);
		expect(page.title).toBe('Short');
		expect(page.text).toBe('Short\n\nBody text\nnext line');
	});

	it('RESEARCH-FETCH-HTML decodes numeric and named entities and replaces invalid code points', () => {
		expect(decodeEntities('&lt;a&gt; &#65;&#x42; &nbsp;&unknown; &#0;')).toBe(
			`<a> AB ${String.fromCodePoint(160)}&unknown; ${String.fromCodePoint(0xfffd)}`,
		);
	});

	it('RESEARCH-FETCH-HTML survives unterminated markup', () => {
		expect(htmlToText('<script>' + '<p>'.repeat(50_000)).text).toBe('');
		expect(htmlToText('<p>kept <!-- never closed').text).toBe('kept');
		expect(htmlToText('<p>kept <style>never closed').text).toBe('kept');
	});
});

describe('robots.txt', () => {
	it('RESEARCH-ROBOTS picks the named group over the wildcard and the longest rule wins', () => {
		const text = [
			'User-agent: *',
			'Disallow: /',
			'',
			'User-agent: FlowdularResearch',
			'User-agent: other',
			'Disallow: /private',
			'Allow: /private/open',
			'Disallow: /*.pdf$',
		].join('\n');
		const rules = parseRobots(text, 'flowdularresearch');
		expect(robotsAllows(rules, '/public')).toBe(true);
		expect(robotsAllows(rules, '/private/x')).toBe(false);
		expect(robotsAllows(rules, '/private/open/x')).toBe(true);
		expect(robotsAllows(rules, '/files/report.pdf')).toBe(false);
		expect(robotsAllows(rules, '/files/report.pdf?x=1')).toBe(true);
		expect(robotsAllows(parseRobots(text, 'someone-else'), '/public')).toBe(
			false,
		);
		expect(robotsAllows(parseRobots('', 'flowdularresearch'), '/any')).toBe(
			true,
		);
	});

	it('RESEARCH-ROBOTS matches wildcards and refuses a file whose rules exhaust the match budget', () => {
		const wildcard = parseRobots(
			`User-agent: *\nDisallow: /${'a*'.repeat(20)}b$`,
			'flowdularresearch',
		);
		expect(robotsAllows(wildcard, '/' + 'a'.repeat(200))).toBe(true);
		expect(robotsAllows(wildcard, '/' + 'a'.repeat(200) + 'b')).toBe(false);

		const hostile = parseRobots(
			[
				'User-agent: *',
				...Array.from({ length: 2_000 }, (_, index) =>
					index % 2 === 0
						? `Disallow: /${'*a'.repeat(250)}b`
						: `User-agent: *\nDisallow: /${'*a'.repeat(250)}c`,
				),
			].join('\n'),
			'flowdularresearch',
		);
		expect(hostile.rules).toHaveLength(500);
		expect(robotsAllows(hostile, '/' + 'a'.repeat(2_040))).toBe(false);
	});

	it('RESEARCH-ROBOTS caches per host for the time to live and evicts the oldest host', () => {
		const cache = new RobotsCache(2, 1_000);
		cache.set('a.example', { rules: [] }, 0);
		cache.set('b.example', { rules: [] }, 0);
		expect(cache.get('a.example', 999)).not.toBeNull();
		expect(cache.get('a.example', 1_000)).toBeNull();
		cache.set('c.example', { rules: [] }, 0);
		cache.set('d.example', { rules: [] }, 0);
		expect(cache.get('b.example', 1)).toBeNull();
		expect(cache.get('d.example', 1)).not.toBeNull();
	});
});
