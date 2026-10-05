/* The adapter sets flowdular.tenant_id and nothing else, and only the
   flowdular_* roles exist. A policy on another setting sees no tenant (reads
   come back empty, every write fails its check), and a script that names
   another role fails when applied. These rules read the SQL alone, so module
   validation and the sandbox gate apply them without a database.

   Comments are skipped and string literals are data, except a dollar-quoted
   body or a string right after EXECUTE: those are read as SQL, because DO
   blocks and functions put role grants there. A setting or role named at run
   time is not read. */

export interface MigrationIdentifierIssue {
	readonly code: 'TENANT_SETTING_UNKNOWN' | 'ROLE_UNKNOWN';
	readonly message: string;
}

type SqlToken =
	/* Unquoted words are case-folded the way PostgreSQL folds them. */
	| { readonly kind: 'word'; readonly text: string }
	| { readonly kind: 'name'; readonly text: string }
	| { readonly kind: 'string'; readonly text: string; readonly code: boolean }
	| { readonly kind: 'symbol'; readonly text: string };

const TENANT_SETTING = 'flowdular.tenant_id';
const ROLE_SHAPE = /^([a-z][a-z0-9]*)_(runtime|background|migrator)$/;
const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
/* Bodies nest rarely and shallowly; the bound keeps a hostile script linear. */
const MAX_NESTING = 3;
const LIST_NOISE = new Set(['group', 'if', 'exists']);

function blockCommentEnd(sql: string, start: number): number {
	let depth = 0;
	let index = start;
	while (index < sql.length) {
		if (sql.startsWith('/*', index)) {
			depth += 1;
			index += 2;
		} else if (sql.startsWith('*/', index)) {
			depth -= 1;
			index += 2;
			if (depth === 0) return index;
		} else index += 1;
	}
	return sql.length;
}

function quoted(
	sql: string,
	start: number,
	quote: string,
	backslashEscapes: boolean,
): { readonly text: string; readonly end: number } {
	let text = '';
	let index = start + 1;
	while (index < sql.length) {
		const char = sql[index]!;
		if (backslashEscapes && char === '\\') {
			text += sql[index + 1] ?? '';
			index += 2;
		} else if (char !== quote) {
			text += char;
			index += 1;
		} else if (sql[index + 1] === quote) {
			text += quote;
			index += 2;
		} else return { text, end: index + 1 };
	}
	return { text, end: sql.length };
}

function tokenize(sql: string): SqlToken[] {
	const tokens: SqlToken[] = [];
	let index = 0;
	while (index < sql.length) {
		const char = sql[index]!;
		const next = sql[index + 1];
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (char === '-' && next === '-') {
			const end = sql.indexOf('\n', index);
			index = end < 0 ? sql.length : end + 1;
			continue;
		}
		if (char === '/' && next === '*') {
			index = blockCommentEnd(sql, index);
			continue;
		}
		if (char === "'" || ((char === 'E' || char === 'e') && next === "'")) {
			const escaped = char !== "'";
			const literal = quoted(sql, escaped ? index + 1 : index, "'", escaped);
			tokens.push({ kind: 'string', text: literal.text, code: false });
			index = literal.end;
			continue;
		}
		if (char === '"') {
			const identifier = quoted(sql, index, '"', false);
			tokens.push({ kind: 'name', text: identifier.text });
			index = identifier.end;
			continue;
		}
		DOLLAR_TAG.lastIndex = index;
		const tag = DOLLAR_TAG.exec(sql)?.[0];
		if (tag) {
			const close = sql.indexOf(tag, index + tag.length);
			const end = close < 0 ? sql.length : close;
			tokens.push({
				kind: 'string',
				text: sql.slice(index + tag.length, end),
				code: true,
			});
			index = close < 0 ? sql.length : close + tag.length;
			continue;
		}
		WORD.lastIndex = index;
		const word = WORD.exec(sql)?.[0];
		if (word) {
			tokens.push({ kind: 'word', text: word.toLowerCase() });
			index += word.length;
			continue;
		}
		tokens.push({ kind: 'symbol', text: char });
		index += 1;
	}
	return tokens;
}

function isWord(token: SqlToken | undefined, text: string): boolean {
	return token?.kind === 'word' && token.text === text;
}

function isSymbol(token: SqlToken | undefined, text: string): boolean {
	return token?.kind === 'symbol' && token.text === text;
}

/* The script and every body inside it that PostgreSQL runs as SQL. */
function codeLevels(sql: string, depth = 0): SqlToken[][] {
	const tokens = tokenize(sql);
	const levels = [tokens];
	if (depth >= MAX_NESTING) return levels;
	tokens.forEach((token, index) => {
		if (
			token.kind === 'string' &&
			(token.code || isWord(tokens[index - 1], 'execute'))
		)
			levels.push(...codeLevels(token.text, depth + 1));
	});
	return levels;
}

function statementsOf(tokens: readonly SqlToken[]): SqlToken[][] {
	const statements: SqlToken[][] = [[]];
	for (const token of tokens) {
		if (isSymbol(token, ';')) statements.push([]);
		else statements.at(-1)!.push(token);
	}
	return statements;
}

