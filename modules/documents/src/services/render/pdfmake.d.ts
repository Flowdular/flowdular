/* The two pdfmake 0.3.11 files the PDF renderer loads, typed where they are
   used rather than through the whole library. */
declare module 'pdfmake/build/pdfmake.js' {
	const pdfmake: unknown;
	export default pdfmake;
}

declare module 'pdfmake/build/vfs_fonts.js' {
	const fonts: unknown;
	export default fonts;
}
