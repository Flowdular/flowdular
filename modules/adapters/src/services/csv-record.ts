/**
 * One RFC 4180 record as `csvRecord` in `@flowdular/server` wrote it: fields
 * separated by commas, a field quoted when it carries a comma, a quotation
 * mark, a carriage return or a line feed, an embedded quotation mark doubled,
 * and the record terminated by CRLF. A list export page answers records in
 * this form, so a sink reads the cells back without a reader of its own
 * dialect.
 */
export function parseCsvRecord(record: string): string[] {
	const text = record.endsWith('\r\n') ? record.slice(0, -2) : record;
	const fields: string[] = [];
	let position = 0;
	for (;;) {
		if (text[position] === '"') {
			let value = '';
			position += 1;
			for (;;) {
				const quote = text.indexOf('"', position);
				if (quote === -1) {
					throw new Error('A quoted field of the record is never closed.');
				}
				value += text.slice(position, quote);
				if (text[quote + 1] === '"') {
					value += '"';
					position = quote + 2;
					continue;
				}
				position = quote + 1;
				break;
			}
			fields.push(value);
		} else {
			const comma = text.indexOf(',', position);
			const end = comma === -1 ? text.length : comma;
			fields.push(text.slice(position, end));
			position = end;
		}
		if (position >= text.length) break;
		if (text[position] !== ',') {
			throw new Error('A quoted field of the record is followed by text.');
		}
		position += 1;
		if (position === text.length) {
			fields.push('');
			break;
		}
	}
	return fields;
}
