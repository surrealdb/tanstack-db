import { DeleteOperationItemNotFoundError } from '@tanstack/query-db-collection';

/**
 * A LIVE DELETE can remove the row before the delete request returns, so a row
 * that is already gone is expected here.
 */
export const deleteIfPresent = (
	writeUtils: { writeDelete?: (key: string) => unknown },
	key: string,
	onError?: (error: unknown) => void,
): void => {
	void (async () => writeUtils.writeDelete?.(key))().catch((error) => {
		if (error instanceof DeleteOperationItemNotFoundError) return;
		if (!onError) throw error;
		onError(error);
	});
};
