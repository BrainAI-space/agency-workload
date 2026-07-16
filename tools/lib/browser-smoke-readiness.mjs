export function assertReadinessMetadata(
  { contentType, finalUrl, status },
  { expectedContentType, expectedUrl },
) {
  if (status !== 200) throw new Error("Readiness response status is not exact");
  if (finalUrl !== expectedUrl) throw new Error("Readiness response final URL is not exact");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== expectedContentType) {
    throw new Error("Readiness response content type is not exact");
  }
}

export function assertExactHealthBody(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    body.status !== "ok"
  ) {
    throw new Error("Readiness health body is not exact");
  }
}
