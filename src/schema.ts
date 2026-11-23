type SchemaKind = {
	kind?: unknown;
	item?: SchemaKind;
	variants?: readonly SchemaKind[];
	fields?: readonly { name: string; kind: SchemaKind }[];
};

/** A table from a SurrealKit schema document (`surrealkit compile`). */
export type SurrealSchemaTable = {
	name: string;
	type?: { kind?: unknown };
	fields?: readonly { path: readonly string[]; kind?: SchemaKind }[];
};

type TerminalPaths = { records: Set<string>; texts: Set<string> };

const collectTerminalPaths = (
	kind: SchemaKind | undefined,
	path: readonly string[],
	out: TerminalPaths,
): void => {
	if (!kind) return;
	switch (kind.kind) {
		case 'record':
			out.records.add(path.join('.'));
			return;
		case 'string':
			out.texts.add(path.join('.'));
			return;
		case 'union':
			for (const variant of kind.variants ?? []) {
				collectTerminalPaths(variant, path, out);
			}
			return;
		case 'array':
		case 'set':
			collectTerminalPaths(kind.item, path, out);
			return;
		case 'objectLiteral':
			for (const field of kind.fields ?? []) {
				collectTerminalPaths(field.kind, [...path, field.name], out);
			}
			return;
	}
};

/** Reads a table's relation flag and record-link fields from SurrealKit's `tables`. */
export function schemaTableOptions(
	tables: readonly SurrealSchemaTable[],
	name: string,
): { relation: boolean; recordFields: string[] } {
	const table = tables.find((candidate) => candidate.name === name);
	if (!table) {
		throw new Error(
			`Table "${name}" is not in the provided schema tables.`,
		);
	}
	const relation = table.type?.kind === 'relation';
	const terminals: TerminalPaths = {
		records: new Set(),
		texts: new Set(),
	};
	for (const field of table.fields ?? []) {
		if (!Array.isArray(field.path)) {
			throw new Error(
				'Expected tables from a version 2 schema document (surrealkit compile).',
			);
		}
		collectTerminalPaths(field.kind, field.path, terminals);
	}
	const paths = terminals.records;
	paths.delete('id');
	if (relation) {
		paths.delete('in');
		paths.delete('out');
	}
	for (const path of paths) {
		if (terminals.texts.has(path)) {
			throw new Error(
				`${table.name}.${path} can hold both a record and a string, which string record ids cannot tell apart.`,
			);
		}
	}
	return { relation, recordFields: [...paths].sort() };
}
