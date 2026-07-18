export async function withTransaction(c, fn) {
  await c.query('BEGIN');
  try {
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await c.query('ROLLBACK');
    } catch {
      // Preserve the original failure; rollback errors are secondary here.
    }
    throw error;
  }
}
