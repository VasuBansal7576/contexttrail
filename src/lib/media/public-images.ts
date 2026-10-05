/** Reviewed, already-public media. No arbitrary URL or private-file publication. */
export const PUBLIC_IMAGES = {
  "nasa-earthrise": {
    title: "Earthrise · Apollo 8",
    url: "https://www.nasa.gov/wp-content/uploads/2024/06/as08-14-2383orig.jpg",
    previewUrl: "/illustrative-earthrise.jpg",
    sourceUrl: "https://www.nasa.gov/image-article/earthrise-by-nasa-astronaut-bill-anders/",
    credit: "NASA / Bill Anders · 24 Dec 1968 · No NASA endorsement",
  },
} as const;
export type PublicImageId = keyof typeof PUBLIC_IMAGES;
export function isPublicImageId(value: unknown): value is PublicImageId {
  return typeof value === "string" && Object.hasOwn(PUBLIC_IMAGES, value);
}

/** Format check only. Public DNS, redirects, MIME type and size remain server checks. */
export function publicImageUrlFormatError(raw: string): string | null {
  const message = "Use an already-public HTTPS image URL without login, tokens, query parameters or a custom port.";
  try {
    const url = new URL(raw);
    return raw.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.port ? message : null;
  } catch { return message; }
}
