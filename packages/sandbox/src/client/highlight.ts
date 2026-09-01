export interface Token {
	/* Position in the line, so a rendered token has a stable key. */
	readonly id: number;
	readonly text: string;
	readonly kind: 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'type';
}

const KEYWORDS = new Set([
	'import',
	'export',
	'from',
	'const',
	'let',
	'var',
	'function',
	'return',
	'if',
	'else',
	'for',
	'of',
	'in',
	'while',
	'class',
	'extends',
	'implements',
	'interface',
	'type',
	'enum',
	'new',
	'await',
	'async',
	'try',
	'catch',
	'finally',
	'throw',
	'typeof',
	'instanceof',
	'readonly',
	'public',
	'private',
	'protected',
	'static',
	'true',
	'false',
	'null',
	'undefined',
	'this',
	'super',
	'as',
	'satisfies',
	'default',
	'CREATE',
	'TABLE',
	'SELECT',
	'INSERT',
	'UPDATE',
	'DELETE',
	'FROM',
	'WHERE',
	'INDEX',
	'NOT',
	'NULL',
	'PRIMARY',
	'KEY',
	'REFERENCES',
]);

const PATTERN =
	/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g;

/* A deliberately small highlighter: the sandbox diff shows TypeScript, TSRX,
   JSON, YAML, CSS, and SQL, and a dependency-free tokenizer keeps the preview
   free of third-party runtime code. */
export function tokenize(line: string): readonly Token[] {
	const tokens: Token[] = [];
	const push = (value: string, kind: Token['kind']) => {
		tokens.push({ id: tokens.length, text: value, kind });
	};
	let lastIndex = 0;
	PATTERN.lastIndex = 0;
	for (;;) {
		const match = PATTERN.exec(line);
		if (!match) break;
		if (match.index > lastIndex) {
			push(line.slice(lastIndex, match.index), 'plain');
		}
		const [value, comment, string, number, word] = match;
		if (comment) push(value, 'comment');
		else if (string) push(value, 'string');
		else if (number) push(value, 'number');
		else if (word) {
			push(
				value,
				KEYWORDS.has(word) ? 'keyword' : /^[A-Z]/.test(word) ? 'type' : 'plain',
			);
		}
		lastIndex = match.index + value.length;
	}
	if (lastIndex < line.length) push(line.slice(lastIndex), 'plain');
	return tokens;
}

export function tokenClass(kind: Token['kind']): string {
	return kind === 'plain' ? '' : `tok-${kind}`;
}
