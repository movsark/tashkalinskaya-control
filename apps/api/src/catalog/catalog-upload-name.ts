export function normalizeUploadFileName(originalName: string): string {
  let decoded = originalName;
  if (/[\u00c3\u00d0\u00d1]/u.test(originalName)) {
    const utf8Candidate = Buffer.from(originalName, "latin1").toString("utf8");
    if (!utf8Candidate.includes("\uFFFD")) decoded = utf8Candidate;
  }
  return decoded.normalize("NFC");
}
