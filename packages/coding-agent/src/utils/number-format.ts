const LOCALE_INTEGER_FORMATTER = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0,
});

export function formatLocaleInteger(value: number): string {
	return LOCALE_INTEGER_FORMATTER.format(value);
}
