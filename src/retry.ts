export async function retryOnce<T>(fn: () => Promise<T>, delayMs: number): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn();
  }
}
