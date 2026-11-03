// Flush the editor's last transaction and in-flight image imports before save/close.
const editors = new Map<() => void, string | undefined>();
const pending = new Map<Promise<unknown>, string | undefined>();
export function registerMarkdownEditor(flush: () => void, targetId?: string) {
  editors.set(flush, targetId);
  return () => { editors.delete(flush); };
}
export function trackMarkdownOperation<T>(operation: Promise<T>, targetId?: string): Promise<T> {
  pending.set(operation, targetId);
  void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  return operation;
}
export async function flushMarkdownEditors(targetId?: string) {
  const operations = [...pending].filter(([, id]) => !targetId || !id || id === targetId).map(([operation]) => operation);
  const hadPending = operations.length > 0;
  await Promise.all(operations);
  // Let the editor commit the uploaded image node after its upload promise settles.
  if (hadPending) await new Promise(resolve => setTimeout(resolve, 0));
  for (const [flush, id] of editors) if (!targetId || !id || id === targetId) flush();
}