function indexOfWord(
	statement: readonly SqlToken[],
	text: string,
	from: number,
): number {
	for (let index = from; index < statement.length; index += 1)
		if (isWord(statement[index], text)) return index;
	return -1;
}

/* A comma-separated identifier list after any leading noise words, and the
   index just past it. */
function namesAt(
	statement: readonly SqlToken[],
	start: number,
): { readonly names: readonly string[]; readonly end: number } {
	let index = start;
	while (
		statement[index]?.kind === 'word' &&
		LIST_NOISE.has(statement[index]!.text)
	)
		index += 1;
	const names: string[] = [];
	for (;;) {
		const token = statement[index];
		if (token?.kind !== 'word' && token?.kind !== 'name')
			return { names, end: index };
		names.push(token.text);
		if (!isSymbol(statement[index + 1], ',')) return { names, end: index + 1 };
		index += 2;
	}
}

/* Grant, revoke, policy and owner lists, SET ROLE and its relatives, session
   authorization, and role membership. RENAME ... TO names the new name of the
   object being renamed, never a role. */
function roleNames(statement: readonly SqlToken[]): string[] {
	const names: string[] = [];
	const renamed = indexOfWord(statement, 'rename', 0);
	for (let index = 0; index < statement.length; index += 1) {
		const token = statement[index]!;
		if (token.kind !== 'word') continue;
		const listed =
			token.text === 'role' ||
			token.text === 'authorization' ||
			(token.text === 'to' && (renamed < 0 || renamed > index));
		if (!listed) continue;
		const list = namesAt(statement, index + 1);
		names.push(...list.names);
		index = Math.max(index, list.end - 1);
	}
	const command = statement.findIndex(
		(token) => isWord(token, 'grant') || isWord(token, 'revoke'),
	);
	if (command < 0) return names;
	const revoke = isWord(statement[command], 'revoke');
	const target = indexOfWord(statement, revoke ? 'from' : 'to', command + 1);
	if (target < 0) return names;
	if (revoke) names.push(...namesAt(statement, target + 1).names);
	/* Without ON the statement grants or revokes membership, so the names
	   before TO or FROM are roles as well. */
	const on = indexOfWord(statement, 'on', command + 1);
	if (on < 0 || on > target)
		for (const entry of statement.slice(command + 1, target))
			if (entry.kind === 'word' || entry.kind === 'name')
				names.push(entry.text);
	return names;
}

/* rolname = 'name' and rolname IN ('a', 'b'): the pg_roles lookups a script
   makes before it grants. */
function rolnameLiterals(tokens: readonly SqlToken[]): string[] {
	const names: string[] = [];
	tokens.forEach((token, index) => {
		if (!isWord(token, 'rolname')) return;
		if (isSymbol(tokens[index + 1], '=')) {
			const value = tokens[index + 2];
			if (value?.kind === 'string') names.push(value.text);
			return;
		}
		if (!isWord(tokens[index + 1], 'in') || !isSymbol(tokens[index + 2], '('))
			return;
		for (let cursor = index + 3; cursor < tokens.length; cursor += 2) {
			const value = tokens[cursor];
			if (value?.kind !== 'string') return;
			names.push(value.text);
			if (!isSymbol(tokens[cursor + 1], ',')) return;
		}
	});
	return names;
}

/* Any current_setting('<name>' and any literal shaped like '<prefix>.tenant_id'
   other than the adapter's setting. Setting names ignore case. */
function tenantSettings(tokens: readonly SqlToken[]): string[] {
	const settings: string[] = [];
	tokens.forEach((token, index) => {
		const argument = tokens[index + 2];
		if (
			isWord(token, 'current_setting') &&
			isSymbol(tokens[index + 1], '(') &&
			argument?.kind === 'string'
		)
			settings.push(argument.text);
		else if (
			token.kind === 'string' &&
			/^[a-z0-9_]+\.tenant_id$/i.test(token.text)
		)
			settings.push(token.text);
	});
	return settings.filter((setting) => setting.toLowerCase() !== TENANT_SETTING);
}

export function migrationIdentifierIssues(
	sql: string,
): readonly MigrationIdentifierIssue[] {
	const settings = new Set<string>();
	const roles = new Set<string>();
	for (const tokens of codeLevels(sql)) {
		for (const setting of tenantSettings(tokens)) settings.add(setting);
		for (const name of rolnameLiterals(tokens)) roles.add(name);
		for (const statement of statementsOf(tokens))
			for (const name of roleNames(statement)) roles.add(name);
	}
	const issues: MigrationIdentifierIssue[] = [];
	for (const setting of settings)
		issues.push({
			code: 'TENANT_SETTING_UNKNOWN',
			message: `"${setting}" is never set; tenant policies read current_setting('${TENANT_SETTING}', true).`,
		});
	for (const name of roles) {
		const role = ROLE_SHAPE.exec(name.toLowerCase());
		if (!role || name === `flowdular_${role[2]}`) continue;
		issues.push({
			code: 'ROLE_UNKNOWN',
			message: `Role "${name}" does not exist; use flowdular_${role[2]}.`,
		});
	}
	return issues;
}
