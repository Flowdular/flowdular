import sax from 'sax';

export class XmlUnreadable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'XmlUnreadable';
	}
}

export interface XmlHandlers {
	/** Element names arrive without their namespace prefix. */
	open?(name: string, attributes: Readonly<Record<string, string>>): void;
	close?(name: string): void;
	text?(text: string): void;
}

function localName(name: string): string {
	return name.slice(name.lastIndexOf(':') + 1);
}

/** The value of a prefixed `id` attribute, which is how OOXML names a relationship. */
export function relationshipId(
	attributes: Readonly<Record<string, string>>,
): string | null {
	for (const [name, value] of Object.entries(attributes)) {
		if (name.includes(':') && localName(name) === 'id') return value;
	}
	return null;
}

function decoderFor(first: Buffer): TextDecoder {
	if (first[0] === 0xff && first[1] === 0xfe)
		return new TextDecoder('utf-16le');
	if (first[0] === 0xfe && first[1] === 0xff)
		return new TextDecoder('utf-16be');
	return new TextDecoder('utf-8');
}

/**
 * Reads one XML part as events. The parser runs in strict mode with the five
 * predefined entities only, so an entity a document declares is never
 * expanded; a document type declaration is refused outright, since no OOXML
 * part carries one and it is the only place an entity could be declared.
 * `stop` is asked after every chunk, so a reader past its bounds stops parsing.
 */
export async function readXml(
	chunks: AsyncIterable<Buffer>,
	handlers: XmlHandlers,
	stop: () => boolean,
): Promise<void> {
	const parser = sax.parser(true, {
		trim: false,
		normalize: false,
		lowercase: false,
		xmlns: false,
		position: false,
		strictEntities: true,
	} as sax.SAXOptions);
	let failure: Error | null = null;
	parser.onerror = (error) => {
		failure ??= error;
	};
	parser.ondoctype = () => {
		failure ??= new Error('A document type declaration is not read.');
	};
	parser.onopentag = (tag) => {
		handlers.open?.(
			localName(tag.name),
			tag.attributes as Readonly<Record<string, string>>,
		);
	};
	parser.onclosetag = (name) => {
		handlers.close?.(localName(name));
	};
	parser.ontext = (text) => {
		handlers.text?.(text);
	};
	parser.oncdata = (text) => {
		handlers.text?.(text);
	};
	let decoder: TextDecoder | null = null;
	const fail = (): never => {
		throw new XmlUnreadable(
			failure?.message.split('\n')[0] ?? 'Malformed XML.',
		);
	};
	try {
		for await (const chunk of chunks) {
			decoder ??= decoderFor(chunk);
			parser.write(decoder.decode(chunk, { stream: true }));
			if (failure) fail();
			if (stop()) {
				/* Text still buffered in the parser belongs to what was read. */
				parser.flush();
				return;
			}
		}
		if (decoder) parser.write(decoder.decode());
		parser.close();
	} catch (error) {
		if (error instanceof XmlUnreadable) throw error;
		failure ??= error as Error;
		fail();
	}
	if (failure) fail();
}
