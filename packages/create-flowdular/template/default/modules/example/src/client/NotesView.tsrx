import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	FormField,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
	type TableColumn,
} from '@flowdular/sdk/ui';
import { activeLocale, t } from '@flowdular/sdk/client';
import { useValue } from 'segment-state';
import type { Note } from '../domain/types.ts';
import { createNote, loadNotes } from './api.ts';
import { createExampleClientState } from './state.ts';

export interface NotesViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function columns(): readonly TableColumn<Note>[] {
	return [
		{
			key: 'note',
			header: t('example.table.column.note'),
			width: '70%',
			cell: (note) => <span class="ui-cell">
				<b>{note.title}</b>
				<span class="ui-cell__muted">{note.body}</span>
			</span>,
		},
		{
			key: 'created',
			header: t('example.table.column.created'),
			width: '30%',
			cell: (note) => new Intl.DateTimeFormat(activeLocale(), {
				dateStyle: 'medium',
				timeStyle: 'short',
			}).format(new Date(note.createdAt)),
		},
	];
}

export function NotesView(props: NotesViewProps) @{
	const exampleState = useMemo(() => createExampleClientState(), []);
	const [notes] = useValue(exampleState.state.notes);
	const [status, setStatus] = useValue(exampleState.state.status);
	const [error, setError] = useValue(exampleState.state.error);
	const [query, setQuery] = useValue(exampleState.state.query);
	const [formOpen, setFormOpen] = useValue(exampleState.state.formOpen);
	const [formSession, setFormSession] = useValue(
		exampleState.state.formSession,
	);
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible = notes.filter(
		(note) =>
			term === '' || note.title.toLocaleLowerCase(locale).includes(term),
	);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const records = await loadNotes();
			exampleState.store.act(
				(transaction) => transaction.set(exampleState.state.notes, records),
				'example/loaded',
			);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('example.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const openForm = () => {
		setError('');
		setFormSession((current) => current + 1);
		setFormOpen(true);
	};

	const closeForm = () => {
		setFormOpen(false);
		setError('');
	};

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		setStatus('submitting');
		setError('');
		try {
			const note = await createNote(
				{ title: formValue(form, 'title'), body: formValue(form, 'body') },
				props.csrfToken,
			);
			exampleState.store.act(
				(transaction) => transaction.set(exampleState.state.notes, [
					note,
					...notes,
				]),
				'example/created',
			);
			closeForm();
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t('example.error.create'),
			);
		} finally {
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('example.page.eyebrow')}
			title={t('example.page.title')}
			description={t('example.page.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('example.page.action.refresh')}
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={openForm}>
					<Icon name="plus" size={14} />
					{t('example.page.action.new')}
				</Button>
			}
		</PageHeader>
		@if (error && !formOpen) {
			<Alert>{error}</Alert>
		}
		<TableCard
			title={t('example.table.title')}
			count={t(
				notes.length === 1
					? 'example.table.count.one'
					: 'example.table.count.other',
				{ count: notes.length },
			)}
			search={<SearchField
				value={query}
				placeholder={t('example.table.search.placeholder')}
				label={t('example.table.search.label')}
				onInput={setQuery}
			/>}
			caption={t('example.table.caption')}
			columns={columns()}
			rows={visible}
			rowKey={(note) => note.id}
			status={status === 'loading' && notes.length === 0 ? 'loading' : 'idle'}
			loadingLabel={t('example.table.loading')}
			filtered={term !== ''}
			empty={{
				icon: 'file-text',
				title: t('example.table.empty.title'),
				hint: t('example.table.empty.hint'),
			}}
			emptyFiltered={{
				icon: 'file-text',
				title: t('example.table.emptyFiltered.title'),
				hint: t('example.table.emptyFiltered.hint'),
			}}
			note={t('example.table.note')}
		/>
		<Drawer
			open={formOpen}
			title={t('example.drawer.title')}
			subtitle={t('example.drawer.subtitle')}
			onClose={closeForm}
		>
			<form
				class="ui-drawer__form"
				key={'example-form-' + formSession}
				onSubmit={submit}
			>
				<div class="ui-drawer__body">
					@if (error) {
						<Alert>{error}</Alert>
					}
					<FormField label={t('example.field.title')}>
						<input
							class="ui-input"
							id="title"
							name="title"
							required
							maxLength={120}
						/>
					</FormField>
					<FormField
						label={t('example.field.body')}
						help={t('example.field.body.help')}
					>
						<textarea
							class="ui-textarea"
							id="body"
							required
							rows={6}
							maxLength={4000}
						></textarea>
					</FormField>
				</div>
				<div class="ui-drawer__foot">
					<Button type="button" onClick={closeForm}>{t(
						'example.drawer.cancel',
					)}</Button>
					<Button
						type="submit"
						variant="primary"
						disabled={status === 'submitting'}
					>{t('example.drawer.save')}</Button>
				</div>
			</form>
		</Drawer>
	</div>
}
