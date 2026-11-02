// Flush the editor's last transaction and in-flight image imports before save/close.
const editors = new Set<() => void>();
const pending = new Set<Promise<unknown>>();
export function registerMarkdownEditor(flush: () => void) {
  editors.add(flush);
  return () => { editors.delete(flush); };
}
export function trackMarkdownOperation<T>(operation: Promise<T>): Promise<T> {
  pending.add(operation);
  void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  return operation;
}
export async function flushMarkdownEditors() {
  const hadPending = pending.size > 0;
  await Promise.all([...pending]);
  // Let the editor commit the uploaded image node after its upload promise settles.
  if (hadPending) await new Promise(resolve => setTimeout(resolve, 0));
  for (const flush of editors) flush();
}
