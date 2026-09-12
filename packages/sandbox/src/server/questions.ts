/* The active-questions protocol. A specialist that needs a decision from the
   operator closes its reply with one fenced block tagged `questions`; this
   module is the only place that turns that text into data, so a malformed block
   is a turn warning instead of raw JSON the operator has to read. Nothing here
   touches the file system or the network: the dashboard imports the same
   parser, so the transcript and the server never disagree about a block. */

export interface PendingQuestion {
	readonly id: string;
	readonly question: string;
	readonly options: readonly string[];
	/* One of `options`. Absent when the specialist recommends nothing. */
	readonly recommended?: string;
	readonly allowFreeText: boolean;
}

/* What the session carries between the turn that asked and the answers that
   start the next one: the questions, who asked them, and where. */
export interface PendingQuestions {
	/* The transcript sequence of the agent message the block came from. */
	readonly sequence: number;
	readonly role: string;
	readonly module?: string;
	readonly askedAt: number;
	readonly questions: readonly PendingQuestion[];
}

export const MAX_QUESTIONS = 12;
export const MAX_OPTIONS = 8;
export const MAX_QUESTION_LENGTH = 400;
export const MAX_OPTION_LENGTH = 120;
export const MAX_ANSWER_LENGTH = 400;
/* The block is a small decision list, not a document: a larger one is refused
   before JSON.parse allocates it. */
export const MAX_BLOCK_LENGTH = 8_000;

const QUESTION_ID = /^Q-[0-9]+$/;
/* A question, an option and an answer each become one line of the decisions the
   answered turn reads back. A line break or a control character inside one would
   let the text that wrote it forge further decision lines, so the value is
   refused whole rather than repaired. */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const FENCE = /^[ \t]*```[ \t]*([A-Za-z0-9_-]*)[ \t]*$/;
/* Every role closes with a handoff line, so it may follow the block. */
const HANDOFF_LINE = /^[ \t]*(?:[`*_]*)handoff[ \t]*:/i;

export interface QuestionsBlock {
	readonly raw: string;
	/* The reply without the block, which is what the transcript speaks. */
	readonly remainder: string;
}

export type QuestionsReading =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'valid';
			readonly questions: readonly PendingQuestion[];
			readonly remainder: string;
	  }
	| {
			readonly kind: 'invalid';
			readonly reason: string;
			readonly remainder: string;
	  };

interface FencedBlock {
	readonly tag: string;
	readonly open: number;
	readonly close: number;
}

/* One pass over the lines, pairing fences in order: an opening fence carries
   the info string, the next fence closes it. An unterminated fence is not a
   block, so half-streamed output never parses as one. */
function fencedBlocks(lines: readonly string[]): readonly FencedBlock[] {
	const blocks: FencedBlock[] = [];
	let open = -1;
	let tag = '';
	for (let index = 0; index < lines.length; index += 1) {
		const match = FENCE.exec(lines[index]!);
		if (!match) continue;
		if (open < 0) {
			open = index;
			tag = match[1] ?? '';
			continue;
		}
		blocks.push({ tag, open, close: index });
		open = -1;
		tag = '';
	}
	return blocks;
}

/* The block the protocol recognises: tagged `questions`, the last thing in the
   reply apart from the mandatory handoff line. A block in the middle of an
   explanation is prose about the protocol, not an instance of it. */
export function findQuestionsBlock(
	text: string,
): QuestionsBlock | { readonly reason: string } | null {
	if (!text.includes('```')) return null;
	const lines = text.split('\n');
	const tagged = fencedBlocks(lines).filter(
		(block) => block.tag.toLowerCase() === 'questions',
	);
	if (tagged.length === 0) return null;
	if (tagged.length > 1) {
		return { reason: 'A reply carries at most one questions block.' };
	}
	const block = tagged[0]!;
	for (let index = block.close + 1; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (!line.trim() || HANDOFF_LINE.test(line)) continue;
		return {
			reason: 'The questions block must be the last thing in the reply.',
		};
	}
	const before = lines.slice(0, block.open);
	const after = lines.slice(block.close + 1);
	return {
		raw: lines.slice(block.open + 1, block.close).join('\n'),
		remainder: [...before, ...after].join('\n').trim(),
	};
}

function invalid(reason: string): {
	readonly ok: false;
	readonly reason: string;
} {
	return { ok: false, reason };
}

export type QuestionsParse =
	| { readonly ok: true; readonly questions: readonly PendingQuestion[] }
	| { readonly ok: false; readonly reason: string };

/* Every bound is checked before the value is kept, so a session record can only
   ever hold a list the answers form and the answers route both accept. */
