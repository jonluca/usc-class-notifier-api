const paidIdPattern = /^\d{8}$/;
const paidIdAtStartOfLinePattern = /^["'“”]?\s*(\d{8})(?:\s|["'“”]|$)/;
const paidIdNoteLinePattern = /^(?:payment\s+)?(?:note|memo|code)\s*:?\s*["'“”]?\s*(\d{8})\s*["'“”]?$/i;
const nonNoteIdLabelPattern = /\b(?:transaction|transfer|confirmation|receipt|payment)\s*(?:id|number|#)\b/i;

export const isExpectedVenmoPaymentSubject = (subject: string): boolean =>
  /\bpaid\s+you\s+\$1\.00\b/i.test(subject) || /\bpaid\s+\$1\.00\s+to\s+your\s+venmo\s+account\b/i.test(subject);

export const parseVenmoPaidIds = (text: string): string[] => {
  if (!text) {
    return [];
  }

  const valid = new Set<string>();
  let previousNonEmptyLine = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const labeledNote = line.match(paidIdNoteLinePattern)?.[1];
    if (labeledNote && paidIdPattern.test(labeledNote)) {
      valid.add(labeledNote);
    } else {
      const standaloneId = line.match(paidIdAtStartOfLinePattern)?.[1];
      if (standaloneId && paidIdPattern.test(standaloneId) && !nonNoteIdLabelPattern.test(previousNonEmptyLine)) {
        valid.add(standaloneId);
      }
    }

    previousNonEmptyLine = line;
  }

  return [...valid];
};
