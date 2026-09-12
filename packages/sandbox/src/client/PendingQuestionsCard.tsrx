import { useState } from 'octane';
import { Alert, Button, Icon, Tag } from '@flowdular/ui';
import {
	MAX_ANSWER_LENGTH,
	type PendingQuestion,
	type PendingQuestions,
} from '../server/questions.ts';
import type { SubmittedAnswer } from './api.ts';
import { useTranslation } from './i18n.ts';

export interface PendingQuestionsCardProps {
	readonly pending: PendingQuestions | null;
	/* A turn is still in flight, so nothing here is answerable yet. */
	readonly loading: boolean;
	/* The session no longer accepts work: archived, or already delivered. */
	readonly denied: boolean;
	readonly busy: boolean;
	/* Why the last submission was refused. It renders above the state branch,
   because a refusal that already cleared the record leaves no questions to
   render it beside. */
	readonly error: string;
	readonly onSubmit: (answers: readonly SubmittedAnswer[], message: string) => void;
}

/* One operator's unsent decisions, stamped with the turn that asked. A newer
   question set makes the draft stale without an effect or a reset pass. */
interface AnswerDraft {
	readonly sequence: number;
	readonly mode: Readonly<Record<string, 'option' | 'free'>>;
	readonly choice: Readonly<Record<string, string>>;
	readonly typed: Readonly<Record<string, string>>;
	readonly note: string;
}

const EMPTY: AnswerDraft = {
	sequence: -1,
	mode: {},
	choice: {},
	typed: {},
	note: '',
};

/* The decisions a specialist is waiting for: one radio group per question, the
   recommendation preselected, and a free-text answer where the specialist
   allowed one. Submitting starts the next turn in the role that asked. */
export function PendingQuestionsCard(props: PendingQuestionsCardProps) @{
	const { t } = useTranslation();
	const questions = props.pending?.questions ?? [];
	const sequence = props.pending?.sequence ?? -1;
	const [stored, setStored] = useState<AnswerDraft>(EMPTY);
	const draft =
		stored.sequence === sequence ? stored : EMPTY;
	const patch = (change: Partial<AnswerDraft>) => setStored({
		...draft,
		...change,
		sequence,
	});

	const modeOf = (question: PendingQuestion): 'option' | 'free' | '' =>
		draft.mode[question.id] ??
			(question.recommended
				? 'option'
				: question.options.length === 0
					? 'free'
					: '');
	const choiceOf = (question: PendingQuestion) =>
		draft.choice[question.id] ?? question.recommended ?? '';
	const answerOf = (question: PendingQuestion) => {
		const mode = modeOf(question);
		if (mode === 'free') return (draft.typed[question.id] ?? '').trim();
		return mode === 'option' ? choiceOf(question) : '';
	};
	const pick = (question: PendingQuestion, option: string) => patch({
		mode: { ...draft.mode, [question.id]: 'option' },
		choice: { ...draft.choice, [question.id]: option },
	});
	const complete = questions.every((question) => answerOf(question).length > 0);

	<section class="ui-form">
		@if (props.error) {
			<Alert tone="danger">{props.error}</Alert>
		}
		@if (props.loading) {
			<p class="ui-note">
				<Icon name="refresh" size={14} />
				{t('sandbox.questions.loading')}
			</p>
		} @else if (props.denied) {
			<Alert tone="warning">{t('sandbox.questions.denied')}</Alert>
		} @else if (questions.length === 0) {
			<p class="ui-note">
				<Icon name="help" size={14} />
				{t('sandbox.questions.empty')}
			</p>
		} @else {
			<>
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('sandbox.questions.title')}</b>
						<small>{t('sandbox.questions.help')}</small>
					</div>
					@for (const question of questions; key question.id) {
						<div class="ui-field">
							<span class="ui-label">
								<span class="ui-mono">{question.id}</span>
								{' ' + question.question}
							</span>
							@for (const option of question.options; key option) {
								<label class="ui-checkbox">
									<input
										type="radio"
										name={'answer-' + sequence + '-' + question.id}
										value={option}
										checked={modeOf(question) === 'option' &&
											choiceOf(question) === option}
										disabled={props.busy}
										onChange={() => pick(question, option)}
									/>
									<span>{option}</span>
									@if (option === question.recommended) {
										<Tag tone="info">{t('sandbox.questions.recommended')}</Tag>
									}
								</label>
							}
							@if (question.allowFreeText) {
								<>
									<label class="ui-checkbox">
										<input
											type="radio"
											name={'answer-' + sequence + '-' + question.id}
											value=""
											checked={modeOf(question) === 'free'}
											disabled={props.busy}
											onChange={() => patch({
												mode: { ...draft.mode, [question.id]: 'free' },
											})}
										/>
										<span>{t('sandbox.questions.freeText')}</span>
									</label>
									<input
										class="ui-input"
										type="text"
										maxlength={MAX_ANSWER_LENGTH}
										aria-label={t('sandbox.questions.freeText')}
										placeholder={t('sandbox.questions.freeTextPlaceholder')}
										value={draft.typed[question.id] ?? ''}
										disabled={props.busy || modeOf(question) !== 'free'}
										onInput={(event) => patch({
											typed: {
												...draft.typed,
												[question.id]: event.currentTarget.value,
											},
										})}
									/>
								</>
							}
						</div>
					}
				</div>
				<div class="ui-field">
					<span class="ui-label">{t('sandbox.questions.note')}</span>
					<textarea
						class="ui-textarea"
						rows={2}
						placeholder={t('sandbox.questions.notePlaceholder')}
						value={draft.note}
						disabled={props.busy}
						onInput={(event) => patch({ note: event.currentTarget.value })}
					></textarea>
				</div>
				<div class="ui-form__actions">
					<Button
						size="sm"
						variant="primary"
						disabled={props.busy || !complete}
						onClick={() => props.onSubmit(
							questions.map(
								(question) => ({
									id: question.id,
									answer: answerOf(question),
								}),
							),
							draft.note.trim(),
						)}
					>
						<Icon name="check" size={14} />
						{t('sandbox.questions.submit')}
					</Button>
				</div>
			</>
		}
	</section>
}
