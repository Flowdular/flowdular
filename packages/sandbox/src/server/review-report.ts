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

type ReviewInspection =
	| { readonly reading: ReviewReading; readonly problem?: undefined }
	| { readonly reading?: undefined; readonly problem: string };

function inspectReviewReply(text: string): ReviewInspection {
	if (text.length > MAX_REPLY_LENGTH)
		return {
			problem: `The reply is longer than ${MAX_REPLY_LENGTH} characters.`,
		};
	const blocks = text.includes('```auto-review')
		? [...text.matchAll(REPORT_BLOCK)]
		: [];
	if (blocks.length !== 1)
		return {
			problem:
				blocks.length === 0
					? 'The reply has no auto-review block, with its opening and closing fences on lines of their own.'
					: `The reply has ${blocks.length} auto-review blocks; write exactly one.`,
		};
	const block = blocks[0]!;
	let report: unknown;
	try {
		report = JSON.parse(block[1]!);
	} catch (error) {
		return {
			problem: `The auto-review block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (
		!isRecord(report) ||
		(report.verdict !== 'pass' && report.verdict !== 'fail') ||
		!isRecord(report.checks) ||
		!Array.isArray(report.findings) ||
		!report.findings.every((finding) => typeof finding === 'string')
	)
		return {
			problem:
				'The auto-review block needs "verdict" set to "pass" or "fail", a "checks" object and a "findings" list of strings.',
		};
	const start = block.index!;
	return {
		reading: {
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
		},
	};
}

/* The one reading of a review turn's closing reply, shared by the gate that
   records it and the transcript that shows it. */
export function readReviewReport(text: string): ReviewReading | null {
	return inspectReviewReply(text).reading ?? null;
}

/* Why a closing reply records no review the gate accepts, for the review
   turn that has to write it again: no readable report, or a pass that cannot
   pass. Null for a passing report and for a readable fail. */
export function reviewReportProblem(text: string): string | null {
	const inspection = inspectReviewReply(text);
	if (!inspection.reading) return inspection.problem;
	const { report } = inspection.reading;
	return report.verdict === 'pass' ? passProblem(report) : null;
}

export function checkHasEvidence(value: unknown): boolean {
	return (
		typeof value === 'string' &&
		value.trim().length >= 20 &&
		value.length <= 4_000
	);
}

function passProblem(report: ReviewReport): string | null {
	if (report.findings.length > 0)
		return `A passing report has an empty findings list, and this one lists ${report.findings.length}: report them with "verdict": "fail", or leave out what is not a defect.`;
	const unproven = REVIEW_CHECKS.filter(
		(key) => !checkHasEvidence(report.checks[key]),
	).map((key) => {
		const value = report.checks[key];
		return `${key} has ${typeof value === 'string' && value.length > 4_000 ? 'more' : 'less'}`;
	});
	return unproven.length > 0
		? `Every check needs 20 to 4000 characters of evidence: ${unproven.join(', ')}.`
		: null;
}

export function passingReviewReport(text: string): boolean {
	const reading = readReviewReport(text);
	return (
		reading !== null &&
		reading.report.verdict === 'pass' &&
		passProblem(reading.report) === null
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
