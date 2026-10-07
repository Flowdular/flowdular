export const REVIEW_CHECKS = [
	'correctness',
	'security',
	'compatibility',
	'lifecycle',
	'tests',
	'ui',
] as const;
export type ReviewCheck = (typeof REVIEW_CHECKS)[number];

export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export interface ReviewReport {
	readonly verdict: 'pass' | 'fail';
	readonly checks: Readonly<Record<string, unknown>>;
	readonly findings: readonly string[];
}

export interface ReviewReading {
	readonly report: ReviewReport;
	/* The JSON exactly as the reviewer wrote it. */
	readonly raw: string;
	/* The reply without the block, which is what the transcript speaks. */
	readonly remainder: string;
}

export interface ReviewFinding {
	readonly severity: ReviewSeverity | null;
	readonly location: string | null;
	readonly text: string;
}

const MAX_REPLY_LENGTH = 32_000;
const REPORT_BLOCK = /```auto-review\s*\n([\s\S]*?)\n```/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* The one reading of a review turn's closing reply, shared by the gate that
   records it and the transcript that shows it. */
export function readReviewReport(text: string): ReviewReading | null {
	if (text.length > MAX_REPLY_LENGTH || !text.includes('```auto-review'))
		return null;
	const blocks = [...text.matchAll(REPORT_BLOCK)];
	if (blocks.length !== 1) return null;
	const block = blocks[0]!;
	let report: unknown;
	try {
		report = JSON.parse(block[1]!);
	} catch {
		return null;
	}
	if (
		!isRecord(report) ||
		(report.verdict !== 'pass' && report.verdict !== 'fail') ||
		!isRecord(report.checks) ||
		!Array.isArray(report.findings) ||
		!report.findings.every((finding) => typeof finding === 'string')
	)
		return null;
	const start = block.index!;
	return {
		report: {
			verdict: report.verdict,
			checks: report.checks,
			findings: report.findings,
		},
		raw: block[1]!,
		remainder: [
			text.slice(0, start).trimEnd(),
			text.slice(start + block[0].length).trimStart(),
		]
			.filter(Boolean)
			.join('\n\n'),
	};
}

export function checkHasEvidence(value: unknown): boolean {
	return (
		typeof value === 'string' &&
		value.trim().length >= 20 &&
		value.length <= 4_000
	);
}

export function passingReviewReport(text: string): boolean {
	const reading = readReviewReport(text);
	return (
		reading !== null &&
		reading.report.verdict === 'pass' &&
		reading.report.findings.length === 0 &&
		REVIEW_CHECKS.every((key) => checkHasEvidence(reading.report.checks[key]))
	);
}

/* A finding is written as "Severity; file:line; input/state; outcome; fix".
   One that does not follow the format is kept whole as its text. */
export function readFinding(finding: string): ReviewFinding {
	const first = finding.indexOf(';');
	const second = first < 0 ? -1 : finding.indexOf(';', first + 1);
	const severity = finding.slice(0, first).trim().toLowerCase();
	const location = finding.slice(first + 1, second).trim();
	const text = finding.slice(second + 1).trim();
	if (
		second < 0 ||
		!REVIEW_SEVERITIES.includes(severity as ReviewSeverity) ||
		!location ||
		!text
	)
		return { severity: null, location: null, text: finding.trim() };
	return { severity: severity as ReviewSeverity, location, text };
}
