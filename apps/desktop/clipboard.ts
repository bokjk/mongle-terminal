interface TextClipboard {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

/** Electron can resolve writeText even when Windows refuses clipboard access. */
export function createVerifiedClipboardWriter(clipboard: TextClipboard) {
  let pending: Promise<void> = Promise.resolve();
  return (text: string): Promise<void> => {
    // Keep our own copies from overtaking another copy's read-back check.
    const result = pending.then(async () => {
      await clipboard.writeText(text);
      const actual = await clipboard.readText();
      if (actual !== text) throw new Error('클립보드에 내용을 저장하지 못했습니다.');
    });
    // A failed copy must not prevent the next user-initiated attempt.
    pending = result.catch(() => {});
    return result;
  };
}