export function parseQuestionsBlock(raw: string): QuestionsParse {
	if (raw.length > MAX_BLOCK_LENGTH) {
		return invalid(
			`A questions block is limited to ${MAX_BLOCK_LENGTH} characters.`,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		return invalid('The questions block is not valid JSON.');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return invalid('The questions block must be a JSON object.');
	}
	const list = (value as { questions?: unknown }).questions;
	if (!Array.isArray(list) || list.length === 0) {
		return invalid('The questions block needs a non-empty questions array.');
	}
	if (list.length > MAX_QUESTIONS) {
		return invalid(
			`A questions block asks at most ${MAX_QUESTIONS} questions.`,
		);
	}
	const questions: PendingQuestion[] = [];
	const seen = new Set<string>();
	for (const entry of list as readonly unknown[]) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			return invalid('Every question must be a JSON object.');
		}
		const item = entry as Record<string, unknown>;
		const id = item.id;
		if (typeof id !== 'string' || !QUESTION_ID.test(id)) {
			return invalid('Every question id must look like Q-1.');
		}
		if (seen.has(id)) return invalid(`Question id ${id} is used twice.`);
		seen.add(id);
		const question = item.question;
		if (
			typeof question !== 'string' ||
			question.trim().length === 0 ||
			question.length > MAX_QUESTION_LENGTH
		) {
			return invalid(
				`${id} must ask a question of 1 to ${MAX_QUESTION_LENGTH} characters.`,
			);
		}
		if (CONTROL_CHARACTER.test(question.trim())) {
			return invalid(
				`${id} may not contain a line break or a control character.`,
			);
		}
		const rawOptions = item.options ?? [];
		if (!Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS) {
			return invalid(`${id} may offer at most ${MAX_OPTIONS} options.`);
		}
		const options: string[] = [];
		for (const option of rawOptions as readonly unknown[]) {
			if (
				typeof option !== 'string' ||
				option.trim().length === 0 ||
				option.length > MAX_OPTION_LENGTH
			) {
				return invalid(
					`Every option of ${id} must be 1 to ${MAX_OPTION_LENGTH} characters.`,
				);
			}
			if (CONTROL_CHARACTER.test(option.trim())) {
				return invalid(
					`No option of ${id} may contain a line break or a control character.`,
				);
			}
			if (options.includes(option.trim())) {
				return invalid(`${id} repeats the option ${option.trim()}.`);
			}
			options.push(option.trim());
		}
		const allowFreeText = item.allowFreeText ?? false;
		if (typeof allowFreeText !== 'boolean') {
			return invalid(`allowFreeText of ${id} must be true or false.`);
		}
		if (options.length === 0 && !allowFreeText) {
			return invalid(
				`${id} offers no option and no free text, so it cannot be answered.`,
			);
		}
		const recommended = item.recommended;
		if (recommended !== undefined && recommended !== null) {
			if (
				typeof recommended !== 'string' ||
				!options.includes(recommended.trim())
			) {
				return invalid(
					`The recommendation of ${id} must be one of its options.`,
				);
			}
		}
		questions.push({
			id,
			question: question.trim(),
			options,
			...(typeof recommended === 'string' &&
			options.includes(recommended.trim())
				? { recommended: recommended.trim() }
				: {}),
			allowFreeText,
		});
	}
	return { ok: true, questions };
}

/* The whole reading of one agent message: whether it asked, what it asked, and
   what is left to show as speech. */
export function readQuestions(text: string): QuestionsReading {
	const found = findQuestionsBlock(text);
	if (!found) return { kind: 'none' };
	if ('reason' in found) {
		return { kind: 'invalid', reason: found.reason, remainder: text };
	}
	const parsed = parseQuestionsBlock(found.raw);
	if (!parsed.ok) {
		return {
			kind: 'invalid',
			reason: parsed.reason,
			remainder: found.remainder,
		};
	}
	return {
		kind: 'valid',
		questions: parsed.questions,
		remainder: found.remainder,
	};
}

export interface AnswerDecision {
	readonly id: string;
	readonly question: string;
	readonly answer: string;
}

export type AnswersParse =
	| { readonly ok: true; readonly decisions: readonly AnswerDecision[] }
	| { readonly ok: false; readonly reason: string };

/* The answers a request carries, checked against the questions this session
   actually asked: every pending question is answered exactly once, and an
   answer that is not free text must be one of the offered options. */
export function resolveAnswers(
	pending: PendingQuestions,
	value: unknown,
): AnswersParse {
	if (!Array.isArray(value)) {
		return invalid('answers must be an array.');
	}
	if (value.length !== pending.questions.length) {
		return invalid(
			`This session is waiting for ${pending.questions.length} answers.`,
		);
	}
	const byId = new Map(pending.questions.map((entry) => [entry.id, entry]));
	const decisions: AnswerDecision[] = [];
	for (const entry of value as readonly unknown[]) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			return invalid('Every answer must be a JSON object.');
		}
		const item = entry as Record<string, unknown>;
		const id = item.id;
		if (typeof id !== 'string' || !byId.has(id)) {
			return invalid('Every answer must name a pending question.');
		}
		const question = byId.get(id)!;
		byId.delete(id);
		/* A record written before the parser refused these still has to stay out
		   of the decisions text. */
		if (CONTROL_CHARACTER.test(question.question)) {
			return invalid(
				`${id} carries a line break or a control character and cannot be answered.`,
			);
		}
		const answer = item.answer;
		if (
			typeof answer !== 'string' ||
			answer.trim().length === 0 ||
			answer.length > MAX_ANSWER_LENGTH
		) {
			return invalid(
				`The answer to ${id} must be 1 to ${MAX_ANSWER_LENGTH} characters.`,
			);
		}
		const trimmed = answer.trim();
		if (CONTROL_CHARACTER.test(trimmed)) {
			return invalid(
				`The answer to ${id} may not contain a line break or a control character.`,
			);
		}
		if (
			!question.allowFreeText &&
			question.options.length > 0 &&
			!question.options.includes(trimmed)
		) {
			return invalid(`The answer to ${id} must be one of its options.`);
		}
		decisions.push({ id, question: question.question, answer: trimmed });
	}
	return { ok: true, decisions };
}

/* The request text the answered turn starts from. The specialist reads its own
   questions back with the decision beside each one, so it never has to guess
   which answer belongs to which question. */
export function formatDecisions(decisions: readonly AnswerDecision[]): string {
	return [
		'Decisions:',
		...decisions.map(
			(decision) =>
				`- ${decision.id}: ${decision.question} -> ${decision.answer}`,
		),
	].join('\n');
}
